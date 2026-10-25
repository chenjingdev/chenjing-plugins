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
    func setUp() async -> ActionOutcome { record("setUp") }
    func installDeveloperTools() async -> ActionOutcome { record("installDeveloperTools") }
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
        sleeper: ManualSleeper = ManualSleeper(),
        bannerDuration: Duration = .seconds(7),
        systemActions: any SystemActions = RecordingSystemActions(),
        pasteboard: RecordingPasteboard = RecordingPasteboard()
    ) -> CUABarViewModel {
        CUABarViewModel(
            engine: engine, appVersion: appVersion, systemActions: systemActions, pasteboard: pasteboard,
            clock: { Fixtures.now }, calendar: Fixtures.utc, bannerDuration: bannerDuration, sleep: sleeper.sleep)
    }

    /// Polls until `condition` holds. The limit is long on purpose: a passing test returns at
    /// once, and a busy machine (the snapshot tests keep the main actor occupied) only slows it.
    private func waitUntil(_ timeout: Double = 30, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { try? await Task.sleep(for: .milliseconds(2)) }
        return condition()
    }

    /// Lets everything that is ready to run on the main actor run.
    private func settle() async {
        for _ in 0..<30 { await Task.yield() }
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
        #expect(model.content?.connections.groups.map(\.title) == ["Claude · 1", "Codex · 1"])
        #expect(model.updatedAt == Fixtures.now)
        #expect(engine.calls == [.status])
    }

    @Test func theAppVersionIsComparedWithTheEnginesAndADifferentOneIsTheSetupProblem() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let model = makeModel(engine, appVersion: "0.8.0")
        await model.refresh()
        #expect(model.summary.problem?.kind == .setupIncomplete)
        #expect(model.summary.problem?.title == "연결 엔진이 앱과 판이 달라요")
        #expect(model.summary.problem?.fix == .runSetup)
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

    @Test func aMissingEngineAndAMissingSetupAreShownAtOnceEvenAfterAGoodAnswer() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let model = makeModel(engine)
        await model.refresh()
        engine.setStatusError(.engineMissing)
        await model.refresh()
        #expect(model.summary.problem?.kind == .setupIncomplete)
        #expect(model.summary.problem?.title == "연결 엔진이 없어요")
        engine.setStatusError(.setupNeeded(installPath: "/x"))
        await model.refresh()
        #expect(model.summary.problem?.kind == .setupIncomplete)
        #expect(model.summary.problem?.fix == .runSetup)
    }

    @Test func whileTheRemovalUndoesThingsItsCardStaysAndReadsAreDropped() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let model = makeModel(engine)
        await model.refresh()
        let content = model.content
        let card = try #require(RemovalMessages.card(for: .working))
        model.showRemoval(card)
        #expect(model.summary == card)
        // The engine is half gone: this read would put up 연결 엔진이 없어요 with an install button.
        engine.setStatusError(.engineMissing)
        await model.refresh()
        #expect(model.summary == card)
        #expect(model.summary.fix == nil)
        #expect(model.content == content)
        let done = try #require(RemovalMessages.card(for: .finished(RemovalMessages.done)))
        model.showRemoval(done)
        #expect(model.summary == done)
        // Refused: the reads have the card again.
        model.showRemoval(nil)
        await model.refresh()
        #expect(model.summary.problem?.title == "연결 엔진이 없어요")
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
        let gate = AsyncGate()
        engine.configure { $0.statusGate = gate }
        defer { gate.open() }
        let model = makeModel(engine)
        let first = Task { await model.refresh() }
        #expect(await waitUntil { engine.statusCallCount == 1 })
        // The first read is stuck in the engine; two more asks join it instead of starting their own.
        let second = Task { await model.refresh() }
        let third = Task { await model.refresh() }
        await settle()
        #expect(engine.statusCallCount == 1)
        gate.open()
        await first.value
        await second.value
        await third.value
        #expect(engine.statusCallCount == 1)
        #expect(model.summary.icon == .ready)
    }

    @Test func aSlowEngineNeverBlocksTheMainActor() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let gate = AsyncGate()
        engine.configure { $0.statusGate = gate }
        defer { gate.open() }
        let model = makeModel(engine)
        let refreshing = Task { await model.refresh() }
        // This line runs on the main actor while the engine call is stuck at the gate, which only
        // happens because refresh() suspended instead of holding the actor.
        #expect(await waitUntil { engine.statusCallCount == 1 })
        #expect(model.summary.isPlaceholder, "nothing has answered yet")
        gate.open()
        await refreshing.value
        #expect(model.summary.icon == .ready)
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

    @Test func theLoopReadsAtOnceThenWaitsFiveSecondsAndGoesOn() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let sleeper = ManualSleeper()
        let model = makeModel(engine, sleeper: sleeper)
        model.start()
        #expect(await waitUntil { sleeper.requestedDurations.count == 1 })
        #expect(engine.statusCallCount == 1, "the first read does not wait for anything")
        #expect(sleeper.requestedDurations == [.seconds(5)])
        #expect(sleeper.releaseAll() == 1) // five seconds pass
        #expect(await waitUntil { sleeper.requestedDurations.count == 2 })
        #expect(engine.statusCallCount == 2)
        #expect(sleeper.requestedDurations == [.seconds(5), .seconds(5)])
        model.stop()
    }

    @Test func openingThePopoverReadsAtOnceAndThenEveryTwoSeconds() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let sleeper = ManualSleeper()
        let model = makeModel(engine, sleeper: sleeper)
        model.start()
        #expect(await waitUntil { sleeper.requestedDurations.count == 1 })
        model.setPopoverOpen(true) // no five seconds of waiting first
        #expect(await waitUntil { sleeper.requestedDurations.count == 2 })
        #expect(engine.statusCallCount == 2)
        #expect(sleeper.requestedDurations == [.seconds(5), .seconds(2)])
        #expect(sleeper.cancelledCount == 1, "the five-second wait was cut short")
        model.stop()
    }

    @Test func closingThePopoverReadsNothingAndGoesBackToFiveSeconds() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let sleeper = ManualSleeper()
        let model = makeModel(engine, sleeper: sleeper)
        model.start()
        #expect(await waitUntil { sleeper.requestedDurations.count == 1 })
        model.setPopoverOpen(true)
        #expect(await waitUntil { sleeper.requestedDurations.count == 2 })
        model.setPopoverOpen(false)
        await settle()
        #expect(engine.statusCallCount == 2, "closing is not a reason to read")
        #expect(sleeper.pendingDurations == [.seconds(2)])
        sleeper.releaseAll()
        #expect(await waitUntil { sleeper.requestedDurations.count == 3 })
        #expect(engine.statusCallCount == 3)
        #expect(sleeper.requestedDurations == [.seconds(5), .seconds(2), .seconds(5)])
        model.stop()
    }

    @Test func openingAnOpenPopoverDoesNothingTwice() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let sleeper = ManualSleeper()
        let model = makeModel(engine, sleeper: sleeper)
        model.start()
        #expect(await waitUntil { sleeper.requestedDurations.count == 1 })
        model.setPopoverOpen(true)
        #expect(await waitUntil { sleeper.requestedDurations.count == 2 })
        model.setPopoverOpen(true)
        await settle()
        #expect(engine.statusCallCount == 2)
        model.stop()
    }

    @Test func startingTwiceStillRunsOneLoop() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let sleeper = ManualSleeper()
        let model = makeModel(engine, sleeper: sleeper)
        model.start()
        model.start()
        #expect(await waitUntil { sleeper.requestedDurations.count == 1 })
        await settle()
        #expect(engine.statusCallCount == 1)
        #expect(sleeper.requestedDurations.count == 1)
        model.stop()
    }

    @Test func stoppingEndsTheLoop() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let sleeper = ManualSleeper()
        let model = makeModel(engine, sleeper: sleeper)
        model.start()
        #expect(await waitUntil { sleeper.requestedDurations.count == 1 })
        model.stop()
        await settle()
        #expect(sleeper.pendingDurations.isEmpty, "the wait was cancelled")
        #expect(sleeper.releaseAll() == 0)
        await settle()
        #expect(engine.statusCallCount == 1)
        #expect(sleeper.requestedDurations.count == 1)
    }

    @Test func theLoopCanBeStoppedAndStartedAgain() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let sleeper = ManualSleeper()
        let model = makeModel(engine, sleeper: sleeper)
        model.start()
        #expect(await waitUntil { engine.statusCallCount == 1 && sleeper.pendingDurations.count == 1 })
        model.stop()
        model.start()
        #expect(await waitUntil { engine.statusCallCount == 2 }, "a new loop reads at once")
        #expect(await waitUntil { sleeper.pendingDurations.count == 1 })
        model.setPopoverOpen(true)
        #expect(await waitUntil { engine.statusCallCount == 3 }, "and the new loop can be woken")
        model.stop()
    }

    // MARK: Actions call the engine

    @Test(arguments: [
        (CUAAction.releaseConnection("claude-1-1"), FakeEngineClient.Call.releaseConnection("claude-1-1")),
        (.retryRelease("claude-1-1"), .releaseConnection("claude-1-1")),
        (.releaseSession("019a-1", user: true), .releaseSession("019a-1", user: true)),
        (.releaseSession("019a-1", user: false), .releaseSession("019a-1", user: false)),
        (.restartCodex, .restartCodex),
        (.keepErrorText(true), .setErrorText(true)),
        (.keepErrorText(false), .setErrorText(false)),
        (.copyDiagnosis, .diagnose),
    ])
    func eachActionIsOneEngineCallFollowedByAnImmediateRefresh(action: CUAAction, call: FakeEngineClient.Call) async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let model = makeModel(engine)
        await model.perform(action)
        #expect(engine.calls == [call, .status])
    }

    @Test func theRefreshAfterAnActionWaitsForOneAlreadyInFlight() async throws {
        // A read that started before the action finished may predate its effect, so the read
        // after the action has to be a fresh one, started once the earlier one is done.
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let gate = AsyncGate()
        engine.configure { $0.statusGate = gate }
        defer { gate.open() }
        let model = makeModel(engine)
        let early = Task { await model.refresh() }
        #expect(await waitUntil { engine.statusCallCount == 1 }) // read #1 is stuck in the engine
        let acting = Task { await model.perform(.releaseConnection("claude-1-1")) }
        #expect(await waitUntil { engine.calls.contains(.releaseConnection("claude-1-1")) })
        await settle()
        #expect(engine.statusCallCount == 1, "the read after the action does not start beside read #1")
        gate.open()
        _ = await acting.value
        await early.value
        #expect(engine.statusCallCount == 2, "it read once more, after the action")
        #expect(engine.calls.last == .status)
    }

    @Test func aButtonCannotStartTheSameActionTwice() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let gate = AsyncGate()
        engine.configure { $0.actionGate = gate }
        defer { gate.open() }
        let model = makeModel(engine)
        let first = Task { await model.perform(.releaseConnection("claude-1-1")) }
        #expect(await waitUntil { engine.calls.contains(.releaseConnection("claude-1-1")) })
        #expect(model.inFlight.contains(.releaseConnection("claude-1-1")))
        #expect(model.isWaiting(onConnection: "claude-1-1"))
        #expect(model.isWaiting(onConnection: "codex-9-9") == false)
        let second = await model.perform(.releaseConnection("claude-1-1"))
        #expect(second == ActionOutcome(kind: .info, message: "이미 하는 중이에요"))
        gate.open()
        _ = await first.value
        #expect(engine.calls.filter { $0 == .releaseConnection("claude-1-1") }.count == 1)
        #expect(model.inFlight.isEmpty)
    }

    @Test func restartAndSetupMakeEveryRowWait() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let gate = AsyncGate()
        engine.configure { $0.actionGate = gate }
        defer { gate.open() }
        let model = makeModel(engine)
        let running = Task { await model.perform(.restartCodex) }
        #expect(await waitUntil { engine.calls.contains(.restartCodex) })
        #expect(model.isWaiting(onConnection: "anything"))
        #expect(model.isWaiting(onSession: "any-session"), "a lease line waits for a restart too")
        #expect(model.tidyAllIsWaiting)
        gate.open()
        _ = await running.value
        #expect(model.isWaiting(onConnection: "anything") == false)
        #expect(model.isWaiting(onSession: "any-session") == false)
        #expect(model.tidyAllIsWaiting == false)
    }

    @Test func tidyingOneLineOrAllOfThemMakesOnlyTheLinesItTouchesWait() async throws {
        // S18: an action once spun the release of a live connection it never touches (Ruling 180).
        var status = try Fixtures.status("status-ready")
        status.connections[0].state = .ended
        let claude = status.connections[0].id, codex = status.connections[1].id
        let engine = FakeEngineClient(status: status)
        let model = makeModel(engine)
        await model.refresh()
        await model.waitForBackgroundWork()

        let first = AsyncGate()
        engine.configure { $0.actionGate = first }
        defer { first.open() }
        let all = Task { await model.perform(.tidyAll) }
        #expect(await waitUntil { engine.calls.contains(.stopConnection(claude, force: false)) })
        #expect(model.isWaiting(onConnection: claude))
        #expect(model.isWaiting(onConnection: codex) == false, "a live connection is not one of the ended ones")
        #expect(model.tidyAllIsWaiting)
        first.open()
        _ = await all.value

        let second = AsyncGate()
        engine.configure { $0.actionGate = second }
        defer { second.open() }
        let one = Task { await model.perform(.releaseConnection(codex)) }
        #expect(await waitUntil { engine.calls.contains(.releaseConnection(codex)) })
        #expect(model.isWaiting(onConnection: codex))
        #expect(model.isWaiting(onConnection: claude) == false, "the other line is left alone")
        #expect(model.tidyAllIsWaiting == false, "and so is 모두 정리")
        second.open()
        _ = await one.value
        #expect(model.isWaiting(onConnection: codex) == false)

        let third = AsyncGate()
        engine.configure { $0.actionGate = third }
        defer { third.open() }
        let tidying = Task { await model.perform(.tidy(claude)) }
        #expect(await waitUntil { engine.calls.filter { $0 == .stopConnection(claude, force: false) }.count == 2 })
        #expect(model.isWaiting(onConnection: claude))
        #expect(model.isWaiting(onConnection: codex) == false)
        third.open()
        _ = await tidying.value
    }

    // MARK: Results

    @Test func aFinishedActionLeavesAOneLineBanner() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        // (`request_in_flight` has a flow of its own, R15: it asks once more instead of showing a banner.)
        engine.configure { $0.releaseConnection = ReleaseResult(ok: false, released: false, reason: "relay_unavailable", scopeCount: 0) }
        let model = makeModel(engine)
        let outcome = await model.perform(.releaseConnection("claude-1-1"))
        #expect(outcome == ActionOutcome(kind: .failure, message: "탭을 풀지 못했어요 — 중계기를 쓸 수 없어요"))
        #expect(model.banner?.outcome == outcome)
        model.dismissBanner()
        #expect(model.banner == nil)
    }

    @Test func anEngineThatCannotBeAskedIsAFailureBanner() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        engine.configure { $0.actionError = .timeout }
        let model = makeModel(engine)
        let outcome = await model.perform(.releaseConnection("codex-1-1"))
        #expect(outcome == ActionOutcome(kind: .failure, message: "탭을 풀지 못했어요 — 응답이 없어 기다리다 멈췄어요"))
        #expect(model.inFlight.isEmpty)
    }

    @Test func theBannerClearsItselfAfterAWhile() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let sleeper = ManualSleeper()
        let model = makeModel(engine, sleeper: sleeper, bannerDuration: .seconds(7))
        await model.perform(.releaseConnection("claude-1-1"))
        #expect(model.banner != nil)
        #expect(sleeper.pendingDurations == [.seconds(7)])
        sleeper.releaseAll() // seven seconds pass
        #expect(await waitUntil { model.banner == nil })
    }

    @Test func aNewerBannerReplacesTheOlderOneAndOnlyItsOwnTimerClearsIt() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let sleeper = ManualSleeper()
        let model = makeModel(engine, sleeper: sleeper, bannerDuration: .seconds(7))
        await model.perform(.releaseConnection("claude-1-1"))
        let first = model.banner
        await model.perform(.restartCodex)
        let second = model.banner
        #expect(first != nil && second != nil && first != second)
        #expect(sleeper.cancelledCount == 1, "the older banner's timer was cancelled")
        #expect(sleeper.pendingDurations == [.seconds(7)])
        sleeper.releaseAll()
        #expect(await waitUntil { model.banner == nil })
    }

    // MARK: Special actions

    @Test func copyingTheDiagnosisPutsTheEnginesTextOnThePasteboardWithTheNotificationLine() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        engine.configure { $0.diagnosis = "CUA diagnosis\nhost: ready" }
        let pasteboard = RecordingPasteboard()
        let model = makeModel(engine, pasteboard: pasteboard)
        let outcome = await model.perform(.copyDiagnosis)
        // Outside the app bundle there is no notification setting.
        #expect(pasteboard.copied.map(CheckFixtures.withoutCheckLines) == ["CUA diagnosis\nhost: ready\n알림: 쓸 수 없음\n"])
        #expect(outcome == ActionOutcome(kind: .success, message: "진단을 복사했어요"))
    }

    @Test func aFailedDiagnosisCopiesNothing() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        engine.configure { $0.actionError = .engineMissing }
        let pasteboard = RecordingPasteboard()
        let model = makeModel(engine, pasteboard: pasteboard)
        let outcome = await model.perform(.copyDiagnosis)
        #expect(pasteboard.copied.isEmpty)
        #expect(outcome.kind == .failure)
    }

    @Test func theErrorTextSwitchShowsTheValueBeingSetUntilTheEngineHasItAndSaysNothingWhenItWorks() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let gate = AsyncGate()
        engine.configure { $0.actionGate = gate }
        let model = makeModel(engine)
        await model.refresh()
        #expect(model.activityContent.keepsErrorText == false)
        #expect(model.errorTextPending == nil)
        let task = model.send(.keepErrorText(true))
        #expect(task != nil, "the switch is its own consent")
        #expect(await waitUntil { engine.calls.contains(.setErrorText(true)) })
        #expect(model.errorTextPending == true, "the switch shows the new value and waits")
        gate.open()
        await task?.value
        #expect(model.errorTextPending == nil)
        #expect(model.activityContent.keepsErrorText == true, "read again at once")
        #expect(model.banner == nil)
    }

    @Test func aSwitchTheEngineCouldNotSetSaysSoUnderTheCard() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        engine.configure { $0.settings = SettingsResult(ok: false, reason: "unwritable") }
        let model = makeModel(engine)
        await model.refresh()
        let outcome = await model.perform(.keepErrorText(true))
        #expect(outcome == ActionOutcome(kind: .failure, message: "오류 문구 설정을 바꾸지 못했어요 — 기록 폴더에 쓸 수 없어요"))
        #expect(model.banner?.outcome == outcome)
        #expect(model.activityContent.keepsErrorText == false)
    }

    @Test func aFailedTargetedReleaseOpensTheExtensionGuidanceAndASuccessClosesItAgain() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-problem"))
        engine.configure { $0.releaseSession = SessionReleaseResult(ok: true, released: false, reason: "unsupported") }
        let model = makeModel(engine)
        await model.refresh()
        // The fixture's Claude leftover is the automatic cleanup's first; a click waits for it (F5).
        await model.waitForBackgroundWork()
        await model.perform(.releaseSession("019a1b2c-0009", user: true))
        #expect(model.failedSessionIDs == ["019a1b2c-0009"])
        engine.configure { $0.releaseSession = SessionReleaseResult(ok: true, released: true) }
        await model.perform(.releaseSession("019a1b2c-0009", user: true))
        #expect(model.failedSessionIDs.isEmpty)
    }

    @Test func aNewFailedReleaseOpensTheGuidanceAgainEvenIfThePersonClosedIt() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-problem"))
        engine.configure { $0.releaseSession = SessionReleaseResult(ok: true, released: false, reason: "unsupported") }
        let model = makeModel(engine)
        await model.refresh()
        await model.waitForBackgroundWork()
        model.guidanceOpenByUser = false
        await model.perform(.releaseSession("019a1b2c-0009", user: true))
        #expect(model.guidanceOpenByUser == nil, "left to the popover again: open, because a release failed")
        model.guidanceOpenByUser = false
        await model.perform(.releaseSession("019a1b2c-0009", user: true)) // the same session failing again is not news
        #expect(model.guidanceOpenByUser == false)
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
        await model.perform(.runSetup)
        await model.perform(.installDeveloperTools)
        #expect(system.calls == ["openCodexDownload", "setUp", "installDeveloperTools"])
        // They are not engine calls.
        #expect(engine.calls.filter { $0 != .status }.isEmpty)
    }

    @Test func theUnwiredSystemActionsSayTheyAreNotThereYet() async {
        let actions = UnwiredSystemActions()
        #expect(await actions.openCodexDownload().kind == .info)
        #expect(await actions.setUp().kind == .info)
        #expect(await actions.installDeveloperTools().kind == .info)
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

    @Test func tabsKeepTheirSelectionWhileThePopoverIsOpen() {
        let model = makeModel(FakeEngineClient())
        #expect(model.selectedTab == .connections)
        model.selectedTab = .activity
        #expect(model.selectedTab == .activity)
    }

    @Test func thePopoverOpensOnTheListWhereverItWasLeft() {
        // The card sends the person to the top of the list, so every opening starts there.
        let model = makeModel(FakeEngineClient())
        model.setPopoverOpen(true)
        model.selectedTab = .activity
        model.setPopoverOpen(false)
        #expect(model.selectedTab == .activity, "closing changes nothing")
        model.setPopoverOpen(true)
        #expect(model.selectedTab == .connections)
        model.stop()
    }
}
