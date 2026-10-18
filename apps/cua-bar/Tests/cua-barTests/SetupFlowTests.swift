import Foundation
import Testing
@testable import cua_bar

/// Setup as the person sees it: run by itself at start-up once, said on the status card while it
/// runs, a fixed line and 다시 하기 after a failure, never started by a status read.
@MainActor
struct SetupFlowTests {
    private let notSetUp = EngineError.setupNeeded(installPath: "/x/cua/0.7.0")

    private func makeModel(
        _ engine: FakeEngineClient,
        activity: SetupActivity = SetupActivity(),
        appVersion: String? = "0.7.0",
        systemActions: any SystemActions = RecordingSystemActions(),
        registeredPluginVersion: @escaping @Sendable () -> String? = { nil }
    ) -> CUABarViewModel {
        CUABarViewModel(
            engine: engine, appVersion: appVersion, systemActions: systemActions, pasteboard: RecordingPasteboard(),
            clock: { Fixtures.now }, calendar: Fixtures.utc, bannerDuration: .seconds(3600), sleep: ManualSleeper().sleep,
            setupActivity: activity, registeredPluginVersion: registeredPluginVersion)
    }

    private func automaticSetup(
        _ model: CUABarViewModel, _ activity: SetupActivity, location: CommandLocation
    ) -> AutomaticSetup {
        AutomaticSetup(locate: { location }, activity: activity) { _ = await model.perform($0) }
    }

    private func waitUntil(_ timeout: Double = 30, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { try? await Task.sleep(for: .milliseconds(2)) }
        return condition()
    }

    private var installedNotSetUp: CommandLocation { .installedNotSetUp(installPath: URL(fileURLWithPath: "/x/cua/0.7.0")) }

    // MARK: Automatic setup

    @Test func setupRunsByItselfAtStartWhenThePluginIsInstalledButNotSetUp() async {
        let engine = FakeEngineClient()
        let activity = SetupActivity()
        let model = makeModel(engine, activity: activity)
        let auto = automaticSetup(model, activity, location: installedNotSetUp)
        await auto.runAtStartup()
        #expect(engine.calls.first == .runSetup)
        #expect(engine.calls == [.runSetup, .status], "the setup, then a read of what it did")
    }

    @Test func itRunsAtMostOncePerAppRun() async {
        let engine = FakeEngineClient()
        let activity = SetupActivity()
        let model = makeModel(engine, activity: activity)
        let auto = automaticSetup(model, activity, location: installedNotSetUp)
        await auto.runAtStartup()
        await auto.runAtStartup()
        await automaticSetup(model, activity, location: installedNotSetUp).runAtStartup()
        #expect(engine.calls.filter { $0 == .runSetup }.count == 1)
    }

    @Test func itOnlyRunsWhenThePluginIsInstalledWithoutItsCommand() async {
        let engine = FakeEngineClient()
        let activity = SetupActivity()
        let model = makeModel(engine, activity: activity)
        await automaticSetup(model, activity, location: .ready(URL(fileURLWithPath: "/x/codex-cua"))).runAtStartup()
        await automaticSetup(model, activity, location: .pluginMissing).runAtStartup()
        #expect(engine.calls.isEmpty)
        #expect(!activity.automaticRunClaimed, "an attempt that did not happen is not used up")
        await automaticSetup(model, activity, location: installedNotSetUp).runAtStartup()
        #expect(engine.calls.filter { $0 == .runSetup }.count == 1)
    }

    @Test func aFailedAutomaticRunIsNotTriedAgainByItself() async {
        let engine = FakeEngineClient()
        engine.setStatusError(notSetUp) // still not set up afterwards
        engine.configure { $0.actionError = .commandFailed(exitCode: 1, message: "boom") }
        let activity = SetupActivity()
        let model = makeModel(engine, activity: activity)
        let auto = automaticSetup(model, activity, location: installedNotSetUp)
        await auto.runAtStartup()
        await auto.runAtStartup()
        #expect(engine.calls.filter { $0 == .runSetup }.count == 1)
        #expect(activity.phase == .failed)
        #expect(model.summary.fixLabel == "다시 하기", "only a click tries again")
    }

    @Test func aStatusReadNeverStartsSetupOrAnyOtherStep() async throws {
        let engine = FakeEngineClient()
        let system = RecordingSystemActions()
        let sleeper = ManualSleeper()
        let model = CUABarViewModel(
            engine: engine, appVersion: "0.7.0", systemActions: system, clock: { Fixtures.now }, calendar: Fixtures.utc,
            sleep: sleeper.sleep, registeredPluginVersion: { "0.5.0" })
        let problems: [EngineError] = [
            notSetUp, .pluginMissing, .unsupportedSchema(2), .timeout, .commandFailed(exitCode: 2, message: "usage"), .invalidOutput("EngineStatus"),
        ]
        for error in problems {
            engine.setStatusError(error)
            for _ in 0..<3 { await model.refresh() }
        }
        model.start()
        #expect(await waitUntil { sleeper.requestedDurations.count == 1 })
        #expect(sleeper.releaseAll() == 1)
        #expect(await waitUntil { sleeper.requestedDurations.count == 2 })
        model.stop()
        #expect(engine.calls.allSatisfy { $0 == .status }, "reads only: \(engine.calls)")
        #expect(system.calls.isEmpty)
    }

