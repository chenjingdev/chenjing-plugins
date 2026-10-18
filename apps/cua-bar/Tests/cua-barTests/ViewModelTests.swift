import Foundation
import Testing
@testable import cua_bar

@MainActor
final class RecordingPasteboard: PasteboardWriting {
    private(set) var copied: [String] = []
    func copy(_ text: String) { copied.append(text) }
}

final class RecordingSystemActions: SystemActions, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String] = []
    var calls: [String] { lock.withLock { recorded } }
    func openCodexDownload() async -> ActionOutcome { record("openCodexDownload") }
    func installPlugin() async -> ActionOutcome { record("installPlugin") }
    func matchPluginVersion() async -> ActionOutcome { record("matchPluginVersion") }
    private func record(_ name: String) -> ActionOutcome {
        lock.withLock { recorded.append(name) }
        return ActionOutcome(kind: .success, message: name)
    }
}

@MainActor
struct ViewModelTests {
    private func makeModel(
        _ engine: FakeEngineClient,
        appVersion: String? = "0.7.0",
        policy: RefreshPolicy = RefreshPolicy(closed: .seconds(60), open: .seconds(60)),
        systemActions: any SystemActions = RecordingSystemActions(),
        pasteboard: RecordingPasteboard = RecordingPasteboard()
    ) -> CUABarViewModel {
        CUABarViewModel(
            engine: engine, appVersion: appVersion, systemActions: systemActions, pasteboard: pasteboard, policy: policy,
            clock: { Fixtures.now }, calendar: Fixtures.utc, bannerDuration: .seconds(60))
    }

    private func waitUntil(_ timeout: Double = 3, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { try? await Task.sleep(for: .milliseconds(5)) }
        return condition()
    }

    // MARK: Refresh

    @Test func beforeTheFirstAnswerTheModelIsAPlaceholder() throws {
        let model = makeModel(FakeEngineClient())
        #expect(model.summary.isPlaceholder)
        #expect(model.content == nil)
        #expect(model.updatedAt == nil)
    }

