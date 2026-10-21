import Darwin
import Foundation

/// What Claude Code has of CUA, as the app read it from the files (never by starting a server).
struct ClaudeSetupState: Equatable, Sendable {
    enum Part: Equatable, Sendable {
        /// Not looked at, or the file cannot be read: the app says nothing.
        case unknown
        case missing
        case ready
        /// The app's own, but not what this app version installs.
        case outdated
        /// Not the app's: it is left alone and told as a conflict.
        case conflict
    }

    /// The `claude` command was found. Without it MCP and skill are put off, and nothing is said about them.
    var claudeCodeFound = false
    /// The `claude` that was found could not start (exit 127: an npm-installed one with no `node` it can find). The
    /// card says nothing about MCP and skill then, the same as without Claude Code; the check tab says why.
    var claudeCodeUnusable = false
    var mcp: Part = .unknown
    var skill: Part = .unknown
    /// The old plugin `cua@chenjing-plugins` is still recorded: two CUAs would attach to a new conversation.
    var legacyPlugin = false

    static let none = ClaudeSetupState()
}

/// The old cua plugin. The app never removes it: it tells, and gives the command to run.
enum LegacyPlugin {
    static let id = "cua@chenjing-plugins"
    static let notice = "옛 cua 플러그인이 남아 있어요 — CUA가 둘 붙어요"
    static let removeCommand = "claude plugin uninstall cua@chenjing-plugins --scope user"
}

/// The app's way into Claude Code: the `cua` MCP server in `~/.claude.json` and the `cua` skill in
/// `~/.claude/skills/cua/`.
///
/// The MCP server is changed only with `claude mcp add -s user` and `claude mcp remove -s user`, and read
/// from the file (`claude mcp list` and `get` start the servers). The skill is two files the app writes: the
/// skill itself and `.cua-bar.json`, the mark that says the app put it there. What the app did not put there
/// is never changed or removed.
struct ClaudeIntegration: Sendable, ClaudeRemoving {
    static let serverName = "cua"
    static let markerName = ".cua-bar.json"

    var home: URL
    var claude: ClaudeCLILocator
    var runner: any ProcessRunning
    /// One `claude mcp …` command.
    var commandTimeout: Duration
    /// What was last read of `~/.claude.json`. The file can be large and is read at every status read; it is
    /// parsed again only when it changed. A copy of this struct shares it.
    private let configCache = ConfigCache()

    init(
        home: URL = FileManager.default.homeDirectoryForCurrentUser, claude: ClaudeCLILocator? = nil,
        runner: any ProcessRunning = SystemProcessRunner(), commandTimeout: Duration = .seconds(120)
    ) {
        self.home = home
        self.claude = claude ?? ClaudeCLILocator(home: home)
        self.runner = runner
        self.commandTimeout = commandTimeout
    }

    /// The `claude` command is installed.
    var claudeCodeFound: Bool { claude.locate() != nil }

    var configURL: URL { home.appendingPathComponent(".claude.json") }
    var skillFolder: URL { home.appendingPathComponent(".claude/skills/cua", isDirectory: true) }
    var legacyRegistryURL: URL { home.appendingPathComponent(".claude/plugins/installed_plugins.json") }

    /// Where the app's engine copies are; a server command under it is the app's.
    private var engineCopies: URL { home.appendingPathComponent(".local/share/codex-cua/engine", isDirectory: true) }

    // MARK: Reading

    /// Everything the card and the check need, from files only. `launcher` is the one the engine reported
    /// (status or install result); the MCP command is compared with it.
    func inspect(launcher: String?, skillSource: URL?, appVersion: String?) -> ClaudeSetupState {
        ClaudeSetupState(
            claudeCodeFound: claudeCodeFound,
            mcp: mcpState(launcher: launcher),
            skill: skillState(source: skillSource, appVersion: appVersion),
            legacyPlugin: legacyPluginRecorded())
    }

    /// The launcher of the engine's current version: one path whatever the version, because `current` is a link
    /// the engine moves. What the engine did not say is this.
    var defaultLauncher: String {
        home.appendingPathComponent(".local/share/codex-cua/engine/current/start-mcp.sh").path
    }

    /// The start script behind `current` is there (a link is followed: a dangling one is not there).
    var defaultLauncherExists: Bool { FileManager.default.fileExists(atPath: defaultLauncher) }

