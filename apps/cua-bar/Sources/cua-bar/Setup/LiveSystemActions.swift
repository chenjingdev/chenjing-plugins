import AppKit
import Foundation

/// Opens a page in the browser. Injected so tests open nothing.
protocol URLOpening: Sendable {
    func open(_ url: URL) async -> Bool
}

struct WorkspaceURLOpener: URLOpening {
    func open(_ url: URL) async -> Bool {
        await MainActor.run { NSWorkspace.shared.open(url) }
    }
}

enum ExternalPages {
    /// UNVERIFIED: the page where the Codex app is downloaded. Kept as one constant so the
    /// address is easy to correct.
    static let codexDownload = URL(string: "https://openai.com/codex/")!
}

/// The fixed lines the install and the fix buttons say. A command that fails gives one of these and never
/// the text it printed.
enum InstallMessages {
    static let busy = "이미 하는 중이에요"
    /// What a run says when it did nothing worth a banner (the Mac needs nothing, or the card already says why).
    static let nothingToSay = ActionOutcome(kind: .info, message: "")
    static let engineFailed = "연결 엔진을 설치하지 못했어요"
    static let mcpFailed = "Claude Code에 CUA를 연결하지 못했어요"
    static let skillFailed = "Claude Code에 CUA 스킬을 깔지 못했어요"
    /// An MCP server or a skill named cuabar that the app did not put there: left as it is.
    static let conflict = "Claude Code에 앱이 깔지 않은 cuabar가 있어서 그대로 뒀어요 — 점검 탭에서 치우는 방법을 보세요"
    /// A new Claude conversation is where the connection shows up.
    static let installed = "새 Claude 대화부터 CUA가 붙어요"
    /// The engine's setup ran again and still reports a part that is not ready.
    static let notAllRepaired = "다시 설정했지만 고쳐지지 않은 곳이 있어요 — 점검 탭에서 보세요"
    static let developerToolsOpened = "개발자 도구 설치 창을 열었어요 — 끝나면 설치를 한 번 더 눌러 주세요"
    static let developerToolsFailed = "개발자 도구 설치 창을 열지 못했어요"
    static let openedCodexDownload = "Codex 받는 곳을 열었어요"
    static let couldNotOpen = "받는 곳을 열지 못했어요"
}

/// The fixes that reach outside the engine: opening a download page, the developer tools' installer, and the
/// install itself (F1, R1): the engine in the app's bundle is unpacked by its own `setup.sh install-engine`,
/// then the `cuabar` MCP server and skill are put into Claude Code.
///
/// Every step runs only because the app was started or a button was pressed; a status read never reaches
/// here. The install takes the shared setup slot (`SetupActivity`), so two never run at once. It looks
/// before it touches anything and changes only what is missing or the app's own and out of date:
///
/// 1. no Codex app (the engine's status says, else the app looks at the disk): nothing (the card says so); put off
///    until it is there
/// 2. no developer tools (`xcode-select -p`): nothing (the card asks for them); the installer opens only on the button
/// 3. no engine, one of another version than the app's, a command that cannot answer or start, or one whose status
///    calls a part of the setup broken: `install-engine` from the bundle (a whole copy of the same version stays as it
///    is; the setup runs again). A status that cannot be had in time puts only this step off, to the first read that
///    works; the MCP server then goes in only when the launcher is already there
/// 4. Claude Code there: the MCP server and the skill, put in or replaced when the app's own, never over another's.
///    A `claude` that cannot start (exit 127) is treated like no Claude Code for this run
///
/// A build that does not run from an app bundle (no engine inside) installs nothing.
final class LiveSystemActions: SystemActions, @unchecked Sendable {
    struct Timeouts: Equatable, Sendable {
        /// `xcode-select -p`, and `xcode-select --install` (which only opens the system's installer).
        var developerTools: Duration = .seconds(30)
        /// `install-engine` may be installing packages, and stopping that halfway leaves a broken environment.
        var engineInstall: Duration = EngineTimeouts().setup
    }

