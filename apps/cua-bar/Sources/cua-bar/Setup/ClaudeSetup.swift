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
    /// Where it was found (the check tab names it when it cannot start).
    var claudeCodePath: String?
    /// The `claude` that was found could not start (exit 127: an npm-installed one with no `node` it can find). The
    /// card says nothing about MCP and skill then, the same as without Claude Code; the check tab says why.
    var claudeCodeUnusable = false
    var mcp: Part = .unknown
    var skill: Part = .unknown
    /// The old plugins (`LegacyPlugin.ids`) still recorded: two CUAs would attach to a new conversation.
    var legacyPlugins: [String] = []
    /// What 0.8.0 installed under the old name `cua` is still there: its MCP server (it runs the app's engine) and its
    /// skill (with the app's mark) (F9).
    var oldServer = false
    var oldSkill = false
    /// What Claude Code's settings say of CUA's tools; nil when not looked at (F9).
    var permissions: PermissionReading?

    static let none = ClaudeSetupState()

    var legacyPlugin: Bool { !legacyPlugins.isEmpty }

    /// Something of CUA's old names is left in Claude Code (F9): told after an update, and on the 점검 tab.
    var hasOldNames: Bool { legacyPlugin || oldServer || oldSkill || permissions?.hasOldNames == true }
}

/// The old cua plugins. The app never removes them: it tells, and gives the command to run.
enum LegacyPlugin {
    /// The public marketplace's, then the company marketplace's copy of it (taken off its list on 2026-10-26).
    static let ids = ["cua@chenjing-plugins", "cua@ubion"]
    static let id = ids[0]
    static let notice = "옛 cua 플러그인이 남아 있어요 — CUA가 둘 붙어요"
    static let removeCommand = uninstallCommand(for: id)

    static func uninstallCommand(for id: String) -> String { "claude plugin uninstall \(id) --scope user" }
}

/// What 0.8.0 installed under the name `cua`, and the commands that take it away. The app never does (F9).
enum OldName {
    /// The server's name in `mcpServers` of `~/.claude.json`.
    static let serverKey = "cua"
    static let serverNotice = "0.8.0이 깐 옛 이름 cua MCP가 남아 있어요 — CUA가 둘 붙어요"
    static let removeServerCommand = "claude mcp remove -s user cua"
    static let skillNotice = "0.8.0이 깐 옛 이름 cua 스킬이 남아 있어요 — 스킬이 둘 보여요"
    static let removeSkillCommand = "rm -rf ~/.claude/skills/cua"
}

/// The app's way into Claude Code: the `cuabar` MCP server in `~/.claude.json` and the `cuabar` skill in
/// `~/.claude/skills/cuabar/`.
///
/// The MCP server is changed only with `claude mcp add -s user` and `claude mcp remove -s user`, and read
/// from the file (`claude mcp list` and `get` start the servers). The skill is two files the app writes: the
/// skill itself and `.cua-bar.json`, the mark that says the app put it there. What the app did not put there
/// is never changed or removed.
struct ClaudeIntegration: Sendable, ClaudeRemoving {
    static let serverName = "cuabar"
    static let markerName = ".cua-bar.json"

    var home: URL
    var claude: ClaudeCLILocator
    var runner: any ProcessRunning
    /// One `claude mcp …` command.
    var commandTimeout: Duration
    /// How long the look at the project folders' settings files is kept (R25).
    var folderRescan: TimeInterval
    /// What was last read of `~/.claude.json`. The file can be large and is read at every status read; it is
    /// parsed again only when it changed. A copy of this struct shares it.
    private let configCache = ConfigCache()
    private let folderCache = FolderScanCache()

    init(
        home: URL = FileManager.default.homeDirectoryForCurrentUser, claude: ClaudeCLILocator? = nil,
        runner: any ProcessRunning = SystemProcessRunner(), commandTimeout: Duration = .seconds(120),
        folderRescan: TimeInterval = 60
    ) {
        self.home = home
        self.claude = claude ?? ClaudeCLILocator(home: home)
        self.runner = runner
        self.commandTimeout = commandTimeout
        self.folderRescan = folderRescan
    }

    /// The `claude` command is installed.
    var claudeCodeFound: Bool { claude.locate() != nil }

    var configURL: URL { home.appendingPathComponent(".claude.json") }
    var skillFolder: URL { home.appendingPathComponent(".claude/skills/cuabar", isDirectory: true) }
    /// Where 0.8.0 put the skill, under the old name.
    var oldSkillFolder: URL { home.appendingPathComponent(".claude/skills/cua", isDirectory: true) }
    var legacyRegistryURL: URL { home.appendingPathComponent(".claude/plugins/installed_plugins.json") }
    var userSettingsURL: URL { home.appendingPathComponent(".claude/settings.json") }

    /// Where the app's engine copies are; a server command under it is the app's.
    private var engineCopies: URL { home.appendingPathComponent(".local/share/codex-cua/engine", isDirectory: true) }

    // MARK: Reading