    /// What `mcpServers.cua` at the top of `~/.claude.json` is, compared with what the app installs: the
    /// launcher the engine reported, else `defaultLauncher`, with no arguments.
    func mcpState(launcher: String?) -> ClaudeSetupState.Part {
        switch mcpEntry() {
        case .unreadable: return .unknown
        case .absent: return .missing
        case .server(let command, let hasArguments):
            guard let command, isAppOwned(command) else { return .conflict }
            guard !hasArguments else { return .outdated }
            return command == expectedLauncher(launcher) ? .ready : .outdated
        }
    }

    /// What `claude mcp add` is given.
    func expectedLauncher(_ reported: String?) -> String {
        guard let reported, reported.hasPrefix("/") else { return defaultLauncher }
        return reported
    }

    private enum McpEntry {
        case unreadable
        case absent
        case server(command: String?, hasArguments: Bool)
    }

    /// Which version of a file this is: when it was last written (and changed), how big it is, and which file it is
    /// (a write that replaces the file gives it a new number). All of it is the same: the file is the same.
    private struct FileSignature: Equatable {
        var modified: timespec
        var changed: timespec
        var size: off_t
        var inode: ino_t

        init?(path: String) {
            var info = stat()
            guard stat(path, &info) == 0 else { return nil }
            modified = info.st_mtimespec
            changed = info.st_ctimespec
            size = info.st_size
            inode = info.st_ino
        }

        static func == (lhs: FileSignature, rhs: FileSignature) -> Bool {
            lhs.modified.tv_sec == rhs.modified.tv_sec && lhs.modified.tv_nsec == rhs.modified.tv_nsec
                && lhs.changed.tv_sec == rhs.changed.tv_sec && lhs.changed.tv_nsec == rhs.changed.tv_nsec
                && lhs.size == rhs.size && lhs.inode == rhs.inode
        }
    }

    private final class ConfigCache: @unchecked Sendable {
        private let lock = NSLock()
        private var signature: FileSignature?
        private var entry: McpEntry?
        private var parsed = 0

        func lookup(_ signature: FileSignature) -> McpEntry? {
            lock.withLock { self.signature == signature ? entry : nil }
        }

        func store(_ entry: McpEntry, for signature: FileSignature) {
            lock.withLock {
                self.signature = signature
                self.entry = entry
                parsed += 1
            }
        }

        var parseCount: Int { lock.withLock { parsed } }
    }

    /// How many times `~/.claude.json` was parsed. For tests.
    var configParseCount: Int { configCache.parseCount }

    private func mcpEntry() -> McpEntry {
        guard let signature = FileSignature(path: configURL.path) else {
            return FileManager.default.fileExists(atPath: configURL.path) ? .unreadable : .absent
        }
        if let known = configCache.lookup(signature) { return known }
        let entry = parseMcpEntry()
        // A file that changed while it was read is looked at again next time.
        if FileSignature(path: configURL.path) == signature { configCache.store(entry, for: signature) }
        return entry
    }