    @Test func aRefreshFillsTheSummaryAndTheTabs() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let model = makeModel(engine)
        await model.refresh()
        #expect(model.summary.icon == .ready)
        #expect(model.summary.tooltip == "CUA 준비됨 · Claude 1 · Codex 1")
        #expect(model.content?.connections.stopCounts == GroupStopCounts(all: 2, claude: 1, codex: 1))
        #expect(model.updatedAt == Fixtures.now)
        #expect(engine.calls == [.status])
    }

    @Test func theAppVersionIsComparedWithThePlugins() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let model = makeModel(engine, appVersion: "0.8.0")
        await model.refresh()
        #expect(model.summary.problem?.kind == .versionMismatch)
    }

    @Test func aFirstFailureIsShownAtOnce() async {
        let engine = FakeEngineClient()
        engine.setStatusError(.timeout)
        let model = makeModel(engine)
        await model.refresh()
        #expect(model.summary.problem?.kind == .engineUnreadable)
        #expect(model.summary.icon == .problem)
        #expect(model.content == nil)
    }

    @Test func aMissingPluginAndAMissingSetupAreShownAtOnceEvenAfterAGoodAnswer() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let model = makeModel(engine)
        await model.refresh()
        engine.setStatusError(.pluginMissing)
        await model.refresh()
        #expect(model.summary.problem?.kind == .pluginMissing)
        engine.setStatusError(.setupNeeded(installPath: "/x"))
        await model.refresh()
        #expect(model.summary.problem?.kind == .setupIncomplete)
        #expect(model.summary.problem?.fix == .runSetup)
    }

    @Test func oneSlowAnswerDoesNotFlipAWorkingIconButTwoDo() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let model = makeModel(engine)
        await model.refresh()
        engine.setStatusError(.timeout)
        await model.refresh()
        #expect(model.summary.icon == .ready, "a single hiccup keeps the last good answer")
        #expect(model.content != nil)
        await model.refresh()
        #expect(model.summary.icon == .problem)
        #expect(model.summary.problem?.kind == .engineUnreadable)
        #expect(model.content == nil)
        // And it recovers on its own.
        engine.setStatus(try Fixtures.status("status-ready"))
        await model.refresh()
        #expect(model.summary.icon == .ready)
        #expect(model.content != nil)
    }

    @Test func refreshesDoNotOverlap() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        engine.configure { $0.delay = .milliseconds(150) }
        let model = makeModel(engine)
        async let first: Void = model.refresh()
        async let second: Void = model.refresh()
        async let third: Void = model.refresh()
        _ = await (first, second, third)
        #expect(engine.statusCallCount == 1)
    }

    @Test func aSlowEngineNeverBlocksTheMainActor() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        engine.configure { $0.delay = .milliseconds(600) }
        let model = makeModel(engine)
        var ticks = 0
        let ticker = Task { @MainActor in
            while !Task.isCancelled {
                ticks += 1
                try? await Task.sleep(for: .milliseconds(10))
            }
        }
        await model.refresh()
        ticker.cancel()
        #expect(ticks >= 15)
    }

    // MARK: Cadence (every 5 s; every 2 s while the popover is open; at once after an action)

    @Test func theDefaultCadenceIsFiveSecondsAndTwoWhileOpen() {
        let policy = RefreshPolicy()
        #expect(policy.closed == .seconds(5))
        #expect(policy.open == .seconds(2))
        let model = CUABarViewModel(engine: FakeEngineClient(), appVersion: nil)
        #expect(model.currentInterval == .seconds(5))
        model.setPopoverOpen(true)
        #expect(model.currentInterval == .seconds(2))
        model.setPopoverOpen(false)
        #expect(model.currentInterval == .seconds(5))
        model.stop()
    }

    @Test func theLoopKeepsRefreshingUntilStopped() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let model = makeModel(engine, policy: RefreshPolicy(closed: .milliseconds(20), open: .milliseconds(20)))
        model.start()
        #expect(await waitUntil { engine.statusCallCount >= 4 })
        model.stop()
        try await Task.sleep(for: .milliseconds(80))
        let after = engine.statusCallCount
        try await Task.sleep(for: .milliseconds(120))
        #expect(engine.statusCallCount == after, "stop() ends the loop")
    }

    @Test func startingTwiceStillRunsOneLoop() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let model = makeModel(engine, policy: RefreshPolicy(closed: .seconds(60), open: .seconds(60)))
        model.start()
        model.start()
        #expect(await waitUntil { engine.statusCallCount >= 1 })
        try await Task.sleep(for: .milliseconds(100))
        #expect(engine.statusCallCount == 1)
        model.stop()
    }

    @Test func openingThePopoverRefreshesAtOnceInsteadOfWaitingOutTheInterval() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let model = makeModel(engine, policy: RefreshPolicy(closed: .seconds(3600), open: .seconds(3600)))
        model.start()
        #expect(await waitUntil { engine.statusCallCount == 1 })
        model.setPopoverOpen(true)
        #expect(await waitUntil { engine.statusCallCount == 2 })
        model.stop()
    }

    @Test func closingThePopoverDoesNotRefresh() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let model = makeModel(engine, policy: RefreshPolicy(closed: .seconds(3600), open: .seconds(3600)))
        model.start()
        model.setPopoverOpen(true)
        #expect(await waitUntil { engine.statusCallCount >= 2 })
        let before = engine.statusCallCount
        model.setPopoverOpen(false)
        try await Task.sleep(for: .milliseconds(100))
        #expect(engine.statusCallCount == before)
        model.stop()
    }

    // MARK: Actions call the engine

    @Test(arguments: [
        (CUAAction.releaseConnection("claude-1-1"), FakeEngineClient.Call.releaseConnection("claude-1-1")),
        (.releaseEnded, .releaseEnded),
        (.releaseSession("019a-1"), .releaseSession("019a-1")),
        (.stopConnection("codex-2-2", force: false), .stopConnection("codex-2-2", force: false)),
        (.stopConnection("codex-2-2", force: true), .stopConnection("codex-2-2", force: true)),
        (.stopGroup(.all, force: false), .stopGroup(.all, force: false)),
        (.stopGroup(.claude, force: false), .stopGroup(.claude, force: false)),
        (.stopGroup(.codex, force: true), .stopGroup(.codex, force: true)),
        (.restartCodex, .restartCodex),
        (.copyDiagnosis, .diagnose),
        (.runSetup, .runSetup),
    ])
    func eachActionIsOneEngineCallFollowedByAnImmediateRefresh(action: CUAAction, call: FakeEngineClient.Call) async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let model = makeModel(engine)
        await model.perform(action)
        #expect(engine.calls == [call, .status])
    }

    @Test func theRefreshAfterAnActionWaitsForOneAlreadyInFlight() async throws {
        // A refresh that started before the action finished may predate its effect, so the
        // post-action refresh has to be a fresh one.
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        engine.configure { $0.delay = .milliseconds(100) }
        let model = makeModel(engine)
        let early = Task { await model.refresh() }
        try await Task.sleep(for: .milliseconds(20))
        await model.perform(.releaseEnded)
        await early.value
        #expect(engine.calls.filter { $0 == .status }.count == 2)
        #expect(engine.calls.last == .status)
    }

    @Test func aButtonCannotStartTheSameActionTwice() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        engine.configure { $0.delay = .milliseconds(120) }
        let model = makeModel(engine)
        async let first = model.perform(.releaseConnection("claude-1-1"))
        try await Task.sleep(for: .milliseconds(20))
        #expect(model.inFlight.contains(.releaseConnection("claude-1-1")))
        #expect(model.isWaiting(onConnection: "claude-1-1"))
        #expect(model.isWaiting(onConnection: "codex-9-9") == false)
        let second = await model.perform(.releaseConnection("claude-1-1"))
        #expect(second.kind == .info)
        _ = await first
        #expect(engine.calls.filter { $0 == .releaseConnection("claude-1-1") }.count == 1)
        #expect(model.inFlight.isEmpty)
    }

    @Test func groupAndRestartActionsMakeEveryRowWait() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        engine.configure { $0.delay = .milliseconds(120) }
        let model = makeModel(engine)
        let running = Task { await model.perform(.stopGroup(.all, force: false)) }
        try await Task.sleep(for: .milliseconds(30))
        #expect(model.isWaiting(onConnection: "anything"))
        _ = await running.value
        #expect(model.isWaiting(onConnection: "anything") == false)
    }

    // MARK: Results

    @Test func aFinishedActionLeavesAOneLineBanner() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        engine.configure { $0.releaseConnection = ReleaseResult(ok: false, released: false, reason: "request_in_flight", scopeCount: 0) }
        let model = makeModel(engine)
        let outcome = await model.perform(.releaseConnection("claude-1-1"))
        #expect(outcome == ActionOutcome(kind: .failure, message: "놓지 못했어요 — 도구 호출이 아직 끝나지 않았어요"))
        #expect(model.banner?.outcome == outcome)
        model.dismissBanner()
        #expect(model.banner == nil)
    }

    @Test func anEngineThatCannotBeAskedIsAFailureBanner() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        engine.configure { $0.actionError = .timeout }
        let model = makeModel(engine)
        let outcome = await model.perform(.stopConnection("codex-1-1", force: true))
        #expect(outcome == ActionOutcome(kind: .failure, message: "끄지 못했어요 — 응답이 없어 기다리다 멈췄어요"))
        #expect(model.inFlight.isEmpty)
    }

    @Test func theBannerClearsItselfAfterAWhile() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let model = CUABarViewModel(
            engine: engine, appVersion: "0.7.0", systemActions: RecordingSystemActions(), pasteboard: RecordingPasteboard(),
            policy: RefreshPolicy(closed: .seconds(60), open: .seconds(60)), clock: { Fixtures.now }, calendar: Fixtures.utc,
            bannerDuration: .milliseconds(80))
        await model.perform(.releaseEnded)
        #expect(model.banner != nil)
        #expect(await waitUntil { model.banner == nil })
    }

    @Test func aNewerBannerIsNotClearedByAnOlderTimer() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let model = CUABarViewModel(
            engine: engine, appVersion: "0.7.0", systemActions: RecordingSystemActions(), pasteboard: RecordingPasteboard(),
            policy: RefreshPolicy(closed: .seconds(60), open: .seconds(60)), clock: { Fixtures.now }, calendar: Fixtures.utc,
            bannerDuration: .milliseconds(200))
        await model.perform(.releaseEnded)
        try await Task.sleep(for: .milliseconds(120))
        await model.perform(.restartCodex)
        let newer = model.banner
        try await Task.sleep(for: .milliseconds(120)) // the first timer is due now
        #expect(model.banner == newer)
        #expect(model.banner != nil)
    }

    // MARK: Special actions

    @Test func copyingTheDiagnosisPutsTheEnginesTextOnThePasteboard() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        engine.configure { $0.diagnosis = "CUA diagnosis\nhost: ready\n" }
        let pasteboard = RecordingPasteboard()
        let model = makeModel(engine, pasteboard: pasteboard)
        let outcome = await model.perform(.copyDiagnosis)
        #expect(pasteboard.copied == ["CUA diagnosis\nhost: ready\n"])
        #expect(outcome == ActionOutcome(kind: .success, message: "진단을 복사했어요"))
    }

    @Test func aFailedDiagnosisCopiesNothing() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        engine.configure { $0.actionError = .pluginMissing }
        let pasteboard = RecordingPasteboard()
        let model = makeModel(engine, pasteboard: pasteboard)
        let outcome = await model.perform(.copyDiagnosis)
        #expect(pasteboard.copied.isEmpty)
        #expect(outcome.kind == .failure)
    }

    @Test func releasingLeftoversTriesEveryReleasableSessionOnce() async throws {
        var status = try Fixtures.status("status-problem")
        status.leases.maybeLeft.append(LeftoverLease(sessionID: "019a-extra", agent: .claude, connectionID: nil, cwd: nil, endedAt: nil, releasable: true))
        let engine = FakeEngineClient(status: status)
        engine.configure { $0.releaseSessionByID["019a-extra"] = ReleaseResult(ok: true, released: false, reason: "cleanup_not_confirmed") }
        let model = makeModel(engine)
        await model.refresh()
        let outcome = await model.perform(.releaseLeftover)
        // The Codex leftover has no session id and is not releasable: it is not attempted.
        #expect(engine.calls.filter { if case .releaseSession = $0 { true } else { false } } == [.releaseSession("019a1b2c-0009"), .releaseSession("019a-extra")])
        #expect(outcome == ActionOutcome(kind: .warning, message: "점유 2개 중 1개를 풀었어요 — 정리가 확인되지 않았어요"))
        #expect(model.failedSessionIDs == ["019a-extra"])
    }

    @Test func releasingLeftoversWithNothingToAimAtSaysSo() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let model = makeModel(engine)
        await model.refresh()
        let outcome = await model.perform(.releaseLeftover)
        #expect(outcome == ActionOutcome(kind: .info, message: "하나씩 풀 수 있는 점유가 없어요"))
        #expect(engine.calls.filter { if case .releaseSession = $0 { true } else { false } }.isEmpty)
    }

    @Test func aFailedTargetedReleaseOpensTheExtensionGuidanceAndASuccessClosesItAgain() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-problem"))
        engine.configure { $0.releaseSession = ReleaseResult(ok: true, released: false, reason: "unsupported") }
        let model = makeModel(engine)
        await model.refresh()
        await model.perform(.releaseSession("019a1b2c-0009"))
        #expect(model.failedSessionIDs == ["019a1b2c-0009"])
        engine.configure { $0.releaseSession = ReleaseResult(ok: true, released: true) }
        await model.perform(.releaseSession("019a1b2c-0009"))
        #expect(model.failedSessionIDs.isEmpty)
    }

    @Test func refreshAsAnActionJustReads() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let model = makeModel(engine)
        await model.perform(.refresh)
        #expect(engine.calls == [.status])
        #expect(model.banner == nil)
    }

    @Test func fixesThatNeedTheNextTaskGoToTheSystemActions() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let system = RecordingSystemActions()
        let model = makeModel(engine, systemActions: system)
        await model.perform(.openCodexDownload)
        await model.perform(.installPlugin)
        await model.perform(.matchPluginVersion)
        #expect(system.calls == ["openCodexDownload", "installPlugin", "matchPluginVersion"])
        // They are not engine calls.
        #expect(engine.calls.filter { $0 != .status }.isEmpty)
    }

    @Test func theUnwiredSystemActionsSayTheyAreNotThereYet() async {
        let actions = UnwiredSystemActions()
        #expect(await actions.openCodexDownload().kind == .info)
        #expect(await actions.installPlugin().kind == .info)
        #expect(await actions.matchPluginVersion().kind == .info)
    }

    @Test func theStatusCardsFixButtonRunsItsAction() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-problem"))
        let model = makeModel(engine)
        await model.refresh()
        let fix = try #require(model.summary.fix)
        #expect(fix == .restartCodex)
        await model.perform(fix)
        #expect(engine.calls.contains(.restartCodex))
    }

    @Test func tabsKeepTheirSelection() {
        let model = makeModel(FakeEngineClient())
        #expect(model.selectedTab == .connections)
        model.selectedTab = .activity
        #expect(model.selectedTab == .activity)
    }
}