    /// Everything the card and the check need, from files only. `launcher` is the one the engine reported
    /// (status or install result); the MCP command is compared with it.
    func inspect(launcher: String?, skillSource: URL?, appVersion: String?) -> ClaudeSetupState {
        let found = claude.locate()
        var state = leftovers()
        state.claudeCodeFound = found != nil
        state.claudeCodePath = found?.path
        state.mcp = mcpState(launcher: launcher)
        state.skill = skillState(source: skillSource, appVersion: appVersion)
        return state
    }

    /// The old names and what the settings say of CUA's tools (F9), the part the update's notification needs too.
    func leftovers(now: Date = Date()) -> ClaudeSetupState {
        var state = ClaudeSetupState()
        state.legacyPlugins = recordedLegacyPlugins()
        state.oldServer = config().oldServer
        state.oldSkill = oldSkillPresent()
        state.permissions = permissionReading(now: now)
        return state
    }

    /// The launcher of the engine's current version: one path whatever the version, because `current` is a link
    /// the engine moves. What the engine did not say is this.
    var defaultLauncher: String {
        home.appendingPathComponent(".local/share/codex-cua/engine/current/start-mcp.sh").path
    }

    /// The start script behind `current` is there (a link is followed: a dangling one is not there).
    var defaultLauncherExists: Bool { FileManager.default.fileExists(atPath: defaultLauncher) }