    private func parseMcpEntry() -> McpEntry {
        guard
            let data = try? Data(contentsOf: configURL),
            let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return .unreadable }
        guard let servers = root["mcpServers"] else { return .absent }
        guard let table = servers as? [String: Any] else { return .unreadable }
        guard let entry = table[Self.serverName] else { return .absent }
        guard let server = entry as? [String: Any] else { return .server(command: nil, hasArguments: false) }
        return .server(command: server["command"] as? String, hasArguments: !((server["args"] as? [Any]) ?? []).isEmpty)
    }

    /// A command under the folder the app puts its engine copies in. The folder is looked at as written and
    /// with its links followed, because the engine names the real path.
    private func isAppOwned(_ command: String) -> Bool {
        let literal = engineCopies.path + "/"
        let resolved = engineCopies.resolvingSymlinksInPath().path + "/"
        return command.hasPrefix(literal) || command.hasPrefix(resolved)
    }

    /// The skill folder: ours when it is a real folder with the app's mark; ready when the mark names this
    /// app's version and the skill is the bundled one.
    func skillState(source: URL?, appVersion: String?) -> ClaudeSetupState.Part {
        var info = stat()
        guard lstat(skillFolder.path, &info) == 0 else { return .missing }
        // A link or a file named like the folder is somebody else's.
        guard (info.st_mode & S_IFMT) == S_IFDIR else { return .conflict }
        let marker = skillFolder.appendingPathComponent(Self.markerName)
        guard FileManager.default.fileExists(atPath: marker.path) else { return .conflict }
        let markedVersion = (try? Data(contentsOf: marker))
            .flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
            .flatMap { $0["version"] as? String }
        let skill = skillFolder.appendingPathComponent("SKILL.md")
        guard let installed = try? Data(contentsOf: skill) else { return .outdated }
        if let appVersion, markedVersion != appVersion { return .outdated }
        if let source, (try? Data(contentsOf: source)) != installed { return .outdated }
        return .ready
    }

    func legacyPluginRecorded() -> Bool {
        guard
            let data = try? Data(contentsOf: legacyRegistryURL),
            let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let plugins = root["plugins"] as? [String: Any],
            let records = plugins[LegacyPlugin.id] as? [Any]
        else { return false }
        return !records.isEmpty
    }

    // MARK: Changing

    /// How one `claude` command ended.
    enum CommandResult: Equatable, Sendable {
        case succeeded
        case failed
        /// It could not start: no `claude`, or exit 127 (the `node` an npm-installed one needs was not found).
        case cannotStart
    }

    /// `claude mcp add -s user cua -- <command>`.
    func addMCP(command: String) async -> CommandResult {
        await runClaude(["mcp", "add", "-s", "user", Self.serverName, "--", command])
    }

    /// `claude mcp remove -s user cua`.
    func removeMCP() async -> CommandResult {
        await runClaude(["mcp", "remove", "-s", "user", Self.serverName])
    }

    /// Exit code of `/usr/bin/env` when the interpreter of a script (here `node`) cannot be found.
    static let cannotStartExitCode: Int32 = 127

    /// The folder of the `claude` found goes first in PATH: npm, nvm and bun put a script there that runs the
    /// `node` beside it.
    private func runClaude(_ arguments: [String]) async -> CommandResult {
        guard let cli = claude.locate() else { return .cannotStart }
        do {
            let output = try await runner.run(
                cli, arguments: arguments, timeout: commandTimeout, pathFirst: [cli.deletingLastPathComponent().path])
            switch output.exitCode {
            case 0: return .succeeded
            case Self.cannotStartExitCode: return .cannotStart
            default: return .failed
            }
        } catch ProcessRunError.launchFailed {
            return .cannotStart
        } catch {
            return .failed
        }
    }

    /// The mark first, then the skill: a stop halfway leaves a marked folder the next run repairs, never an
    /// unmarked one that would read as somebody else's.
    func installSkill(from source: URL, version: String) -> Bool {
        do {
            try FileManager.default.createDirectory(at: skillFolder, withIntermediateDirectories: true)
            let mark = try JSONSerialization.data(withJSONObject: ["version": version], options: [.sortedKeys])
            try mark.write(to: skillFolder.appendingPathComponent(Self.markerName), options: .atomic)
            try Data(contentsOf: source).write(to: skillFolder.appendingPathComponent("SKILL.md"), options: .atomic)
            return true
        } catch {
            return false
        }
    }

    struct Removal: Equatable, Sendable {
        /// The app's MCP entry may still be there: Claude Code could not take it away, or its file cannot be
        /// read, so nobody can tell. The person is given Claude Code's own command.
        var mcpStays = false
        /// Something of the app's was taken out of Claude Code.
        var removedAnything = false
    }

    /// Takes away what the app put into Claude Code, in this order: the MCP server (only when its command is
    /// the app's), then the skill folder (only with the app's mark). Anything else is left as it is.
    func removeAppOwned() async -> Removal {
        var removal = Removal()
        switch mcpEntry() {
        case .unreadable:
            removal.mcpStays = true
        case .server(let command?, _) where isAppOwned(command):
            _ = await removeMCP()
            switch mcpEntry() {
            case .server(let after?, _) where isAppOwned(after): removal.mcpStays = true
            case .unreadable: removal.mcpStays = true
            default: removal.removedAnything = true
            }
        case .server, .absent:
            break
        }
        // Marked folders only: `missing` has nothing to take away and `conflict` is somebody else's.
        switch skillState(source: nil, appVersion: nil) {
        case .ready, .outdated:
            if (try? FileManager.default.removeItem(at: skillFolder)) != nil { removal.removedAnything = true }
        case .missing, .conflict, .unknown:
            break
        }
        return removal
    }
}

/// What the remove action asks of Claude Code: take away what the app put there, nothing else.
protocol ClaudeRemoving: Sendable {
    func removeAppOwned() async -> ClaudeIntegration.Removal
}

/// For tests and previews, where Claude Code's files are not to be touched.
struct NoClaudeRemoval: ClaudeRemoving {
    func removeAppOwned() async -> ClaudeIntegration.Removal { ClaudeIntegration.Removal() }
}
