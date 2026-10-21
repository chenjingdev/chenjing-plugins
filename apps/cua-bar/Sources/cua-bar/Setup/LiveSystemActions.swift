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
    /// An MCP server or a skill named cua that the app did not put there: left as it is.
    static let conflict = "Claude Code에 앱이 깔지 않은 cua가 있어서 그대로 뒀어요 — 점검 탭에서 지우는 방법을 보세요"
    /// A new Claude conversation is where the connection shows up.
    static let installed = "새 Claude 대화부터 CUA가 붙어요"
    static let developerToolsOpened = "개발자 도구 설치 창을 열었어요 — 끝나면 설치를 한 번 더 눌러 주세요"
    static let developerToolsFailed = "개발자 도구 설치 창을 열지 못했어요"
    static let openedCodexDownload = "Codex 받는 곳을 열었어요"
    static let couldNotOpen = "받는 곳을 열지 못했어요"
}

/// The fixes that reach outside the engine: opening a download page, the developer tools' installer, and the
/// install itself (F1, R1): the engine in the app's bundle is unpacked by its own `setup.sh install-engine`,
/// then the `cua` MCP server and skill are put into Claude Code.
///
/// Every step runs only because the app was started or a button was pressed; a status read never reaches
/// here. The install takes the shared setup slot (`SetupActivity`), so two never run at once. It looks
/// before it touches anything and changes only what is missing or the app's own and out of date:
///
/// 1. no Codex app: nothing (the card says so); put off until it is there
/// 2. no developer tools (`xcode-select -p`): nothing (the card asks for them); the installer opens only on the button
/// 3. no engine, or one of another version than the app's: `install-engine` from the bundle
/// 4. Claude Code there: the MCP server and the skill, put in or replaced when the app's own, never over another's
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

        static func failure(_ message: String) -> Run {
            Run(outcome: ActionOutcome(kind: .failure, message: message), succeeded: false)
        }
    }

    func setUp() async -> ActionOutcome {
        guard await setup.begin() else { return ActionOutcome(kind: .info, message: InstallMessages.busy) }
        let result = await install()
        await setup.record(waitingFor: result.waiting, developerToolsNeeded: result.developerToolsNeeded)
        await setup.end(succeeded: result.succeeded)
        return await told(result.outcome)
    }

    /// Right after the app replaced itself with a newer version (F4), "새 Claude 대화부터 CUA가 붙어요" is not said. The
    /// update's own line is, "CUA Bar를 x.y.z로 올렸어요. 새 Claude 대화부터 새 판이 쓰여요", as a notification: the popover
    /// is closed when the new app starts, and a banner in it would pass unseen. So the person hears one thing, once, and
    /// the update's mark is taken away. Where no notification went out (they are off), the line is the banner's.
    /// The line of an install that had no Claude Code to tell about stays as it is, and the mark goes with it. Any other
    /// outcome leaves the mark for the run that finishes the install.
    private func told(_ outcome: ActionOutcome) async -> ActionOutcome {
        guard let updateNotice else { return outcome }
        guard outcome.message == InstallMessages.installed || outcome.message == Self.engineOnly else { return outcome }
        let running = VersionNumber(appVersion)
        guard let line = updateNotice.lineIfJustUpdated(to: running), let version = running else { return outcome }
        updateNotice.clear()
        guard outcome.message == InstallMessages.installed else { return outcome }
        if let announce, await announce(.updated(version)) { return InstallMessages.nothingToSay }
        return ActionOutcome(kind: .success, message: line)
    }

    private func install() async -> Run {
        guard codex.isInstalled() else { return Run(waiting: [.codex]) }
        guard let bundle else { return Run() }
        guard await developerToolsPresent() else { return Run(developerToolsNeeded: true) }

        var changed = false
        let launcher: String?
        switch await engineState() {
        case .current(let current):
            launcher = current
        case .unknown:
            // It could not be asked in time; the engine may be fine. The next try is the person's.
            return Run()
        case .needsInstall:
            guard let installed = await installEngine(from: bundle) else { return .failure(InstallMessages.engineFailed) }
            launcher = installed.launcher
            changed = true
        }

        guard claude.claudeCodeFound else {
            return Run(outcome: changed ? ActionOutcome(kind: .success, message: Self.engineOnly) : InstallMessages.nothingToSay, waiting: [.claudeCode])
        }
        var conflict = false

        switch claude.mcpState(launcher: launcher) {
        case .missing:
            guard await putMCP(launcher: launcher, replacing: false) else { return .failure(InstallMessages.mcpFailed) }
            changed = true
        case .outdated:
            guard await putMCP(launcher: launcher, replacing: true) else { return .failure(InstallMessages.mcpFailed) }
            changed = true
        case .conflict:
            conflict = true
        case .ready, .unknown:
            break
        }

        switch claude.skillState(source: bundle.skillSource, appVersion: appVersion) {
        case .missing, .outdated:
            guard claude.installSkill(from: bundle.skillSource, version: appVersion ?? "dev") else {
                return .failure(InstallMessages.skillFailed)
            }
            changed = true
        case .conflict:
            conflict = true
        case .ready, .unknown:
            break
        }

        if conflict { return Run(outcome: ActionOutcome(kind: .warning, message: InstallMessages.conflict)) }
        return Run(outcome: changed ? ActionOutcome(kind: .success, message: InstallMessages.installed) : InstallMessages.nothingToSay)
    }

    /// Said when the engine was installed but there is no Claude Code to connect it to yet.
    static let engineOnly = "연결 설정을 마쳤어요"

    private enum EngineState {
        /// The engine is the app's; this is the launcher it reported (nil: it did not say).
        case current(String?)
        case needsInstall
        case unknown
    }

    /// The command's own status says which engine runs: the app's version is what it must be.
    private func engineState() async -> EngineState {
        do {
            let status = try await engine.status()
            if versionIsTheApps(status.engine.version) { return .current(status.engine.launcher) }
            return .needsInstall
        } catch let error as EngineError {
            return error.needsEngineInstall ? .needsInstall : .unknown
        } catch {
            return .unknown
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
    }

    /// `/bin/sh <bundle>/setup.sh install-engine --json`: the folder it is run from is unpacked to
    /// `~/.local/share/codex-cua/engine/<version>/` and set up from there. Through `sh`, so a copy that lost
    /// its executable bit still runs. Nil when it failed.
    private func installEngine(from bundle: BundledEngine) async -> InstalledEngine? {
        do {
            let output = try await runner.run(
                URL(fileURLWithPath: "/bin/sh"), arguments: [bundle.setupScript.path, "install-engine", "--json"],
                timeout: timeouts.engineInstall)
            guard output.exitCode == 0 else { return nil }
            if let launcher = Self.launcher(in: output.stdout) { return InstalledEngine(launcher: launcher) }
            // The install did not name it: the status of the engine it just set up may.
            return InstalledEngine(launcher: (try? await engine.status())?.engine.launcher)
        } catch {
            return nil
        }
    }

    /// `launcher` of the result line (the last line of stdout that is a JSON object): an absolute path.
    static func launcher(in stdout: Data) -> String? {
        let text = String(decoding: stdout, as: UTF8.self)
        for line in text.split(whereSeparator: \.isNewline).reversed() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("{"), let data = trimmed.data(using: .utf8),
                  let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
            guard let launcher = object["launcher"] as? String, launcher.hasPrefix("/") else { return nil }
            return launcher
        }
        return nil
    }

    /// The server is added (after the app's out-of-date one is removed), and then read back from the file: the
    /// command's word is not enough.
    private func putMCP(launcher: String?, replacing: Bool) async -> Bool {
        if replacing, !(await claude.removeMCP()) { return false }
        guard await claude.addMCP(command: claude.expectedLauncher(launcher)) else { return false }
        return claude.mcpState(launcher: launcher) == .ready
    }
}
