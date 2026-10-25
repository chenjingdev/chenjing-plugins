import Foundation
import Testing
@testable import cua_bar

/// No button asks before it runs (the person's "이렇게 한번더 레이아웃 바꾸면서 재확인 받는게 맞는 방법인지
/// 모르겠네", "저런식으로 뜨는 ux가 하나가 아닐텐데"): what a press cuts off is on screen before it, beside the
/// card's 다시 켜기 or on the hover of a working connection's 탭 풀기. A press only runs against the status it was
/// made from: a line that is gone, or no status at all, and it does not run.
@MainActor
struct PressTests {
    private func problem() async throws -> Rig { await Rig(try Fixtures.status("status-problem")) }

    private func stopCalls(_ rig: Rig) -> [FakeEngineClient.Call] {
        rig.actionCalls.filter {
            switch $0 {
            case .stopGroup, .stopConnection, .restartCodex: true
            default: false
            }
        }
    }

    private func row(_ id: String, in rig: Rig) throws -> ConnectionRow {
        try #require(rig.model.content?.connections.groups.flatMap(\.rows).first { $0.id == id })
    }

    // MARK: Tidying (R17)

    @Test func tidyAndTidyAllRunAtOnce() async throws {
        let rig = try await problem()
        let ended = "claude-4001-1792300000"
        let one = rig.model.send(.tidy(ended))
        #expect(one != nil, "it ran at once")
        await one?.value
        #expect(stopCalls(rig) == [.stopConnection(ended, force: false)], "a normal stop; nothing is forced")
        let all = rig.model.send(.tidyAll)
        #expect(all != nil)
        await all?.value
    }

