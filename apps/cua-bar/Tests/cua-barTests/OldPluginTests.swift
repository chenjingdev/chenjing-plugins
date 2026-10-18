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

    @Test func theSameVersionMeansTheCommandIsReallyBroken() async throws {
        let rig = try rig(registered: "0.7.0")
        defer { rig.home.remove() }
        await rig.model.refresh()
        let problem = try #require(rig.model.summary.problem)
        #expect(problem.kind == .engineUnreadable)
        #expect(problem.fixLabel == "다시 읽기")
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
        EngineError.timeout, .launchFailed("nope"), .pluginMissing, .setupNeeded(installPath: "/x"), .unsupportedSchema(2),
    ])
    func otherErrorsAreNotTurnedIntoAVersionProblem(error: EngineError) {
        let with = StatusEvaluator.summary(for: error, appVersion: "0.7.0", registeredPluginVersion: "0.5.0")
        #expect(with == StatusEvaluator.summary(for: error))
    }

    @Test(arguments: [(nil, "0.5.0"), ("0.7.0", nil), ("0.7.0", "0.7.0"), ("", "0.5.0"), ("0.7.0", " ")] as [(String?, String?)])
    func withoutTwoDifferentVersionsItIsAReadProblem(app: String?, registered: String?) {
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

    @Test func theMarketplaceIsFoundWhereverTheFileKeepsItsName() throws {
        let home = try TempHome()
        defer { home.remove() }
        let file = home.url.appendingPathComponent(".claude/plugins/known_marketplaces.json")
        #expect(!CommandLocator(home: home.url).knowsMarketplace(), "no file")
        try home.addMarketplace()
        #expect(CommandLocator(home: home.url).knowsMarketplace())
        try home.write(#"{"version": 2, "marketplaces": {"chenjing-plugins": {"source": {}}}}"#, to: file)
        #expect(CommandLocator(home: home.url).knowsMarketplace(), "nested")
        try home.write(#"[{"name": "x"}, {"chenjing-plugins": {}}]"#, to: file)
        #expect(CommandLocator(home: home.url).knowsMarketplace(), "in a list")
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
}