    private let claude: ClaudeIntegration
    private let engine: any EngineClient
    private let runner: any ProcessRunning
    private let opener: any URLOpening
    private let bundle: BundledEngine?
    private let appVersion: String?
    private let setup: SetupActivity
    private let codex: CodexLocator
    private let timeouts: Timeouts
    private let updateNotice: UpdateNotice?
    private let announce: (@Sendable (AppNotification) async -> Bool)?

    init(
        claude: ClaudeIntegration,
        engine: any EngineClient,
        runner: any ProcessRunning = SystemProcessRunner(),
        opener: any URLOpening = WorkspaceURLOpener(),
        bundle: BundledEngine?,
        appVersion: String?,
        setup: SetupActivity,
        codex: CodexLocator = CodexLocator(),
        timeouts: Timeouts = Timeouts(),
        // The mark an update leaves for the app that starts after it; nil: none is looked for (tests, previews).
        updateNotice: UpdateNotice? = nil,
        // Posts a notification and says whether it went out (`Notifier.post`); nil: the line goes to the banner instead.
        announce: (@Sendable (AppNotification) async -> Bool)? = nil
    ) {
        self.claude = claude
        self.engine = engine
        self.runner = runner
        self.opener = opener
        self.bundle = bundle
        self.appVersion = appVersion
        self.setup = setup
        self.codex = codex
        self.timeouts = timeouts
        self.updateNotice = updateNotice
        self.announce = announce
    }

    // MARK: Codex download

    func openCodexDownload() async -> ActionOutcome {
        await opener.open(ExternalPages.codexDownload)
            ? ActionOutcome(kind: .info, message: InstallMessages.openedCodexDownload)
            : ActionOutcome(kind: .failure, message: InstallMessages.couldNotOpen)
    }

    // MARK: Developer tools

    /// The card's button when the developer tools are missing. The tools may have come since (the person
    /// finished the installer): then it is the whole install. Otherwise the system's installer opens.
    func installDeveloperTools() async -> ActionOutcome {
        if await developerToolsPresent() { return await setUp() }
        do {
            let output = try await runner.run(Self.xcodeSelect, arguments: ["--install"], timeout: timeouts.developerTools)
            return output.exitCode == 0
                ? ActionOutcome(kind: .info, message: InstallMessages.developerToolsOpened)
                : ActionOutcome(kind: .failure, message: InstallMessages.developerToolsFailed)
        } catch {
            return ActionOutcome(kind: .failure, message: InstallMessages.developerToolsFailed)
        }
    }

    static let xcodeSelect = URL(fileURLWithPath: "/usr/bin/xcode-select")

    /// `xcode-select -p`. Never `/usr/bin/python3`: without the tools that opens the installer's window.
    private func developerToolsPresent() async -> Bool {
        do {
            return try await runner.run(Self.xcodeSelect, arguments: ["-p"], timeout: timeouts.developerTools).exitCode == 0
        } catch {
            return false
        }
    }

    // MARK: The install

    private struct Run {
        var outcome = InstallMessages.nothingToSay
        var succeeded = true
        var waiting: Set<SetupWait> = []
        var developerToolsNeeded = false
        var claudeCodeUnusable = false
        /// The run changed something: put the engine in, repaired its setup, or changed Claude Code's MCP server or skill.
        var changed = false

        static func failure(_ message: String, waiting: Set<SetupWait> = [], changed: Bool = false) -> Run {
            Run(outcome: ActionOutcome(kind: .failure, message: message), succeeded: false, waiting: waiting, changed: changed)
        }
    }

    /// Runs after an install that changed something, with the connection test: it tests the Codex host when that is
    /// ready (and only then) and says how it ended; nil when no test was run. Set by the app once the model exists.
    private let afterChangeLock = NSLock()
    private var afterChangeHook: (@Sendable () async -> ProbeOutcome?)?

    func setAfterChange(_ hook: (@Sendable () async -> ProbeOutcome?)?) {
        afterChangeLock.withLock { afterChangeHook = hook }
    }

