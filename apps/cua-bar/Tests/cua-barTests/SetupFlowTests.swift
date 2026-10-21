import Foundation
import Testing
@testable import cua_bar

/// The install as the person sees it: run by itself at start-up once, said on the status card while it
/// runs, a fixed line and 다시 하기 after a failure, never started by a status read, and run once more for
/// what it put off (no Codex, no Claude Code) when that has come.
@MainActor
struct SetupFlowTests {
    private typealias Rig = LiveSystemActionsTests.Rig

    private func makeRig(
        codexInstalled: Bool = true, developerTools: Bool = true, claudeInstalled: Bool = true, bundled: Bool = true,
        engine status: Result<EngineStatus, EngineError> = .failure(.engineMissing),
        gateFor: @escaping @Sendable (StepRunner.Call) -> AsyncGate? = { _ in nil },
        responses: (@Sendable (StepRunner.Call) throws -> ProcessOutput?)? = nil
    ) throws -> Rig {
        try LiveSystemActionsTests().rig(
            codexInstalled: codexInstalled, developerTools: developerTools, claudeInstalled: claudeInstalled, bundled: bundled, engine: status,
            gateFor: gateFor, responses: responses)
    }

    private func makeModel(_ rig: Rig, appVersion: String? = "0.7.0") -> CUABarViewModel {
        CUABarViewModel(
            engine: rig.engine, appVersion: appVersion, systemActions: rig.actions, pasteboard: RecordingPasteboard(),
            clock: { Fixtures.now }, calendar: Fixtures.utc, bannerDuration: .seconds(3600), sleep: ManualSleeper().sleep,
            setupActivity: rig.setup, codexInstalled: { rig.codex.isThere })
    }

    private func automaticSetup(_ model: CUABarViewModel, _ rig: Rig, bundled: Bool = true) -> AutomaticSetup {
        AutomaticSetup(
            activity: rig.setup, perform: { _ = await model.perform($0) }, isBundled: bundled,
            codexInstalled: { rig.codex.isThere }, claudeCodeFound: { rig.claudeCode.isThere })
    }

    private func waitUntil(_ timeout: Double = 30, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { try? await Task.sleep(for: .milliseconds(2)) }
        return condition()
    }

    // MARK: Automatic install

    @Test func theInstallRunsByItselfAtStartAndTheStatusIsReadAfterIt() async throws {
        let rig = try makeRig()
        defer { rig.home.remove() }
        let model = makeModel(rig)
        await automaticSetup(model, rig).runAtStartup()
        #expect(rig.runner.calls.contains(rig.installEngineCall))
        #expect(rig.engine.calls.last == .status, "a read of what it did")
        #expect(rig.setup.automaticRunClaimed)
    }

    @Test func itRunsAtMostOncePerAppRun() async throws {
        let rig = try makeRig()
        defer { rig.home.remove() }
        let model = makeModel(rig)
        let auto = automaticSetup(model, rig)
        await auto.runAtStartup()
        await auto.runAtStartup()
        await automaticSetup(model, rig).runAtStartup()
        #expect(rig.runner.calls.filter { $0.isInstallEngine }.count == 1)
    }

    @Test func aBuildOutsideAnAppBundleNeverRunsItByItself() async throws {
        let rig = try makeRig(bundled: false)
        defer { rig.home.remove() }
        let model = makeModel(rig)
        await automaticSetup(model, rig, bundled: false).runAtStartup()
        #expect(rig.runner.calls.isEmpty)
        #expect(rig.engine.calls.isEmpty)
        #expect(!rig.setup.automaticRunClaimed, "an attempt that did not happen is not used up")
    }

    @Test func aFailedAutomaticRunIsNotTriedAgainByItself() async throws {
        let rig = try makeRig(responses: { $0.isInstallEngine ? StepRunner.failed() : nil })
        defer { rig.home.remove() }
        let model = makeModel(rig)
        let auto = automaticSetup(model, rig)
        await auto.runAtStartup()
        await auto.runAtStartup()
        await auto.runWhatWasPutOff()
        #expect(rig.runner.calls.filter { $0.isInstallEngine }.count == 1)
        #expect(rig.setup.phase == .failed)
        #expect(model.summary.fixLabel == "다시 하기", "only a click tries again")
    }