    @Test func anEndedConnectionStopWhoseRowIsGoneNeverRuns() async throws {
        let rig = try await problem()
        #expect(rig.model.send(.tidy("claude-1-1")) == nil)
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .info, message: "그 연결은 이제 목록에 없어요"))
        #expect(rig.actionCalls.isEmpty)
    }

    // MARK: Releasing the tabs of a connection that may be working

    static let workingHelp = "이 AI가 잡고 있는 브라우저 탭만 풀어요. 아직 일하는 중이면 하던 브라우저 작업이 끊겨요"

    @Test(arguments: ["claude-12345-1792320000", "codex-15888-1792319000"])
    func releasingAWorkingConnectionRunsAtOnceAndItsHoverSaysWhatItCutsOff(id: String) async throws {
        let rig = await Rig(try Fixtures.status("status-ready")) // both are active
        let row = try row(id, in: rig)
        #expect(row.state.text == "사용 중")
        #expect(row.button.help == Self.workingHelp)
        let task = rig.model.send(.releaseConnection(id))
        #expect(task != nil, "no question first")
        await task?.value
        #expect(rig.actionCalls == [.releaseConnection(id)])
    }

    @Test func anActiveConnectionWhoseIdleTimeIsUnknownWarnsOnHoverToo() async throws {
        var status = try Fixtures.status("status-ready")
        status.connections[0].idleSeconds = nil
        let rig = await Rig(status)
        let row = try row(status.connections[0].id, in: rig)
        #expect(row.state.text == "알 수 없음", "it reads unknown, but the contract says active")
        #expect(row.button.help == Self.workingHelp)
    }

    @Test func releasingAnIdleConnectionRunsAtOnceAndItsHoverSaysTheAIGoesOn() async throws {
        var status = try Fixtures.status("status-ready")
        status.connections[1].state = .idle // the Codex one, asleep for 42 minutes
        status.connections[1].idleSeconds = 2520
        let rig = await Rig(status)
        let id = status.connections[1].id
        #expect(try row(id, in: rig).button.help == "이 AI가 잡고 있는 브라우저 탭만 풀어요. AI는 화면 도구를 계속 써요")
        await rig.model.send(.releaseConnection(id))?.value
        #expect(rig.actionCalls.filter { if case .releaseConnection = $0 { true } else { false } } == [.releaseConnection(id)])
    }

    @Test func aConnectionThatIsNotInTheStatusIsNotReleased() async throws {
        let rig = await Rig(try Fixtures.status("status-ready"))
        #expect(rig.model.send(.releaseConnection("claude-1-1")) == nil)
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .info, message: "그 연결은 이제 목록에 없어요"))
        #expect(rig.actionCalls.isEmpty)
    }

    // MARK: Restart Codex (F1 case 2): the press is the consent

    /// The person's "이렇게 한번더 레이아웃 바꾸면서 재확인 받는게 맞는 방법인지 모르겠네": the card already says what a
    /// restart cuts off, beside the button, so a press restarts Codex without a second question under the card.
    @Test func theCardsRestartAsksNothingAndSaysBesideItWhatItCutsOff() async throws {
        let rig = try await problem()
        let fix = try #require(rig.model.summary.fix)
        #expect(fix == .restartCodex)
        #expect(rig.model.fixNote == "하던 Codex 작업이 끊겨요")
        let task = rig.model.send(fix)
        #expect(task != nil, "it ran at once")
        await task?.value
        #expect(rig.actionCalls == [.restartCodex])
    }

    @Test func aCancelledQuitSaysSoAndDoesNothingMore() async throws {
        let rig = try await problem()
        rig.engine.configure { $0.restartCodex = RestartResult(ok: false, reason: "quit_cancelled") }
        await rig.model.send(.restartCodex)?.value
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .info, message: "Codex가 종료를 취소했어요"))
        #expect(rig.model.banner?.outcome.followUp == nil)
        #expect(rig.actionCalls == [.restartCodex], "nothing else happened")
        #expect(rig.opener.openedPaths.isEmpty)
    }

    @Test func aFailedRelaunchOffersAButtonAndTheButtonOpensCodexOnlyWhenPressed() async throws {
        let rig = try await problem()
        rig.engine.configure { $0.restartCodex = RestartResult(ok: false, reason: "relaunch_failed") }
        await rig.model.send(.restartCodex)?.value
        let banner = try #require(rig.model.banner)
        #expect(banner.outcome.message == "Codex를 껐지만 다시 열지 못했어요")
        let followUp = try #require(banner.outcome.followUp)
        #expect(followUp.title == "Codex 열기")
        #expect(rig.opener.openedPaths.isEmpty, "R1: not before the click")
        // The button is a click of its own: no question, and it opens the app the status names.
        await rig.model.send(followUp.action)?.value
        #expect(rig.opener.openedPaths == ["/Applications/ChatGPT.app"])
    }

    // MARK: The restart the card offers while nothing is broken

    /// Codex's first start after its own update went without the relay; its host is ready and Claude works through it.
    private func relayMissing() async throws -> Rig {
        var status = try Fixtures.status("status-ready")
        status.setup.relay = "inactive"
        status.host.relayReason = "plugin_entry"
        status.host.restartAddsRelay = true
        return await Rig(status)
    }

    @Test func theRestartTheCardOffersSaysClaudesCUAGoesDownTooAndRunsAtOnce() async throws {
        let rig = try await relayMissing()
        #expect(rig.model.summary.problem == nil && rig.model.summary.icon == .ready)
        let fix = try #require(rig.model.summary.fix)
        #expect(fix == .restartCodex)
        #expect(rig.model.fixNote == "하던 Codex 작업과 Claude 대화의 CUA 작업이 끊겨요")
        await rig.model.send(fix)?.value
        #expect(rig.actionCalls == [.restartCodex])
    }

    @Test func theOfferedRestartIsGoneOnceARestartWouldBringNothing() async throws {
        let rig = try await relayMissing()
        #expect(rig.model.summary.fix == .restartCodex)
        // Codex was restarted meanwhile, by hand, and has the relay now.
        rig.engine.setStatus(try Fixtures.status("status-ready"))
        await rig.model.refresh()
        #expect(rig.model.summary.fix == nil)
        #expect(rig.model.fixNote == nil)
    }

    // MARK: A quit Codex took but had not finished (S10)

    /// The restart came back `quit_pending` for the Codex of the problem fixture (pid 15400).
    private func quitPending() async throws -> Rig {
        let rig = try await problem()
        rig.engine.configure { $0.restartCodex = RestartResult(ok: false, reason: "quit_pending") }
        await rig.model.send(.restartCodex)?.value
        return rig
    }

    /// One status read with Codex at `pids` (none: Codex is gone), and what it started.
    private func read(_ rig: Rig, codex pids: [Int]) async throws {
        var status = try Fixtures.status("status-problem")
        status.codex.running = !pids.isEmpty
        status.codex.pids = pids
        rig.engine.setStatus(status)
        await rig.model.refresh()
        await rig.model.waitForBackgroundWork()
    }

    @Test func aQuitStillUnderWaySaysSoAndOpensCodexInTheBackgroundOnceItIsGone() async throws {
        let rig = try await quitPending()
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .info, message: "Codex가 아직 꺼지는 중이에요 — 꺼지면 다시 켤게요"))
        rig.clock.advance(5)
        try await read(rig, codex: [15400])
        #expect(rig.opener.openedPaths.isEmpty, "the same Codex is still quitting")
        try await read(rig, codex: [])
        #expect(rig.opener.openedPaths.isEmpty, "gone on one read is not gone yet")
        rig.clock.advance(CUABarViewModel.relaunchAfterGone)
        try await read(rig, codex: [])
        #expect(rig.opener.openedPaths == ["/Applications/ChatGPT.app"])
        #expect(rig.opener.openedInBackground == [true])
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .success, message: "Codex를 다시 켰어요"))
        rig.clock.advance(60)
        try await read(rig, codex: [])
        #expect(rig.opener.openedPaths.count == 1, "opened once")
        #expect(rig.actionCalls.filter { $0 == .restartCodex }.count == 1)
    }

    @Test func whileTheQuitIsUnderWayTheCardSaysSoAndRestartWaits() async throws {
        // S10: the banner is gone in seconds, and Codex may be asking whether to quit.
        let rig = try await quitPending()
        #expect(rig.model.summary.fix == .restartCodex)
        #expect(rig.model.summary.nextStep == "Codex가 꺼지기를 기다려요 — 종료를 물으면 '종료'를 눌러 주세요. 꺼지면 다시 켤게요")
        #expect(rig.model.fixIsBusy)
        #expect(rig.model.fixHelp == "Codex가 꺼지기를 기다리는 중이에요")
        try await read(rig, codex: [15400])
        #expect(rig.model.summary.nextStep == CUABarViewModel.quitWaitStep, "the same Codex is still quitting")
        try await read(rig, codex: [])
        rig.clock.advance(CUABarViewModel.relaunchAfterGone)
        try await read(rig, codex: [])
        #expect(rig.opener.openedPaths.count == 1)
        #expect(rig.model.summary.nextStep != CUABarViewModel.quitWaitStep)
        #expect(!rig.model.fixIsBusy)
    }

    @Test func theNotificationsRestartWaitsForTheQuitToo() async throws {
        // Its 다시 켜기 stays in Notification Center; pressed while Codex asked whether to quit, it asked a second time.
        let rig = try await quitPending()
        let key = try #require(rig.notifier.delivered.first { $0.kind == .codexWithoutHost }?.key)
        rig.notifier.tap(.restartCodex(key: key))
        await rig.model.waitForBackgroundWork()
        #expect(rig.actionCalls.filter { $0 == .restartCodex }.count == 1, "only the first restart")
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .info, message: "Codex가 꺼지기를 기다리는 중이에요"))
    }

    @Test func aQuitThatOutlastsTheWaitSaysTheRestartIsOver() async throws {
        let rig = try await quitPending()
        rig.clock.advance(CUABarViewModel.relaunchWait)
        try await read(rig, codex: [15400])
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .info, message: "Codex가 10분 안에 꺼지지 않아 다시 켜기를 그만뒀어요"))
        #expect(rig.model.summary.nextStep != CUABarViewModel.quitWaitStep)
        #expect(!rig.model.fixIsBusy)
        #expect(rig.model.fixHelp == nil)
    }

    @Test func aCodexOpenedMeanwhileOrOneThatOutlastsTheWaitIsLeftAlone() async throws {
        let rig = try await quitPending()
        try await read(rig, codex: [])
        try await read(rig, codex: [15500])
        rig.clock.advance(60)
        try await read(rig, codex: [])
        rig.clock.advance(60)
        try await read(rig, codex: [])
        #expect(rig.opener.openedPaths.isEmpty, "someone opened Codex meanwhile")

        let late = try await quitPending()
        late.clock.advance(CUABarViewModel.relaunchWait)
        try await read(late, codex: [15400])
        try await read(late, codex: [])
        late.clock.advance(60)
        try await read(late, codex: [])
        #expect(late.opener.openedPaths.isEmpty, "past the wait the restart is over")
    }

    @Test func aRelaunchThatFailsOffersTheOpenButton() async throws {
        let rig = try await quitPending()
        rig.opener.succeeds = false
        try await read(rig, codex: [])
        rig.clock.advance(CUABarViewModel.relaunchAfterGone)
        try await read(rig, codex: [])
        let banner = try #require(rig.model.banner)
        #expect(banner.outcome.message == "Codex를 껐지만 다시 열지 못했어요")
        #expect(banner.outcome.followUp == ActionOutcome.FollowUp(title: "Codex 열기", action: .openCodex))
        #expect(rig.opener.openedPaths.count == 1)
    }
}