    /// What `mcpServers.cuabar` at the top of `~/.claude.json` is, compared with what the app installs: the
    /// launcher the engine reported, else `defaultLauncher`, with no arguments.
    func mcpState(launcher: String?) -> ClaudeSetupState.Part {
        switch config().entry {
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

    /// What the app needs of `~/.claude.json`.
    private struct ConfigReading {
        var entry: McpEntry
        /// `mcpServers.cua` is there and runs the app's engine: what 0.8.0 installed (F9).
        var oldServer = false
        /// The folders Claude Code keeps a record for (the keys of `projects`).
        var projects: [String] = []
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
        private var reading: ConfigReading?
        private var parsed = 0

        func lookup(_ signature: FileSignature) -> ConfigReading? {
            lock.withLock { self.signature == signature ? reading : nil }
        }

        func store(_ reading: ConfigReading, for signature: FileSignature) {
            lock.withLock {
                self.signature = signature
                self.reading = reading
                parsed += 1
            }
        }

        var parseCount: Int { lock.withLock { parsed } }
    }

    /// How many times `~/.claude.json` was parsed. For tests.
    var configParseCount: Int { configCache.parseCount }

    private func config() -> ConfigReading {
        guard let signature = FileSignature(path: configURL.path) else {
            return ConfigReading(entry: FileManager.default.fileExists(atPath: configURL.path) ? .unreadable : .absent)
        }
        if let known = configCache.lookup(signature) { return known }
        let reading = parseConfig()
        // A file that changed while it was read is looked at again next time.
        if FileSignature(path: configURL.path) == signature { configCache.store(reading, for: signature) }
        return reading
    }

    private func parseConfig() -> ConfigReading {
        guard
            let data = try? Data(contentsOf: configURL),
            let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return ConfigReading(entry: .unreadable) }
        let projects = (root["projects"] as? [String: Any]).map { Array($0.keys) } ?? []
        guard let servers = root["mcpServers"] else { return ConfigReading(entry: .absent, projects: projects) }
        guard let table = servers as? [String: Any] else { return ConfigReading(entry: .unreadable, projects: projects) }
        let oldCommand = (table[OldName.serverKey] as? [String: Any])?["command"] as? String
        var reading = ConfigReading(entry: .absent, oldServer: oldCommand.map(isAppOwned) ?? false, projects: projects)
        guard let entry = table[Self.serverName] else { return reading }
        guard let server = entry as? [String: Any] else {
            reading.entry = .server(command: nil, hasArguments: false)
            return reading
        }
        reading.entry = .server(command: server["command"] as? String, hasArguments: !((server["args"] as? [Any]) ?? []).isEmpty)
        return reading
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

    /// 0.8.0's skill is still there: a real folder with the app's mark. Somebody else's `cua` skill is not the app's to
    /// tell about.
    func oldSkillPresent() -> Bool {
        var info = stat()
        guard lstat(oldSkillFolder.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR else { return false }
        return FileManager.default.fileExists(atPath: oldSkillFolder.appendingPathComponent(Self.markerName).path)
    }

    /// The old plugins Claude Code still records, whatever the scope: two CUAs attach either way.
    func recordedLegacyPlugins() -> [String] {
        guard
            let data = try? Data(contentsOf: legacyRegistryURL),
            let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let plugins = root["plugins"] as? [String: Any]
        else { return [] }
        return LegacyPlugin.ids.filter { !((plugins[$0] as? [Any]) ?? []).isEmpty }
    }

    func legacyPluginRecorded() -> Bool { !recordedLegacyPlugins().isEmpty }

    // MARK: Permissions (F9)

    /// What the settings files say of CUA's tools. The user settings are read every time; the project folders' files
    /// at most once every `folderRescan` (R25).
    func permissionReading(now: Date = Date()) -> PermissionReading {
        var reading = PermissionReading()
        let user = userSettingsURL
        if FileManager.default.fileExists(atPath: user.path) {
            if let data = try? Data(contentsOf: user), let file = SettingsFileReading(data: data) {
                reading.userRule = file.cuabarAllowed ? .allowed : file.cuabarAskedOrDenied ? .askedOrDenied : .none
                reading.defaultMode = file.defaultMode
                if file.oldRules { reading.oldRuleFiles.append(shown(user)) }
                if file.oldHooks { reading.oldHookFiles.append(shown(user)) }
            } else {
                reading.unreadable = true
            }
        }
        let folders = folderCache.scan(now: now, every: folderRescan) { scanFolders() }
        reading.oldRuleFiles += folders.oldRuleFiles
        reading.oldHookFiles += folders.oldHookFiles
        return reading
    }

    private func scanFolders() -> FolderScan {
        var scan = FolderScan()
        for file in projectSettingsFiles() {
            guard let data = try? Data(contentsOf: file), let reading = SettingsFileReading(data: data) else { continue }
            if reading.oldRules { scan.oldRuleFiles.append(shown(file)) }
            if reading.oldHooks { scan.oldHookFiles.append(shown(file)) }
        }
        return scan
    }

    /// The home folder's folders macOS asks about before an app looks inside (Desktop, Documents, Downloads, and iCloud
    /// Drive and other apps' data under Library): a look there would put a permission window in front of the person.
    static let askedFolders = ["Desktop", "Documents", "Downloads", "Library", ".Trash"]

    /// `.claude/settings.json` and `.claude/settings.local.json` of each folder `~/.claude.json` lists inside the home
    /// folder, and of the top of its git repository, where "다시 묻지 않기" saves. Folders outside the home folder (a
    /// network drive among them) are left alone: a look there can hang. So are `askedFolders` (R25).
    func projectSettingsFiles() -> [URL] {
        let homePath = home.standardizedFileURL.path
        // The disk does not care about case, and a recorded path may not either.
        let asked = Self.askedFolders.map { (homePath + "/" + $0).lowercased() }
        var folders: [String] = []
        var seen: Set<String> = []
        for path in config().projects.sorted() {
            let folder = URL(fileURLWithPath: path).standardizedFileURL.path
            guard folder == homePath || folder.hasPrefix(homePath + "/") else { continue }
            let lowered = folder.lowercased()
            guard !asked.contains(where: { lowered == $0 || lowered.hasPrefix($0 + "/") }) else { continue }
            guard !Self.passesALink(folder, below: homePath) else { continue }
            for candidate in [folder, gitTop(of: folder, home: homePath)].compactMap({ $0 }) where seen.insert(candidate).inserted {
                folders.append(candidate)
            }
        }
        let user = userSettingsURL.standardizedFileURL.path
        return folders.flatMap { folder in
            [".claude/settings.json", ".claude/settings.local.json"].map { URL(fileURLWithPath: folder).appendingPathComponent($0) }
        }.filter { $0.path != user && FileManager.default.fileExists(atPath: $0.path) }
    }

    /// A folder reached through a link may be anywhere, one of `askedFolders` among them, and one that is gone has
    /// nothing to read: both are left alone. Only the links are looked at, never where they lead.
    private static func passesALink(_ folder: String, below homePath: String) -> Bool {
        var current = homePath
        for part in folder.dropFirst(homePath.count).split(separator: "/") {
            current += "/" + part
            var info = stat()
            guard lstat(current, &info) == 0, (info.st_mode & S_IFMT) != S_IFLNK else { return true }
        }
        return false
    }

    /// The nearest folder at or above `folder` with a `.git`, without leaving the home folder.
    private func gitTop(of folder: String, home homePath: String) -> String? {
        var current = folder
        while current == homePath || current.hasPrefix(homePath + "/") {
            if FileManager.default.fileExists(atPath: current + "/.git") { return current }
            if current == homePath { return nil }
            current = (current as NSString).deletingLastPathComponent
        }
        return nil
    }

    /// A path as the 점검 tab shows it: `~` for the home folder.
    private func shown(_ file: URL) -> String {
        let homePath = home.standardizedFileURL.path
        let path = file.standardizedFileURL.path
        return path.hasPrefix(homePath + "/") ? "~" + path.dropFirst(homePath.count) : path
    }

    // MARK: Changing

    /// How one `claude` command ended.
    enum CommandResult: Equatable, Sendable {
        case succeeded
        case failed
        /// It could not start: no `claude`, or exit 127 (the `node` an npm-installed one needs was not found).
        case cannotStart
    }

    /// `claude mcp add -s user cuabar -- <command>`.
    func addMCP(command: String) async -> CommandResult {
        await runClaude(["mcp", "add", "-s", "user", Self.serverName, "--", command])
    }

    /// `claude mcp remove -s user cuabar`.
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
        switch config().entry {
        case .unreadable:
            removal.mcpStays = true
        case .server(let command?, _) where isAppOwned(command):
            _ = await removeMCP()
            switch config().entry {
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