    /// The install, with a banner that says what the connection test after it found when that failed.
    func setUp() async -> ActionOutcome {
        let done = await setUpAndTest()
        return await told(done.outcome, probe: done.probe)
    }

    /// The install and, when it changed something and the Codex host is ready, one connection test after it. `outcome` is
    /// what the install itself says; `probe` is how the test ended (nil: none was run). What is said (a banner, or the
    /// notification that says an update is done) comes after the test, so the caller adds the failure sentence to it
    /// (`ProbeMessages`, `AppNotification.appending(probe:)`). A run that changed nothing (almost every start) tests nothing.
    func setUpAndTest() async -> (outcome: ActionOutcome, probe: ProbeOutcome?) {
        guard await setup.begin() else { return (ActionOutcome(kind: .info, message: InstallMessages.busy), nil) }
        let result = await install()
        await setup.record(
            waitingFor: result.waiting, developerToolsNeeded: result.developerToolsNeeded, claudeCodeUnusable: result.claudeCodeUnusable)
        await setup.end(succeeded: result.succeeded)
        let hook = afterChangeLock.withLock { afterChangeHook }
        let probe = result.changed ? await hook?() : nil
        return (result.outcome, probe)
    }

    /// Right after the app replaced itself with a newer version (F4), "새 Claude 대화부터 CUA가 붙어요" is not said. The
    /// update's own line is, "CUA Bar를 x.y.z로 올렸어요. 새 Claude 대화부터 새 판이 쓰여요", as a notification: the popover
    /// is closed when the new app starts, and a banner in it would pass unseen. So the person hears one thing, once, and
    /// the update's mark is taken away. Where no notification went out (they are off), the line is the banner's.
    /// The line of an install that had no Claude Code to tell about stays as it is, and the mark goes with it. Any other
    /// outcome leaves the mark for the run that finishes the install.
    /// The connection test ran before any of this; when it failed, its sentence goes after whatever is said, the
    /// notification or the banner, and only there.
    private func told(_ outcome: ActionOutcome, probe: ProbeOutcome?) async -> ActionOutcome {
        let said = ProbeMessages.attach(probe, to: outcome)
        guard let updateNotice else { return said }
        guard outcome.message == InstallMessages.installed || outcome.message == Self.engineOnly else { return said }
        let running = VersionNumber(appVersion)
        guard let line = updateNotice.lineIfJustUpdated(to: running), let version = running else { return said }
        updateNotice.clear()
        guard outcome.message == InstallMessages.installed else { return said }
        if let announce, await announce(AppNotification.updated(version).appending(probe: probe)) {
            return InstallMessages.nothingToSay
        }
        return ProbeMessages.attach(probe, to: ActionOutcome(kind: .success, message: line))
    }