    @Test func aStatusReadNeverStartsTheInstallOrAnyOtherStep() async throws {
        let rig = try makeRig()
        defer { rig.home.remove() }
        let sleeper = ManualSleeper()
        let model = CUABarViewModel(
            engine: rig.engine, appVersion: "0.7.0", systemActions: rig.actions, clock: { Fixtures.now }, calendar: Fixtures.utc,
            sleep: sleeper.sleep, setupActivity: rig.setup)
        let problems: [EngineError] = [
            .setupNeeded(installPath: "/x"), .engineMissing, .unsupportedSchema(2), .timeout, .commandFailed(exitCode: 2, message: "usage"), .invalidOutput("EngineStatus"),
        ]
        for error in problems {
            rig.engine.setStatusError(error)
            for _ in 0..<3 { await model.refresh() }
        }
        model.start()
        #expect(await waitUntil { sleeper.requestedDurations.count == 1 })
        #expect(sleeper.releaseAll() == 1)
        #expect(await waitUntil { sleeper.requestedDurations.count == 2 })
        model.stop()
        #expect(rig.engine.calls.allSatisfy { $0 == .status }, "reads only: \(rig.engine.calls)")
        #expect(rig.runner.calls.isEmpty)
    }

    // MARK: What was put off

    @Test func whatWasPutOffForCodexRunsOnceAfterCodexHasComeAndNotBefore() async throws {
        let rig = try makeRig(codexInstalled: false)
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        let model = makeModel(rig)
        let auto = automaticSetup(model, rig)
        await auto.runAtStartup()
        #expect(rig.runner.calls.isEmpty, "no Codex: nothing at all")
        #expect(rig.setup.waitingFor == [.codex])

        await auto.runWhatWasPutOff()
        #expect(rig.runner.calls.isEmpty, "still no Codex")

        rig.codex.isThere = true
        await auto.runWhatWasPutOff()
        #expect(rig.runner.calls.contains(rig.installEngineCall))
        #expect(rig.runner.calls.contains(rig.mcpAdd()))
        #expect(rig.setup.waitingFor.isEmpty)
        let count = rig.runner.calls.count
        await auto.runWhatWasPutOff()
        #expect(rig.runner.calls.count == count, "once, not at every read")
    }

    @Test func whatWasPutOffForClaudeCodeIsPutInOnceItHasComeAndTheEngineIsNotUnpackedAgain() async throws {
        let rig = try makeRig(claudeInstalled: false)
        defer { rig.home.remove() }
        let model = makeModel(rig)
        let auto = automaticSetup(model, rig)
        await auto.runAtStartup()
        #expect(rig.setup.waitingFor == [.claudeCode])
        #expect(rig.runner.calls.filter { $0.isInstallEngine }.count == 1)

        rig.engine.setStatus(try LiveSystemActionsTests().currentEngine(rig.home).get())
        try rig.home.installClaudeCode()
        rig.claudeCode.isThere = true
        await auto.runWhatWasPutOff()
        #expect(rig.runner.calls.filter { $0.isInstallEngine }.count == 1, "the engine was already the app's")
        #expect(rig.runner.calls.contains(rig.mcpAdd()))
        #expect(rig.claude.skillState(source: rig.bundle.skillSource, appVersion: "0.7.0") == .ready)
        #expect(rig.setup.waitingFor.isEmpty)
    }