    // MARK: The card while it runs, and after it fails

    @Test func whileSetupRunsTheCardSaysSoInsteadOfShowingAProblem() async {
        let engine = FakeEngineClient()
        engine.setStatusError(notSetUp)
        let gate = AsyncGate()
        engine.configure { $0.actionGate = gate }
        defer { gate.open() }
        let activity = SetupActivity()
        let model = makeModel(engine, activity: activity)
        await model.refresh()
        #expect(model.summary.problem?.kind == .setupIncomplete, "before it starts: the plain problem")
        #expect(model.summary.fixLabel == "고치기")

        let running = Task { await automaticSetup(model, activity, location: installedNotSetUp).runAtStartup() }
        #expect(await waitUntil { engine.calls.contains(.runSetup) })
        #expect(model.summary.headline == "연결을 설정하는 중")
        #expect(model.summary.problem == nil, "not a problem")
        #expect(model.summary.fix == nil)
        #expect(model.summary.icon == .working)
        #expect(model.summary.tooltip == "CUA 설정 중 · 연결을 설정하는 중")
        await model.refresh() // a status read while it runs does not bring the problem back
        #expect(model.summary.headline == "연결을 설정하는 중")

        gate.open()
        await running.value
        engine.setStatus(EngineStatus())
        await model.refresh()
        #expect(model.summary.problem == nil)
        #expect(model.summary.headline != "연결을 설정하는 중")
        #expect(activity.phase == .idle)
    }

    @Test func afterAFailureTheCardHasOneFixedLineAndATryAgainButton() async {
        let engine = FakeEngineClient()
        engine.setStatusError(notSetUp)
        engine.configure { $0.actionError = .commandFailed(exitCode: 1, message: "SECRET-STDERR /Users/someone/token=abc") }
        let activity = SetupActivity()
        let model = makeModel(engine, activity: activity)
        await model.refresh()
        await automaticSetup(model, activity, location: installedNotSetUp).runAtStartup()

        let problem = model.summary.problem
        #expect(problem?.kind == .setupIncomplete)
        #expect(model.summary.headline == "연결 설정에 실패했어요")
        #expect(model.summary.fix == .runSetup)
        #expect(model.summary.fixLabel == "다시 하기")
        #expect(model.summary.icon == .problem)
        #expect(model.summary.tooltip == "CUA 문제 · 연결 설정에 실패했어요")
        let shown = [model.summary.headline, model.summary.nextStep, model.summary.warning ?? "", model.banner?.outcome.message ?? ""]
        #expect(shown.allSatisfy { !$0.contains("SECRET") && !$0.contains("token") }, "never what the command printed")
        #expect(model.banner?.outcome == ActionOutcome(kind: .failure, message: "연결 설정에 실패했어요"))
    }

    @Test func pressingTryAgainRunsItOnceMoreAndASuccessClearsTheFailure() async throws {
        let engine = FakeEngineClient()
        engine.setStatusError(notSetUp)
        engine.configure { $0.actionError = .commandFailed(exitCode: 1, message: "boom") }
        let activity = SetupActivity()
        let model = makeModel(engine, activity: activity)
        await model.refresh()
        await automaticSetup(model, activity, location: installedNotSetUp).runAtStartup()
        let retry = try #require(model.summary.fix)

        engine.configure { $0.actionError = nil }
        engine.setStatus(EngineStatus())
        let outcome = await model.perform(retry)
        #expect(outcome == ActionOutcome(kind: .success, message: "연결 설정을 마쳤어요"))
        #expect(engine.calls.filter { $0 == .runSetup }.count == 2, "the click is a second run, allowed")
        #expect(activity.phase == .idle)
        #expect(model.summary.problem == nil)
    }

    @Test func aFailureIsForgottenOnceTheSetupProblemIsGone() async {
        let engine = FakeEngineClient()
        engine.setStatusError(notSetUp)
        engine.configure { $0.actionError = .commandFailed(exitCode: 1, message: "boom") }
        let activity = SetupActivity()
        let model = makeModel(engine, activity: activity)
        await model.refresh()
        await automaticSetup(model, activity, location: installedNotSetUp).runAtStartup()
        #expect(model.summary.fixLabel == "다시 하기")

        engine.setStatus(EngineStatus()) // someone fixed it by hand
        await model.refresh()
        #expect(activity.phase == .idle)
        engine.setStatusError(notSetUp) // and later it breaks again
        await model.refresh()
        #expect(model.summary.fixLabel == "고치기", "a new problem, not the old failure")
        #expect(model.summary.headline == "연결 설정이 아직 안 됐어요")
    }

