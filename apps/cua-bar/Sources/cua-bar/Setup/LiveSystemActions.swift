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

/// The fixed lines the fix buttons say. A command that fails gives one of these and never the
/// text it printed.
enum PluginMessages {
    static let claudeMissing = "Claude Code가 없어요"
    static let busy = "이미 하는 중이에요"
    static let marketplaceAddFailed = "플러그인 저장소를 추가하지 못했어요"
    static let marketplaceUpdateFailed = "플러그인 목록을 새로 받지 못했어요"
    static let installFailed = "플러그인을 설치하지 못했어요"
    static let updateFailed = "플러그인을 갱신하지 못했어요"
    static let setupFailed = "플러그인은 준비됐지만 연결 설정에 실패했어요 — 다시 하기를 눌러 주세요"
    /// R19: a new Claude conversation is where the plugin shows up.
    static let installed = "새 Claude 대화부터 CUA가 붙어요"
    static let updated = "새 Claude 대화부터 새 판이 붙어요"
    static let unchangedAfterUpdate = "플러그인 판이 그대로예요 — 받을 수 있는 가장 새 판이 앱과 달라요"
    static let sameVersion = "앱과 플러그인 판이 이미 같아요"
    static let appVersionUnknown = "앱 판을 알 수 없어요"
    static let openedCodexDownload = "Codex 받는 곳을 열었어요"
    static let openedAppRelease = "새 앱 판 받는 곳을 열었어요 — 받아서 Applications로 옮겨 주세요"
    static let couldNotOpen = "받는 곳을 열지 못했어요"
}

/// What the `--json` commands of `claude plugin …` answered, read the careful way: the exit code
/// decides first, then the result line (the last line of stdout that is a JSON object) may still
/// say it failed. Nothing the command printed ever reaches the screen.
enum ClaudeResult {
    static func succeeded(_ output: ProcessOutput) -> Bool {
        guard output.exitCode == 0 else { return false }
        guard let object = resultLine(in: output.stdout) else { return true }
        if (object["success"] as? Bool) == false || (object["ok"] as? Bool) == false { return false }
        // Any error that is not null or an empty string.
        if let error = object["error"], !(error is NSNull), (error as? String)?.isEmpty != true { return false }
        if let status = (object["status"] as? String)?.lowercased(), ["error", "failed", "failure"].contains(status) { return false }
        return true
    }

    private static func resultLine(in stdout: Data) -> [String: Any]? {
        let text = String(decoding: stdout, as: UTF8.self)
        for line in text.split(whereSeparator: \.isNewline).reversed() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("{"), let data = trimmed.data(using: .utf8) else { continue }
            if let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] { return object }
        }
        return nil
    }
}

/// The fixes that reach outside the engine (R19, F7): opening a download page, and installing or
/// updating the Claude plugin with Claude Code's own `claude plugin …` commands.
///
/// Every step runs only because the app was started or a button was pressed; a status read never
/// reaches here. One install or update runs at a time, and the setup at its end takes the same
/// slot as every other setup (`SetupActivity`). It never passes `-y`, `--yes` or `--accept-command`.
final class LiveSystemActions: SystemActions, @unchecked Sendable {
    struct Timeouts: Equatable, Sendable {
        /// One `claude plugin …` command; they fetch from GitHub.
        var claudeStep: Duration = .seconds(300)
        /// The plugin's setup may be installing packages, and stopping that halfway leaves a broken environment.
        var setup: Duration = EngineTimeouts().setup
    }

    private let locator: CommandLocator
    private let claude: ClaudeCLILocator
    private let runner: any ProcessRunning
    private let opener: any URLOpening
    private let appVersion: String?
    private let setup: SetupActivity
    private let newestAppRelease: @Sendable () async -> ReleaseInfo?
    private let timeouts: Timeouts

    private let lock = NSLock()
    private var working = false

    init(
        locator: CommandLocator = CommandLocator(),
        claude: ClaudeCLILocator = ClaudeCLILocator(),
        runner: any ProcessRunning = SystemProcessRunner(),
        opener: any URLOpening = WorkspaceURLOpener(),
        appVersion: String?,
        setup: SetupActivity,
        newestAppRelease: @escaping @Sendable () async -> ReleaseInfo? = { nil },
        timeouts: Timeouts = Timeouts()
    ) {
        self.locator = locator
        self.claude = claude
        self.runner = runner
        self.opener = opener
        self.appVersion = appVersion
        self.setup = setup
        self.newestAppRelease = newestAppRelease
        self.timeouts = timeouts
    }

    // MARK: Codex download

    func openCodexDownload() async -> ActionOutcome {
        await open(ExternalPages.codexDownload, saying: PluginMessages.openedCodexDownload)
    }

    // MARK: Install (plugin_missing)

