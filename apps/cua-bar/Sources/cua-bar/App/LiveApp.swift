import Foundation

/// The real app, assembled: the engine client, the install (engine, Claude Code's MCP server and skill),
/// the updater (it looks for a newer version at start and once a day, and replaces the app by itself), the login
/// item, the remove action. Everything the tests replace with a fake is created here with the real thing, and
/// nowhere else.
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
        bundle: BundledEngine? = BundledEngine.locate(),
        // The app bundle this may replace: the one it runs from, when this is the official build (signed by the team's
        // Developer ID). nil for a development build, a local one signed ad hoc among them: no update is looked for.
        appBundle: URL? = UpdateSource.replaceableBundle()
    ) -> LiveApp {
        let locator = CommandLocator(home: home)
        let runner = SystemProcessRunner()
        let setup = SetupActivity()
        let opener = WorkspaceURLOpener()
        let updateNotice = UpdateNotice(home: home)
        let transport = SiteUpdateTransport()
        let installer = appBundle.map {
            UpdateInstaller(
                transport: transport, runner: runner, launcher: DetachedProcessLauncher(), bundleURL: $0,
                processID: ProcessInfo.processInfo.processIdentifier, home: home, notice: updateNotice)
        }
        let updater = AppUpdater(
            appVersion: appVersion, transport: transport, installer: installer, defaults: defaults, quit: quit)
        let engine = CodexCUAEngineClient(locator: locator, runner: runner)
        let claude = ClaudeIntegration(home: home, runner: runner)
        let codex = CodexLocator(home: home)
        // One notifier for the model, the updater and the install, so a click on any of them reaches the model.
        let notifier = SystemNotifier.makeDefault()
        let actions = LiveSystemActions(
            claude: claude, engine: engine, runner: runner, opener: opener, bundle: bundle, appVersion: appVersion,
            setup: setup, codex: codex, updateNotice: updateNotice, announce: { await notifier.post($0) })
        let loginItem = LoginItemRegistrar(service: MainAppLoginItem(), defaults: defaults, home: home)
        let pasteboard = DiagnosisPasteboard(base: SystemPasteboard()) {
            "앱: CUA Bar \(appVersion ?? "개발용")\n\(loginItem.line)" + (updater.diagnosisLine.map { "\n" + $0 } ?? "")
        }
        let model = CUABarViewModel(
            engine: engine, appVersion: appVersion, systemActions: actions, pasteboard: pasteboard,
            notifier: notifier, setupActivity: setup,
            claudeInspector: { claude.inspect(launcher: $0, skillSource: bundle?.skillSource, appVersion: appVersion) },
            codexInstalled: { codex.isInstalled() })
        updater.onFailure = { version in
            Task { _ = await notifier.post(.updateFailed(version)) }
        }
        let removal = RemovalFlow(
            engine: engine, loginItem: loginItem, claude: claude, quit: quit,
            isSetupRunning: { setup.isRunning || model.inFlight.contains(where: SetupOverlay.runsSetup) },
            onRemoved: { model.stop() })
        let automaticSetup = AutomaticSetup(
            activity: setup, perform: { [weak model] in _ = await model?.perform($0) }, isBundled: bundle != nil,
            codexInstalled: { codex.isInstalled() }, claudeCodeFound: { claude.claudeCodeFound })
        // Never while someone looks at the popover, and never beside a tidy-up, a setup or the removal (R8).
        updater.canReplaceNow = { [weak model] in (model?.isQuietForUpdate ?? false) && !removal.isRunning }
        // After each status read, the update the way was not free for goes ahead as soon as it is.
        model.afterRead = {
            await automaticSetup.runWhatWasPutOff()
            await updater.applyIfPossible()
        }
        return LiveApp(
            model: model,
            maintenance: Maintenance(updater: updater, removal: removal, loginItem: loginItem, opener: opener),
            automaticSetup: automaticSetup)
    }

    /// Everything that starts when the app does, in the background: the login item (first launch
    /// only), reading the status, the look for a newer version, and the automatic install.
    func start() {
        maintenance.loginItem.registerOnFirstLaunch()
        model.start()
        maintenance.updater.start()
        Task { await automaticSetup.runAtStartup() }
    }

    func stop() {
        model.stop()
        maintenance.updater.stop()
    }
}
