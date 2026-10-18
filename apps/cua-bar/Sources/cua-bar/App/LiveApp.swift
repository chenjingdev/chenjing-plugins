import Foundation

/// The real app, assembled: the engine client, the plugin install and update, the daily release
/// check, the login item, the remove action. Everything the tests replace with a fake is
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
        appVersion: String? = AppVersion.current
    ) -> LiveApp {
        let locator = CommandLocator(home: home)
        let runner = SystemProcessRunner()
        let setup = SetupActivity()
        let releases = ReleaseChecker(appVersion: appVersion, fetcher: GitHubReleaseFetcher(), defaults: defaults)
        let opener = WorkspaceURLOpener()
        let actions = LiveSystemActions(
            locator: locator, claude: ClaudeCLILocator(home: home), runner: runner, opener: opener,
            appVersion: appVersion, setup: setup, newestAppRelease: { await releases.newRelease })
        let engine = CodexCUAEngineClient(locator: locator, runner: runner)
        let loginItem = LoginItemRegistrar(service: MainAppLoginItem(), defaults: defaults, home: home)
        let pasteboard = DiagnosisPasteboard(base: SystemPasteboard()) {
            "앱: CUA Bar \(appVersion ?? "개발용")\n\(loginItem.line)"
        }
        let model = CUABarViewModel(
            engine: engine, appVersion: appVersion, systemActions: actions, pasteboard: pasteboard,
            setupActivity: setup, registeredPluginVersion: { locator.registeredPlugin()?.version })
        let removal = RemovalFlow(
            engine: engine, loginItem: loginItem, quit: quit,
            isSetupRunning: { setup.isRunning || model.inFlight.contains(where: SetupOverlay.runsSetup) },
            onRemoved: { model.stop() })
        let automaticSetup = AutomaticSetup(locate: { locator.locate() }, activity: setup) { _ = await model.perform($0) }
        return LiveApp(
            model: model,
            maintenance: Maintenance(releases: releases, removal: removal, loginItem: loginItem, opener: opener),
            automaticSetup: automaticSetup)
    }

    /// Everything that starts when the app does, in the background: the login item (first launch
    /// only), reading the status, the daily release check, and the automatic setup.
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
