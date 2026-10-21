import Foundation

/// The real app, assembled: the engine client, the install (engine, Claude Code's MCP server and skill),
/// the daily release check, the login item, the remove action. Everything the tests replace with a fake is
/// created here with the real thing, and nowhere else.
@MainActor
final class LiveApp {
    let model: CUABarViewModel
    let maintenance: Maintenance
    private let automaticSetup: AutomaticSetup

    init(model: CUABarViewModel, maintenance: Maintenance, automaticSetup: AutomaticSetup) {
        self.model = model
        self.maintenance = maintenance
        self.automaticSetup = automaticSetup
    }

    static func make(
        quit: @escaping @MainActor () -> Void,
        defaults: UserDefaults = .standard,
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        appVersion: String? = AppVersion.current,
        // The engine inside the app bundle; nil when this does not run from one, and then nothing is installed.
        bundle: BundledEngine? = BundledEngine.locate()
    ) -> LiveApp {
        let locator = CommandLocator(home: home)
        let runner = SystemProcessRunner()
        let setup = SetupActivity()
        let releases = ReleaseChecker(appVersion: appVersion, fetcher: GitHubReleaseFetcher(), defaults: defaults)
        let opener = WorkspaceURLOpener()
        let engine = CodexCUAEngineClient(locator: locator, runner: runner)
        let claude = ClaudeIntegration(home: home, runner: runner)
        let codex = CodexLocator(home: home)
        let actions = LiveSystemActions(
            claude: claude, engine: engine, runner: runner, opener: opener, bundle: bundle, appVersion: appVersion,
            setup: setup, codex: codex)
        let loginItem = LoginItemRegistrar(service: MainAppLoginItem(), defaults: defaults, home: home)
        let loginEnvironment = LoginEnvironmentReader(home: home, runner: runner)
        let pasteboard = DiagnosisPasteboard(base: SystemPasteboard()) {
            "앱: CUA Bar \(appVersion ?? "개발용")\n\(loginItem.line)"
        }
        // One notifier for the model and the release check, so a click on either reaches the model.
        let notifier = SystemNotifier.makeDefault()
        let model = CUABarViewModel(
            engine: engine, appVersion: appVersion, systemActions: actions, pasteboard: pasteboard,
            notifier: notifier, setupActivity: setup,
            claudeInspector: { claude.inspect(launcher: $0, skillSource: bundle?.skillSource, appVersion: appVersion) },
            codexInstalled: { codex.isInstalled() },
            loginItemReading: { loginItem.reading },
            loginEnvironmentReader: { await loginEnvironment.read() },
            appLauncherValue: loginEnvironment.appLauncherValue)
        // An install that changed something is followed by one connection test, when the Codex host is ready.
        actions.setAfterChange { [weak model] in await model?.probeAfterInstall() }
        releases.onNewVersion = { version in
            Task { _ = await notifier.post(.newVersion(version)) }
        }
        let removal = RemovalFlow(
            engine: engine, loginItem: loginItem, claude: claude, quit: quit,
            isSetupRunning: { setup.isRunning || model.inFlight.contains(where: SetupOverlay.runsSetup) },
            onRemoved: { model.stop() })
        let automaticSetup = AutomaticSetup(
            activity: setup, perform: { [weak model] in _ = await model?.perform($0) }, isBundled: bundle != nil,
            codexInstalled: { codex.isInstalled() }, claudeCodeFound: { claude.claudeCodeFound })
        model.afterRead = { await automaticSetup.runWhatWasPutOff(status: $0) }
        return LiveApp(
            model: model,
            maintenance: Maintenance(releases: releases, removal: removal, loginItem: loginItem, opener: opener),
            automaticSetup: automaticSetup)
    }

    /// Everything that starts when the app does, in the background: the login item (first launch
    /// only), reading the status, the daily release check, and the automatic install.
    func start() {
        maintenance.loginItem.registerOnFirstLaunch()
        model.start()
        maintenance.releases.start()
        Task { await automaticSetup.runAtStartup() }
    }

    func stop() {
        model.stop()
        maintenance.releases.stop()
    }
}