    @Test func theOverlayLeavesEveryOtherCardAlone() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-problem"))
        let activity = SetupActivity()
        let model = makeModel(engine, activity: activity)
        await model.refresh()
        let before = model.summary
        #expect(before.problem?.kind == .codexWithoutHost)
        _ = activity.begin()
        #expect(model.summary == before, "a running setup is no reason to hide an unrelated problem")
        activity.end(succeeded: false)
        #expect(model.summary == before)
    }

    @Test func aSetupFixButtonShownByAWorkingStatusIsAlsoCoveredWhileItRuns() async throws {
        // The command exists but the wrapper is broken: the card says "고치기" and, once pressed, that it is setting up.
        var status = try Fixtures.status("status-ready")
        status.setup.wrapper = "broken"
        let engine = FakeEngineClient(status: status)
        let gate = AsyncGate()
        engine.configure { $0.actionGate = gate }
        defer { gate.open() }
        let model = makeModel(engine)
        await model.refresh()
        #expect(model.summary.fixLabel == "고치기")
        let running = Task { await model.perform(.runSetup) }
        #expect(await waitUntil { engine.calls.contains(.runSetup) })
        #expect(model.summary.headline == "연결을 설정하는 중")
        gate.open()
        _ = await running.value
    }

    // MARK: One at a time

    @Test func aSetupAlreadyRunningElsewhereTakesTheSlotSoThePressDoesNothing() async {
        let engine = FakeEngineClient()
        let activity = SetupActivity()
        let model = makeModel(engine, activity: activity)
        #expect(activity.begin(), "an install's own setup step is running")
        let outcome = await model.perform(.runSetup)
        #expect(outcome == ActionOutcome(kind: .info, message: "이미 하는 중이에요"))
        #expect(!engine.calls.contains(.runSetup))
        #expect(activity.phase == .running, "and the other keeps its slot")
    }

    @Test func theSlotIsFreeAgainAfterEveryRun() async {
        let engine = FakeEngineClient()
        let activity = SetupActivity()
        let model = makeModel(engine, activity: activity)
        await model.perform(.runSetup)
        await model.perform(.runSetup)
        #expect(engine.calls.filter { $0 == .runSetup }.count == 2)
        #expect(activity.phase == .idle)
    }

    // MARK: An install or update shows the same card

    @Test func whileAnInstallsSetupRunsTheCardSaysSettingUp() async throws {
        let home = try TempHome()
        defer { home.remove() }
        let gate = AsyncGate()
        let runner = StepRunner(gateFor: { $0.executable == "/bin/sh" ? gate : nil }) { call in
            if call.isClaude, call.arguments.contains("install") { try home.installPlugin(version: "0.7.0") }
            return StepRunner.ok()
        }
        defer { gate.open() }
        let activity = SetupActivity()
        let claude = home.url.appendingPathComponent(".local/bin/claude").path
        let actions = LiveSystemActions(
            locator: CommandLocator(home: home.url), claude: ClaudeCLILocator(home: home.url, isExecutableFile: { $0 == claude }),
            runner: runner, opener: FakeOpener(), appVersion: "0.7.0", setup: activity)
        let engine = FakeEngineClient()
        engine.setStatusError(.pluginMissing)
        let model = makeModel(engine, activity: activity, systemActions: actions)
        await model.refresh()
        #expect(model.summary.problem?.kind == .pluginMissing)
        #expect(model.summary.fixLabel == "설치")

        let installing = Task { await model.perform(.installPlugin) }
        #expect(await waitUntil { runner.calls.contains { $0.executable == "/bin/sh" } })
        engine.setStatusError(notSetUp) // the plugin is registered now, the command is not there yet
        await model.refresh()
        #expect(model.summary.headline == "연결을 설정하는 중")
        #expect(model.summary.problem == nil)
        gate.open()
        let outcome = await installing.value
        #expect(outcome == ActionOutcome(kind: .success, message: "새 Claude 대화부터 CUA가 붙어요"))
        #expect(model.banner?.outcome == outcome)
    }

    // MARK: A card says what is happening, from the tooltip to the label

    @Test func theSettingUpCardIsDistinctFromReadyAndProblem() {
        let settingUp = StatusEvaluator.settingUp
        #expect(settingUp.icon == .working)
        #expect(!settingUp.isPlaceholder)
        #expect(settingUp.headline == SetupMessages.running)
        #expect(settingUp.accessibilityLabel == "CUA 설정 중")
        #expect(StatusEvaluator.setupFailed.problem?.fixLabel == "다시 하기")
    }

    @Test func setupGetsAtLeastFifteenMinutesBeforeAnyTimeout() {
        #expect(EngineTimeouts().setup >= .seconds(15 * 60))
        #expect(LiveSystemActions.Timeouts().setup >= .seconds(15 * 60))
    }
}