    @Test func theModelRunsWhatWasPutOffAfterAReadThatFindsItHasComeAndOnlyThen() async throws {
        let rig = try makeRig(codexInstalled: false)
        defer { rig.home.remove() }
        let model = makeModel(rig)
        let auto = automaticSetup(model, rig)
        model.afterRead = { await auto.runWhatWasPutOff() }
        await auto.runAtStartup()
        await model.refresh()
        await model.waitForBackgroundWork()
        #expect(rig.runner.calls.isEmpty)

        rig.codex.isThere = true
        await model.refresh()
        await model.waitForBackgroundWork()
        #expect(rig.runner.calls.contains(rig.installEngineCall))
        let count = rig.runner.calls.filter { $0.isInstallEngine }.count
        await model.refresh()
        await model.waitForBackgroundWork()
        #expect(rig.runner.calls.filter { $0.isInstallEngine }.count == count)
    }

    // MARK: The card while it runs, and after it fails

    @Test func whileTheInstallRunsTheCardSaysSoInsteadOfShowingAProblem() async throws {
        let gate = AsyncGate()
        let rig = try makeRig(gateFor: { $0.isInstallEngine ? gate : nil })
        defer { rig.home.remove(); gate.open() }
        let model = makeModel(rig)
        await model.refresh()
        #expect(model.summary.problem?.kind == .setupIncomplete, "before it starts: the plain problem")
        #expect(model.summary.fixLabel == "고치기")

        let running = Task { await automaticSetup(model, rig).runAtStartup() }
        #expect(await waitUntil { rig.runner.calls.contains { $0.isInstallEngine } })
        #expect(model.summary.headline == "연결을 설정하는 중")
        #expect(model.summary.problem == nil, "not a problem")
        #expect(model.summary.fix == nil)
        #expect(model.summary.icon == .working)
        #expect(model.summary.tooltip == "CUA 설정 중 · 연결을 설정하는 중")
        await model.refresh() // a status read while it runs does not bring the problem back
        #expect(model.summary.headline == "연결을 설정하는 중")

        gate.open()
        await running.value
        rig.engine.setStatus(try LiveSystemActionsTests().currentEngine(rig.home).get())
        await model.refresh()
        #expect(model.summary.problem == nil)
        #expect(model.summary.headline != "연결을 설정하는 중")
        #expect(rig.setup.phase == .idle)
    }

    @Test func afterAFailureTheCardHasOneFixedLineAndATryAgainButton() async throws {
        let rig = try makeRig(responses: { $0.isInstallEngine ? StepRunner.failed() : nil })
        defer { rig.home.remove() }
        let model = makeModel(rig)
        await model.refresh()
        await automaticSetup(model, rig).runAtStartup()

        let problem = model.summary.problem
        #expect(problem?.kind == .setupIncomplete)
        #expect(model.summary.headline == "연결 설정에 실패했어요")
        #expect(model.summary.fix == .runSetup)
        #expect(model.summary.fixLabel == "다시 하기")
        #expect(model.summary.icon == .problem)
        #expect(model.summary.tooltip == "CUA 문제 · 연결 설정에 실패했어요")
        let shown = [model.summary.headline, model.summary.nextStep, model.summary.warning ?? "", model.banner?.outcome.message ?? ""]
        #expect(shown.allSatisfy { !$0.contains("SECRET") && !$0.contains("token") }, "never what the command printed")
        #expect(model.banner?.outcome == ActionOutcome(kind: .failure, message: "연결 엔진을 설치하지 못했어요"))
    }

    @Test func pressingTryAgainRunsItOnceMoreAndASuccessClearsTheFailure() async throws {
        let failing = Presence(true)
        let rig = try makeRig(responses: { failing.isThere && $0.isInstallEngine ? StepRunner.failed() : nil })
        defer { rig.home.remove() }
        let model = makeModel(rig)
        await model.refresh()
        await automaticSetup(model, rig).runAtStartup()
        let retry = try #require(model.summary.fix)

        failing.isThere = false
        let outcome = await model.perform(retry)
        #expect(rig.runner.calls.filter { $0.isInstallEngine }.count == 2, "the click is a second run, allowed")
        #expect(outcome.kind == .success)
        #expect(rig.setup.phase == .idle)
    }