    private func install() async -> Run {
        guard let bundle else { return Run() }
        // Looking changes nothing, and the engine's own word about Codex counts more than the app's look at the disk.
        // The run that follows a read is handed that read's answer instead of asking again.
        let read: EngineRead
        if let offered = await setup.takeOfferedStatus() {
            read = .answered(offered)
        } else {
            read = await readEngine()
        }
        guard codexIsThere(read) else { return Run(waiting: [.codex]) }
        guard await developerToolsPresent() else { return Run(developerToolsNeeded: true) }

        var changed = false
        var repaired = false
        var unsettled = false
        var waiting: Set<SetupWait> = []
        let launcher: String?
        switch verdict(of: read) {
        case .current(let known):
            launcher = known
        case .needsSetup(let known):
            // The engine is the app's but a part of its setup is broken: `install-engine` leaves a whole copy of
            // the same version as it is and runs the setup again.
            guard let installed = await installEngine(from: bundle) else { return .failure(InstallMessages.engineFailed) }
            launcher = installed.launcher ?? known
            repaired = installed.settled
            unsettled = !installed.settled
        case .needsInstall:
            guard let installed = await installEngine(from: bundle) else { return .failure(InstallMessages.engineFailed) }
            launcher = installed.launcher
            changed = true
        case .unknown:
            // It could not be asked in time, and the engine may be fine. The engine step waits for the first read
            // that works; the MCP server and the skill do not depend on it (the launcher is one path).
            launcher = nil
            waiting.insert(.status)
        }

        /// What the engine's part alone has to say, when Claude Code's part is not done.
        func engineOutcome() -> ActionOutcome {
            if changed || repaired { return ActionOutcome(kind: .success, message: Self.engineOnly) }
            if unsettled { return ActionOutcome(kind: .warning, message: InstallMessages.notAllRepaired) }
            return InstallMessages.nothingToSay
        }

        guard claude.claudeCodeFound else {
            waiting.insert(.claudeCode)
            return Run(outcome: engineOutcome(), waiting: waiting, changed: changed || repaired)
        }
        var conflict = false

        // Without the engine's answer the launcher is the one path `current` gives, and it goes in only when it is
        // there: on a Mac where the app's engine was never unpacked, a new conversation would get a server that
        // cannot start. It then waits with the engine step.
        let mcpCanGoIn = !waiting.contains(.status) || claude.defaultLauncherExists
        let mcp = claude.mcpState(launcher: launcher)
        switch mcp {
        case .missing, .outdated:
            guard mcpCanGoIn else { break }
            switch await putMCP(launcher: launcher, replacing: mcp == .outdated) {
            case .succeeded:
                changed = true
            case .cannotStart:
                // Not something another try fixes by itself: it is said in the check tab, and the next start tries again.
                return Run(outcome: engineOutcome(), waiting: waiting, claudeCodeUnusable: true, changed: changed || repaired)
            case .failed:
                return .failure(InstallMessages.mcpFailed, waiting: waiting, changed: changed || repaired)
            }
        case .conflict:
            conflict = true
        case .ready, .unknown:
            break
        }

        switch claude.skillState(source: bundle.skillSource, appVersion: appVersion) {
        case .missing, .outdated:
            guard claude.installSkill(from: bundle.skillSource, version: appVersion ?? "dev") else {
                return .failure(InstallMessages.skillFailed, waiting: waiting, changed: changed || repaired)
            }
            changed = true
        case .conflict:
            conflict = true
        case .ready, .unknown:
            break
        }

        let outcome: ActionOutcome
        if conflict {
            outcome = ActionOutcome(kind: .warning, message: InstallMessages.conflict)
        } else if changed {
            outcome = ActionOutcome(kind: .success, message: InstallMessages.installed)
        } else {
            outcome = engineOutcome()
        }
        return Run(outcome: outcome, waiting: waiting, changed: changed || repaired)
    }

    /// Said when the engine was put right but nothing in Claude Code changed (or there is no Claude Code yet).
    static let engineOnly = "연결 설정을 마쳤어요"

    private enum EngineRead {
        case answered(EngineStatus)
        case failed(EngineError)
    }

    /// The command's own status says which engine runs and in what state it is.
    private func readEngine() async -> EngineRead {
        do {
            return .answered(try await engine.status())
        } catch let error as EngineError {
            return .failed(error)
        } catch {
            // Not an answer either way (a cancelled read): it says nothing about the engine.
            return .failed(.timeout)
        }
    }

    /// Codex is there when the engine says so; when it does not say (or cannot be asked), the app looks.
    private func codexIsThere(_ read: EngineRead) -> Bool {
        if case .answered(let status) = read, let installed = status.codex.installed { return installed }
        return codex.isInstalled()
    }

    private enum EngineVerdict {
        /// The engine is the app's and nothing in its setup is broken; this is the launcher it reported (nil: it did not say).
        case current(String?)
        /// The engine is the app's but its status calls a part of the setup broken (the Python environment, the
        /// login environment, the wrapper, the relay): the setup runs again.
        case needsSetup(String?)
        /// No engine, one of another version (or with none), or a command that cannot answer or start: the bundle's
        /// is put in.
        case needsInstall
        /// It could not be asked in time.
        case unknown
    }