    /// Adds the marketplace when Claude Code does not know it yet, installs the plugin for the
    /// user, then sets it up.
    func installPlugin() async -> ActionOutcome {
        guard enter() else { return ActionOutcome(kind: .info, message: PluginMessages.busy) }
        defer { leave() }
        guard let claudeCLI = claude.locate() else { return failure(PluginMessages.claudeMissing) }

        if !locator.knowsMarketplace() {
            guard await runClaude(claudeCLI, Self.marketplaceAdd) else { return failure(PluginMessages.marketplaceAddFailed) }
        }
        guard await runClaude(claudeCLI, Self.install) else { return failure(PluginMessages.installFailed) }
        // The command said it worked; the registry is what says the plugin is really there.
        guard let plugin = registeredPluginWithSetupScript() else { return failure(PluginMessages.installFailed) }

        switch await runSetup(of: plugin) {
        case .done: return ActionOutcome(kind: .success, message: PluginMessages.installed)
        case .busy: return ActionOutcome(kind: .info, message: PluginMessages.busy)
        case .failed: return failure(PluginMessages.setupFailed)
        }
    }

    // MARK: Matching versions (version_mismatch)

    /// The plugin older than the app: refresh the marketplace, update the plugin, set it up. The
    /// plugin newer than the app (the marketplace updates by itself): open the app's release page.
    func matchPluginVersion() async -> ActionOutcome {
        guard let app = VersionNumber(appVersion) else { return failure(PluginMessages.appVersionUnknown) }
        let before = locator.registeredPlugin()
        if let plugin = VersionNumber(before?.version) {
            if plugin > app { return await openNewestAppRelease(than: app) }
            if plugin == app { return ActionOutcome(kind: .info, message: PluginMessages.sameVersion) }
        }

        guard enter() else { return ActionOutcome(kind: .info, message: PluginMessages.busy) }
        defer { leave() }
        guard let claudeCLI = claude.locate() else { return failure(PluginMessages.claudeMissing) }

        guard await runClaude(claudeCLI, Self.marketplaceUpdate) else { return failure(PluginMessages.marketplaceUpdateFailed) }
        guard await runClaude(claudeCLI, Self.update) else { return failure(PluginMessages.updateFailed) }
        guard let plugin = registeredPluginWithSetupScript() else { return failure(PluginMessages.updateFailed) }

        // An update that changed nothing and still does not match must not claim a new version.
        let after = VersionNumber(plugin.version)
        if after != app, after == VersionNumber(before?.version), plugin.installPath == before?.installPath {
            return ActionOutcome(kind: .warning, message: PluginMessages.unchangedAfterUpdate)
        }
        switch await runSetup(of: plugin) {
        case .done: return ActionOutcome(kind: .success, message: PluginMessages.updated)
        case .busy: return ActionOutcome(kind: .info, message: PluginMessages.busy)
        case .failed: return failure(PluginMessages.setupFailed)
        }
    }

    private func openNewestAppRelease(than app: VersionNumber) async -> ActionOutcome {
        let release = await newestAppRelease()
        let url = (release.flatMap { $0.version > app ? $0.url : nil }) ?? ReleaseSource.releasesPage
        return await open(url, saying: PluginMessages.openedAppRelease)
    }

    // MARK: Steps

    static let marketplaceAdd = ["plugin", "marketplace", "add", ReleaseSource.repository, "--json"]
    static let install = ["plugin", "install", CommandLocator.pluginID, "--scope", "user", "--json"]
    static let marketplaceUpdate = ["plugin", "marketplace", "update", CommandLocator.marketplaceName, "--json"]
    static let update = ["plugin", "update", CommandLocator.pluginID, "--scope", "user", "--json"]

    private func runClaude(_ cli: URL, _ arguments: [String]) async -> Bool {
        do {
            return ClaudeResult.succeeded(try await runner.run(cli, arguments: arguments, timeout: timeouts.claudeStep))
        } catch {
            return false
        }
    }

    private enum SetupStep { case done, failed, busy }

    /// `/bin/sh <installPath>/setup.sh setup`, the plugin's own installer, in the shared setup
    /// slot. Through `sh`, so a copy that lost its executable bit still runs.
    private func runSetup(of plugin: RegisteredPlugin) async -> SetupStep {
        guard await setup.begin() else { return .busy }
        var succeeded = false
        do {
            let output = try await runner.run(
                URL(fileURLWithPath: "/bin/sh"), arguments: [plugin.setupScript.path, "setup"], timeout: timeouts.setup)
            succeeded = output.exitCode == 0
        } catch {
            succeeded = false
        }
        await setup.end(succeeded: succeeded)
        return succeeded ? .done : .failed
    }

    private func registeredPluginWithSetupScript() -> RegisteredPlugin? {
        guard let plugin = locator.registeredPlugin(), FileManager.default.fileExists(atPath: plugin.setupScript.path) else { return nil }
        return plugin
    }

    private func open(_ url: URL, saying message: String) async -> ActionOutcome {
        await opener.open(url)
            ? ActionOutcome(kind: .info, message: message)
            : ActionOutcome(kind: .failure, message: PluginMessages.couldNotOpen)
    }

    private func failure(_ message: String) -> ActionOutcome {
        ActionOutcome(kind: .failure, message: message)
    }

    // MARK: One at a time

    private func enter() -> Bool {
        lock.withLock {
            if working { return false }
            working = true
            return true
        }
    }

    private func leave() {
        lock.withLock { working = false }
    }
}
