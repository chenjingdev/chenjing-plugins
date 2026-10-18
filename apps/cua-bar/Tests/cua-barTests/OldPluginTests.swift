import Foundation
import Testing
@testable import cua_bar

/// The plugin registered on this Mac today is 0.5.0, whose `codex-cua` does not know `status`
/// (it exits 2). The card must say the versions differ, with 맞는 판 받기, instead of 다시 읽기 forever.
@MainActor
struct OldPluginTests {
    /// What 0.5.0's command does with `status --json`: argparse rejects it and exits 2.
    private static let oldCommand = """
    #!/bin/sh
    # codex-cua authored command v1
    echo "usage: setup.py [-h] {install,setup,ensure,start,doctor,uninstall}" >&2
    echo "setup.py: error: argument command: invalid choice: 'status'" >&2
    exit 2
    """

    private struct Rig {
        var home: TempHome
        var model: CUABarViewModel
        var system: RecordingSystemActions
    }

    /// The real client, locator and process runner over a stand-in command in a throwaway home.
    private func rig(
        registered: String?, command: String = oldCommand, timeouts: EngineTimeouts = EngineTimeouts(), appVersion: String? = "0.7.0"
    ) throws -> Rig {
        let home = try TempHome()
        try home.writeCommand(command)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: home.command.path)
        if let registered { try home.installPlugin(version: registered) }
        let locator = CommandLocator(home: home.url)
        let system = RecordingSystemActions()
        let model = CUABarViewModel(
            engine: CodexCUAEngineClient(locator: locator, timeouts: timeouts), appVersion: appVersion, systemActions: system,
            pasteboard: RecordingPasteboard(), clock: { Fixtures.now }, calendar: Fixtures.utc, sleep: ManualSleeper().sleep,
            registeredPluginVersion: { locator.registeredPlugin()?.version })
        return Rig(home: home, model: model, system: system)
    }

    // MARK: A stand-in command that exits 2

    @Test func anOldPluginThatCannotAnswerStatusIsAVersionProblemWithItsFixButton() async throws {
        let rig = try rig(registered: "0.5.0")
        defer { rig.home.remove() }
        await rig.model.refresh()
        let problem = try #require(rig.model.summary.problem)
        #expect(problem.kind == .versionMismatch)
        #expect(problem.title == "앱과 플러그인 판이 달라요")
        #expect(problem.nextStep == "앱 0.7.0 · 플러그인 0.5.0 — 맞는 판을 받아 주세요")
        #expect(problem.fix == .matchPluginVersion)
        #expect(problem.fixLabel == "맞는 판 받기")
        #expect(rig.model.summary.icon == .problem)
        #expect(rig.model.summary.tooltip == "CUA 문제 · 앱과 플러그인 판이 달라요")
        #expect(rig.model.content == nil)
    }

    @Test func pressingItGoesToTheSystemAction() async throws {
        let rig = try rig(registered: "0.5.0")
        defer { rig.home.remove() }
        await rig.model.refresh()
        await rig.model.perform(try #require(rig.model.summary.fix))
        #expect(rig.system.calls == ["matchPluginVersion"])
    }

    @Test func theSameVersionMeansTheCommandIsOldOrBrokenAndSetupFixesIt() async throws {
        // The registry already says 0.7.0 (an update, or the marketplace updating by itself), but
        // `~/.local/bin/codex-cua` is still 0.5.0's, which exits 2 on `status`.
        let rig = try rig(registered: "0.7.0")
        defer { rig.home.remove() }
        await rig.model.refresh()
        let problem = try #require(rig.model.summary.problem)
        #expect(problem.kind == .setupIncomplete)
        #expect(problem.title == "연결 명령이 옛 판이거나 깨졌어요")
        #expect(problem.nextStep == "고치기를 누르면 연결을 다시 설정해요")
        #expect(problem.fix == .runSetup)
        #expect(problem.fixLabel == "고치기")
        #expect(rig.model.summary.warning == nil, "nothing the command printed")
        #expect(rig.model.summary.icon == .problem)
        #expect(rig.model.content == nil)
    }

    @Test func withoutAKnownRegisteredVersionItStaysAReadProblem() async throws {
        let noRegistry = try rig(registered: nil)
        defer { noRegistry.home.remove() }
        await noRegistry.model.refresh()
        #expect(noRegistry.model.summary.problem?.kind == .engineUnreadable)

        let noVersion = try rig(registered: nil)
        defer { noVersion.home.remove() }
        try noVersion.home.installPlugin(version: nil)
        await noVersion.model.refresh()
        #expect(noVersion.model.summary.problem?.kind == .engineUnreadable)
    }

    @Test func aNewerPluginThatFailsIsAlsoAVersionProblem() async throws {
        let rig = try rig(registered: "0.9.0")
        defer { rig.home.remove() }
        await rig.model.refresh()
        #expect(rig.model.summary.problem?.kind == .versionMismatch)
        #expect(rig.model.summary.problem?.nextStep == "앱 0.7.0 · 플러그인 0.9.0 — 맞는 판을 받아 주세요")
    }

    @Test func unreadableOutputOfAnOldPluginCountsToo() async throws {
        let rig = try rig(registered: "0.5.0", command: "#!/bin/sh\n# codex-cua authored command v1\necho 'not json at all'\n")
        defer { rig.home.remove() }
        await rig.model.refresh()
        #expect(rig.model.summary.problem?.kind == .versionMismatch)
    }

    @Test func aTimeoutSaysNothingAboutVersions() async throws {
        let rig = try rig(
            registered: "0.5.0", command: "#!/bin/sh\n# codex-cua authored command v1\nexec /bin/sleep 30\n",
            timeouts: EngineTimeouts(status: .milliseconds(400)))
        defer { rig.home.remove() }
        await rig.model.refresh()
        #expect(rig.model.summary.problem?.kind == .engineUnreadable)
    }

    @Test func aStatusThatWorksIsNotSecondGuessedByTheRegistry() async throws {
        let path = try #require(Bundle.module.url(forResource: "status-ready", withExtension: "json", subdirectory: "Fixtures")).path
        // The command answers fine and says 0.7.0; the registry still says 0.5.0 (a stale record).
        let rig = try rig(registered: "0.5.0", command: "#!/bin/sh\n# codex-cua authored command v1\ncat '\(path)'\n")
        defer { rig.home.remove() }
        await rig.model.refresh()
        #expect(rig.model.summary.problem == nil)
        #expect(rig.model.content != nil)
    }

    @Test func theFirstFailureShowsAtOnceButAnEstablishedAnswerWaitsForTwo() async throws {
        // Same rule as every read problem: one slow or odd answer does not flip a working icon.
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let model = CUABarViewModel(
            engine: engine, appVersion: "0.7.0", clock: { Fixtures.now }, calendar: Fixtures.utc, sleep: ManualSleeper().sleep,
            registeredPluginVersion: { "0.5.0" })
        await model.refresh()
        #expect(model.summary.icon == .ready)
        engine.setStatusError(.commandFailed(exitCode: 2, message: "usage"))
        await model.refresh()
        #expect(model.summary.icon == .ready)
        await model.refresh()
        #expect(model.summary.problem?.kind == .versionMismatch)

        let fresh = CUABarViewModel(
            engine: engine, appVersion: "0.7.0", clock: { Fixtures.now }, calendar: Fixtures.utc, sleep: ManualSleeper().sleep,
            registeredPluginVersion: { "0.5.0" })
        await fresh.refresh()
        #expect(fresh.summary.problem?.kind == .versionMismatch, "no good answer yet: shown at once")
    }

    @Test func withoutTheRegistryClosureNothingChangesFromBefore() async throws {
        let engine = FakeEngineClient()
        engine.setStatusError(.commandFailed(exitCode: 2, message: "usage"))
        let model = CUABarViewModel(engine: engine, appVersion: "0.7.0", clock: { Fixtures.now }, calendar: Fixtures.utc, sleep: ManualSleeper().sleep)
        await model.refresh()
        #expect(model.summary.problem?.kind == .engineUnreadable)
    }

    // MARK: Updating away from an old command

    /// Records what the engine client runs and runs it for real: here only stand-ins in a throwaway home.
    private final class RecordingRunner: ProcessRunning, @unchecked Sendable {
        private let lock = NSLock()
        private var recorded: [StepRunner.Call] = []
        private let base = SystemProcessRunner()

        var calls: [StepRunner.Call] { lock.withLock { recorded } }

        func run(_ executable: URL, arguments: [String], timeout: Duration) async throws -> ProcessOutput {
            lock.withLock { recorded.append(.init(executable: executable.path, arguments: arguments, timeout: timeout)) }
            return try await base.run(executable, arguments: arguments, timeout: timeout)
        }
    }

    private struct UpdateRig {
        var home: TempHome
        var model: CUABarViewModel
        var engineRunner: RecordingRunner

        /// The folder `claude plugin update` registers 0.7.0 in.
        var newFolder: URL { home.url.appendingPathComponent(".claude/plugins/cache/chenjing-plugins/cua/0.7.0") }
    }

    /// 0.5.0 is registered and its command cannot answer `status`. `claude plugin update` (a
    /// stand-in) registers 0.7.0 in a new folder, and the setup at the end of that flow fails, so
    /// the old command stays. The new folder's `setup.sh` is a stand-in that puts a command that
    /// answers `status` in place, as 0.7.0's setup replaces the old command.
    private func updateRig() throws -> UpdateRig {
        let home = try TempHome()
        try home.writeCommand(Self.oldCommand)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: home.command.path)
        try home.installPlugin(version: "0.5.0")
        let answer = try #require(Bundle.module.url(forResource: "status-ready", withExtension: "json", subdirectory: "Fixtures")).path
        let command = home.command.path
        let newSetup = """
        #!/bin/sh
        cat > '\(command)' <<'EOF'
        #!/bin/sh
        # codex-cua authored command v1
        cat '\(answer)'
        EOF
        chmod 755 '\(command)'
        """
        let systemRunner = StepRunner { call in
            if call.isClaude, call.verb == "plugin update" {
                let folder = try home.installPlugin(version: "0.7.0")
                try home.write(newSetup, to: folder.appendingPathComponent("setup.sh"))
            }
            // The flow's own setup fails, as when pip cannot install anything: the old command stays.
            return call.executable == "/bin/sh" ? StepRunner.failed() : StepRunner.ok()
        }
        let claude = home.url.appendingPathComponent(".local/bin/claude").path
        let setup = SetupActivity()
        let locator = CommandLocator(home: home.url)
        let actions = LiveSystemActions(
            locator: locator, claude: ClaudeCLILocator(home: home.url, isExecutableFile: { $0 == claude }),
            runner: systemRunner, opener: FakeOpener(), appVersion: "0.7.0", setup: setup)
        let engineRunner = RecordingRunner()
        let model = CUABarViewModel(
            engine: CodexCUAEngineClient(locator: locator, runner: engineRunner), appVersion: "0.7.0", systemActions: actions,
            pasteboard: RecordingPasteboard(), clock: { Fixtures.now }, calendar: Fixtures.utc, bannerDuration: .seconds(3600),
            sleep: ManualSleeper().sleep, setupActivity: setup, registeredPluginVersion: { locator.registeredPlugin()?.version })
        return UpdateRig(home: home, model: model, engineRunner: engineRunner)
    }

    @Test func anUpdateWhoseSetupFailedStillOffersTryAgainAfterTheNextRead() async throws {
        let rig = try updateRig()
        defer { rig.home.remove() }
        await rig.model.refresh()
        #expect(rig.model.summary.fix == .matchPluginVersion, "0.5.0 against the app's 0.7.0")

        let outcome = await rig.model.perform(.matchPluginVersion)
        #expect(outcome == ActionOutcome(kind: .failure, message: PluginMessages.setupFailed))
        #expect(rig.model.summary.headline == "연결 설정에 실패했어요")
        #expect(rig.model.summary.fixLabel == "다시 하기")

        // The next read: 0.7.0 is registered now, and the old command still exits 2.
        await rig.model.refresh()
        let problem = try #require(rig.model.summary.problem)
        #expect(problem.kind == .setupIncomplete)
        #expect(problem.title == "연결 설정에 실패했어요")
        #expect(problem.fix == .runSetup)
        #expect(problem.fixLabel == "다시 하기")
        #expect(rig.model.summary.warning == nil)
    }

    @Test func tryAgainRunsTheNewFoldersSetupScriptNeverTheOldCommandsSetup() async throws {
        let rig = try updateRig()
        defer { rig.home.remove() }
        await rig.model.refresh()
        await rig.model.perform(.matchPluginVersion)
        await rig.model.refresh()
        let retry = try #require(rig.model.summary.fix)
        #expect(retry == .runSetup)

        let outcome = await rig.model.perform(retry)
        let setups = rig.engineRunner.calls.filter { $0.arguments.contains("setup") }
        #expect(setups == [.init(
            executable: "/bin/sh", arguments: [rig.newFolder.appendingPathComponent("setup.sh").path, "setup"],
            timeout: EngineTimeouts().setup)])
        #expect(
            rig.engineRunner.calls.allSatisfy { $0.executable != rig.home.command.path || $0.arguments == ["status", "--json"] },
            "the old command is only ever asked for its status")
        #expect(outcome == ActionOutcome(kind: .success, message: "연결 설정을 마쳤어요"))
        #expect(rig.model.summary.problem == nil, "the command the new setup put in place answers")
        #expect(rig.model.content != nil)
    }

    // MARK: The evaluator's rule

    @Test(arguments: [
        EngineError.commandFailed(exitCode: 2, message: "usage"), .commandFailed(exitCode: 1, message: ""), .invalidOutput("EngineStatus"),
    ])
    func aFailingCommandWithADifferentRegisteredVersionIsTheVersionProblem(error: EngineError) {
        let summary = StatusEvaluator.summary(for: error, appVersion: "0.7.0", registeredPluginVersion: "0.5.0")
        #expect(summary.problem?.kind == .versionMismatch)
        #expect(summary.problem?.fix == .matchPluginVersion)
        #expect(summary.problem?.fixLabel == "맞는 판 받기")
        #expect(summary.problem?.nextStep == "앱 0.7.0 · 플러그인 0.5.0 — 맞는 판을 받아 주세요")
    }

    @Test func theTextIsTheSameAsTheOneAStatusThatWorkedWouldMake() throws {
        var status = try Fixtures.status("status-ready")
        status.plugin.version = "0.5.0"
        let fromStatus = StatusEvaluator.evaluate(status, appVersion: "0.7.0")
        let fromFailure = StatusEvaluator.summary(for: .commandFailed(exitCode: 2, message: ""), appVersion: "0.7.0", registeredPluginVersion: "0.5.0")
        #expect(fromFailure == fromStatus)
    }

    @Test(arguments: [
        EngineError.commandFailed(exitCode: 2, message: "usage"), .commandFailed(exitCode: 1, message: "SECRET-STDERR"), .invalidOutput("EngineStatus"),
    ])
    func aFailingCommandWithTheSameRegisteredVersionIsTheSetupProblem(error: EngineError) {
        let summary = StatusEvaluator.summary(for: error, appVersion: "0.7.0", registeredPluginVersion: "0.7.0")
        #expect(summary.problem?.kind == .setupIncomplete)
        #expect(summary.problem?.fix == .runSetup)
        #expect(summary.problem?.fixLabel == "고치기")
        #expect(summary.warning == nil)
        #expect(!summary.headline.contains("SECRET") && !summary.nextStep.contains("SECRET"))
    }

    @Test(arguments: [
        EngineError.timeout, .launchFailed("nope"), .pluginMissing, .setupNeeded(installPath: "/x"), .unsupportedSchema(2),
    ])
    func otherErrorsAreNotTurnedIntoAVersionOrSetupProblem(error: EngineError) {
        for registered in ["0.5.0", "0.7.0"] {
            let with = StatusEvaluator.summary(for: error, appVersion: "0.7.0", registeredPluginVersion: registered)
            #expect(with == StatusEvaluator.summary(for: error))
        }
    }

    @Test(arguments: [
        EngineError.commandFailed(exitCode: 1, message: "SECRET-STDERR"), .invalidOutput("EngineStatus"),
    ])
    func aFailingCommandWithoutAUsablePluginIsThePluginProblem(error: EngineError) {
        let missing = StatusEvaluator.summary(for: error, appVersion: "0.7.0", registeredPluginVersion: nil, plugin: .absent)
        #expect(missing.problem?.kind == .pluginMissing)
        #expect(missing.problem?.fix == .installPlugin)
        #expect(missing.problem?.fixLabel == "설치")
        #expect(missing == StatusEvaluator.summary(for: .pluginMissing))
        let broken = StatusEvaluator.summary(for: error, appVersion: "0.7.0", registeredPluginVersion: "0.7.0", plugin: .broken)
        #expect(broken.problem?.kind == .pluginMissing)
        #expect(broken.problem?.title == "Claude 플러그인 폴더가 없어요")
        #expect(broken.problem?.fix == .installPlugin)
        #expect(broken.problem?.fixLabel == "다시 설치")
        #expect(broken.tooltip == "CUA 문제 · Claude 플러그인 폴더가 없어요")
        for plugin in [PluginPresence.unknown, .present] {
            #expect(StatusEvaluator.summary(for: error, appVersion: "0.7.0", registeredPluginVersion: nil, plugin: plugin).problem?.kind
                == .engineUnreadable)
        }
    }

    @Test func aTimeoutOrACommandThatCannotStartSaysNothingAboutThePlugin() {
        for error in [EngineError.timeout, .launchFailed("nope")] {
            #expect(StatusEvaluator.summary(for: error, plugin: .broken) == StatusEvaluator.summary(for: error))
        }
    }

    @Test(arguments: [(nil, "0.5.0"), (nil, nil), ("0.7.0", nil), ("", "0.5.0"), ("0.7.0", " ")] as [(String?, String?)])
    func withoutBothVersionsItIsAReadProblem(app: String?, registered: String?) {
        let summary = StatusEvaluator.summary(for: .commandFailed(exitCode: 2, message: "usage"), appVersion: app, registeredPluginVersion: registered)
        #expect(summary.problem?.kind == .engineUnreadable)
        #expect(summary.problem?.fixLabel == "다시 읽기")
    }

    // MARK: What the locator reads from the registry

    @Test func theLocatorReturnsTheRegisteredPluginAndItsVersion() throws {
        let home = try TempHome()
        defer { home.remove() }
        let install = try home.installPlugin(version: "0.5.0")
        let plugin = try #require(CommandLocator(home: home.url).registeredPlugin())
        #expect(plugin == RegisteredPlugin(installPath: install, version: "0.5.0"))
        #expect(plugin.setupScript == install.appendingPathComponent("setup.sh"))
    }

    @Test func aRecordWithoutAUsableVersionHasNone() throws {
        let home = try TempHome()
        defer { home.remove() }
        try home.installPlugin(version: nil)
        #expect(CommandLocator(home: home.url).registeredPlugin()?.version == nil)
        try home.write(#"{"plugins": {"cua@chenjing-plugins": [{"scope": "user", "installPath": "/x", "version": "  "}]}}"#, to: home.url.appendingPathComponent(".claude/plugins/installed_plugins.json"))
        #expect(CommandLocator(home: home.url).registeredPlugin()?.version == nil)
        try home.write(#"{"plugins": {"cua@chenjing-plugins": [{"scope": "user", "installPath": "/x", "version": 7}]}}"#, to: home.url.appendingPathComponent(".claude/plugins/installed_plugins.json"))
        #expect(CommandLocator(home: home.url).registeredPlugin()?.version == nil)
    }

    @Test func onlyTheUserScopeRecordIsReadAndAMissingOrBrokenRegistryHasNone() throws {
        let home = try TempHome()
        defer { home.remove() }
        #expect(CommandLocator(home: home.url).registeredPlugin() == nil)
        try home.installPlugin(scope: "project", version: "0.5.0")
        #expect(CommandLocator(home: home.url).registeredPlugin() == nil)
        try home.write("not json", to: home.url.appendingPathComponent(".claude/plugins/installed_plugins.json"))
        #expect(CommandLocator(home: home.url).registeredPlugin() == nil)
    }

    @Test func theVersionIsKnownEvenWhenTheFolderIsGone() throws {
        let home = try TempHome()
        defer { home.remove() }
        try home.installPlugin(createFolder: false, version: "0.5.0")
        #expect(CommandLocator(home: home.url).registeredPlugin()?.version == "0.5.0")
        #expect(CommandLocator(home: home.url).locate() == .pluginMissing, "but it is still not an installed plugin")
    }

    // MARK: The marketplace file

    @Test func theMarketplaceIsAKeyAtTheTopOfTheFile() throws {
        let home = try TempHome()
        defer { home.remove() }
        let file = home.url.appendingPathComponent(".claude/plugins/known_marketplaces.json")
        #expect(!CommandLocator(home: home.url).knowsMarketplace(), "no file")
        try home.addMarketplace()
        #expect(CommandLocator(home: home.url).knowsMarketplace())
        try home.write(#"{"claude-plugins-official": {"source": {}}, "chenjing-plugins": {"source": {}}}"#, to: file)
        #expect(CommandLocator(home: home.url).knowsMarketplace(), "among others")
        try home.write(#"{"version": 2, "marketplaces": {"chenjing-plugins": {"source": {}}}}"#, to: file)
        #expect(!CommandLocator(home: home.url).knowsMarketplace(), "a name further down is not a marketplace of this file")
        try home.write(#"{"other": {"source": {"chenjing-plugins": {}}}}"#, to: file)
        #expect(!CommandLocator(home: home.url).knowsMarketplace(), "nor is a key inside an entry")
        try home.write(#"[{"name": "x"}, {"chenjing-plugins": {}}]"#, to: file)
        #expect(!CommandLocator(home: home.url).knowsMarketplace(), "a list is not the file's shape")
    }

    @Test func otherMarketplacesOrABrokenFileAreNotThisOne() throws {
        let home = try TempHome()
        defer { home.remove() }
        let file = home.url.appendingPathComponent(".claude/plugins/known_marketplaces.json")
        try home.addMarketplace("claude-plugins-official")
        #expect(!CommandLocator(home: home.url).knowsMarketplace())
        try home.write(#"{"other": {"name": "chenjing-plugins"}}"#, to: file)
        #expect(!CommandLocator(home: home.url).knowsMarketplace(), "a value is not a name")
        try home.write("not json", to: file)
        #expect(!CommandLocator(home: home.url).knowsMarketplace())
        try home.write("{}", to: file)
        #expect(!CommandLocator(home: home.url).knowsMarketplace())
    }

    // MARK: What a setup left behind

    @Test func whatASetupLeftIsSeenTheWayThePluginsRemoverSeesIt() throws {
        let home = try TempHome()
        defer { home.remove() }
        let locator = CommandLocator(home: home.url)
        #expect(!locator.hasSupportInstallation(), "no folder")
        try FileManager.default.createDirectory(at: locator.supportBindingURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        #expect(!locator.hasSupportInstallation(), "a folder without its binding")
        try home.addSupportInstallation()
        #expect(locator.hasSupportInstallation())
        try FileManager.default.removeItem(at: locator.supportBindingURL)
        try FileManager.default.createSymbolicLink(atPath: locator.supportBindingURL.path, withDestinationPath: "/nonexistent/source.json")
        #expect(locator.hasSupportInstallation(), "a dangling link makes the remover refuse; it is not nothing")
    }
}