    /// What the card shows is what is acted on: the same version rule and the same list of broken parts.
    private func verdict(of read: EngineRead) -> EngineVerdict {
        switch read {
        case .answered(let status):
            guard versionIsTheApps(status.engine.version) else { return .needsInstall }
            return StatusEvaluator.setupIssues(in: status.setup).isEmpty ? .current(status.engine.launcher) : .needsSetup(status.engine.launcher)
        case .failed(let error):
            return error.needsEngineInstall ? .needsInstall : .unknown
        }
    }

    private func versionIsTheApps(_ version: String?) -> Bool {
        let engineVersion = version?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !engineVersion.isEmpty else { return false }
        guard let app = appVersion?.trimmingCharacters(in: .whitespacesAndNewlines), !app.isEmpty else { return true }
        return engineVersion == app
    }

    private struct InstalledEngine {
        /// The launcher the install reported, or what the status says after it; nil when neither does.
        var launcher: String?
        /// What the install reports of the setup it ran: the command, the login environment and the relay are all ready.
        var settled: Bool
    }

    /// `/bin/sh <bundle>/setup.sh install-engine --json`: the folder it is run from is unpacked to
    /// `~/.local/share/codex-cua/engine/<version>/` (a whole copy of the same version stays as it is) and set up
    /// from there. Through `sh`, so a copy that lost its executable bit still runs. Nil when it failed.
    private func installEngine(from bundle: BundledEngine) async -> InstalledEngine? {
        do {
            let output = try await runner.run(
                URL(fileURLWithPath: "/bin/sh"), arguments: [bundle.setupScript.path, "install-engine", "--json"],
                timeout: timeouts.engineInstall)
            guard output.exitCode == 0 else { return nil }
            let settled = Self.setupIsSettled(in: output.stdout)
            if let launcher = Self.launcher(in: output.stdout) { return InstalledEngine(launcher: launcher, settled: settled) }
            // The install did not name it: the status of the engine it just set up may.
            return InstalledEngine(launcher: (try? await engine.status())?.engine.launcher, settled: settled)
        } catch {
            return nil
        }
    }

    /// The last line of stdout that is a JSON object: the install's result.
    private static func resultLine(in stdout: Data) -> [String: Any]? {
        let text = String(decoding: stdout, as: UTF8.self)
        for line in text.split(whereSeparator: \.isNewline).reversed() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("{"), let data = trimmed.data(using: .utf8),
                  let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
            return object
        }
        return nil
    }

    /// `launcher` of the result line: an absolute path.
    static func launcher(in stdout: Data) -> String? {
        guard let launcher = resultLine(in: stdout)?["launcher"] as? String, launcher.hasPrefix("/") else { return nil }
        return launcher
    }

    /// `setup` of the result line says `ready` for the command, the login environment and the relay. A login
    /// environment that clashes with a value somebody else set (`conflict`) counts as settled: setting up again cannot
    /// change it, and it has a card of its own. A result that does not say is taken as settled: the install itself
    /// went through.
    static func setupIsSettled(in stdout: Data) -> Bool {
        guard let setup = resultLine(in: stdout)?["setup"] as? [String: Any] else { return true }
        let settled: [String: Set<String>] = ["command": ["ready"], "login_environment": ["ready", "conflict"], "relay": ["ready"]]
        return settled.allSatisfy { key, words in (setup[key] as? String).map { words.contains($0) } ?? true }
    }

    /// The server is added (after the app's out-of-date one is removed), and then read back from the file: the
    /// command's word is not enough.
    private func putMCP(launcher: String?, replacing: Bool) async -> ClaudeIntegration.CommandResult {
        if replacing {
            let removed = await claude.removeMCP()
            guard removed == .succeeded else { return removed }
        }
        let added = await claude.addMCP(command: claude.expectedLauncher(launcher))
        guard added == .succeeded else { return added }
        return claude.mcpState(launcher: launcher) == .ready ? .succeeded : .failed
    }
}