    @Test func aFailureIsForgottenOnceTheSetupProblemIsGone() async throws {
        let rig = try makeRig(responses: { $0.isInstallEngine ? StepRunner.failed() : nil })
        defer { rig.home.remove() }
        let model = makeModel(rig)
        await model.refresh()
        await automaticSetup(model, rig).runAtStartup()
        #expect(model.summary.fixLabel == "다시 하기")

        rig.engine.setStatus(try LiveSystemActionsTests().currentEngine(rig.home).get()) // someone fixed it by hand
        await model.refresh()
        #expect(rig.setup.phase == .idle)
        rig.engine.setStatusError(.setupNeeded(installPath: "/x")) // and later it breaks again
        await model.refresh()
        #expect(model.summary.fixLabel == "고치기", "a new problem, not the old failure")
        #expect(model.summary.headline == "연결 설정이 아직 안 됐어요")
    }

    @Test func theOverlayLeavesEveryOtherCardAlone() async throws {
        let rig = try makeRig(engine: .success(try Fixtures.status("status-problem")))
        defer { rig.home.remove() }
        let model = makeModel(rig, appVersion: nil)
        await model.refresh()
        let before = model.summary
        #expect(before.problem?.kind == .codexWithoutHost)
        _ = rig.setup.begin()
        #expect(model.summary == before, "a running install is no reason to hide an unrelated problem")
        rig.setup.end(succeeded: false)
        #expect(model.summary == before)
    }

    // MARK: Developer tools, Codex

    @Test func withoutDeveloperToolsTheCardAsksForThemAndItsButtonOpensTheInstaller() async throws {
        let rig = try makeRig(developerTools: false)
        defer { rig.home.remove() }
        let model = makeModel(rig)
        await automaticSetup(model, rig).runAtStartup()
        let problem = try #require(model.summary.problem)
        #expect(problem.kind == .developerToolsNeeded)
        #expect(problem.title == "개발자 도구 필요")
        #expect(problem.fix == .installDeveloperTools)
        #expect(problem.fixLabel == "설치")
        #expect(model.summary.icon == .problem)
        #expect(rig.runner.calls.allSatisfy { $0.executable == "/usr/bin/xcode-select" && $0.arguments == ["-p"] }, "nothing opened by itself")

        let outcome = await model.perform(try #require(model.summary.fix))
        #expect(rig.runner.calls.last?.arguments == ["--install"])
        #expect(outcome.kind == .info)
    }

    @Test func withoutCodexTheCardSaysCodexIsMissingAndOffersNoInstall() async throws {
        let rig = try makeRig(codexInstalled: false)
        defer { rig.home.remove() }
        let model = makeModel(rig)
        await automaticSetup(model, rig).runAtStartup()
        await model.refresh()
        #expect(model.summary.problem?.kind == .codexMissing)
        #expect(model.summary.fix == .openCodexDownload)
        #expect(rig.runner.calls.isEmpty)
    }

    // MARK: One at a time

    @Test func anInstallAlreadyRunningElsewhereTakesTheSlotSoThePressDoesNothing() async throws {
        let rig = try makeRig()
        defer { rig.home.remove() }
        let model = makeModel(rig)
        #expect(rig.setup.begin(), "some other run is going")
        let outcome = await model.perform(.runSetup)
        #expect(outcome == ActionOutcome(kind: .info, message: "이미 하는 중이에요"))
        #expect(rig.runner.calls.isEmpty)
        #expect(rig.setup.phase == .running, "and the other keeps its slot")
    }

    @Test func theSlotIsFreeAgainAfterEveryRun() async throws {
        let rig = try makeRig()
        defer { rig.home.remove() }
        let model = makeModel(rig)
        await model.perform(.runSetup)
        await model.perform(.runSetup)
        #expect(rig.runner.calls.filter { $0.isDeveloperToolsCheck }.count == 2)
        #expect(rig.setup.phase == .idle)
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
        #expect(LiveSystemActions.Timeouts().engineInstall >= .seconds(15 * 60))
    }
}
