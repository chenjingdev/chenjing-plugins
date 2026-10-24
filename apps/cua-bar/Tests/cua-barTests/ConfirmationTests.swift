import Foundation
import Testing
@testable import cua_bar

/// F1 and the working-connection question: which buttons ask first, what they say, and that
/// nothing reaches the engine until the person answers yes. 정리 and 모두 정리 ask nothing (R17).
@MainActor
struct ConfirmationTests {
    private func problem() async throws -> Rig { await Rig(try Fixtures.status("status-problem")) }

    private func stopCalls(_ rig: Rig) -> [FakeEngineClient.Call] {
        rig.actionCalls.filter {
            switch $0 {
            case .stopGroup, .stopConnection, .restartCodex: true
            default: false
            }
        }
    }

    // MARK: Tidying asks nothing (R17)

    @Test func tidyAndTidyAllRunAtOnceWithoutAQuestion() async throws {
        let rig = try await problem()
        let ended = "claude-4001-1792300000"
        #expect(rig.model.confirmation(for: .tidy(ended)) == nil)
        #expect(rig.model.confirmation(for: .tidyAll) == nil)
        let one = rig.model.send(.tidy(ended))
        #expect(one != nil, "it ran at once")
        #expect(rig.model.pending == nil)
        #expect(rig.model.confirmationPrompt == nil)
        await one?.value
        #expect(stopCalls(rig) == [.stopConnection(ended, force: false)], "a normal stop; nothing is forced unasked")
        let all = rig.model.send(.tidyAll)
        #expect(all != nil)
        #expect(rig.model.pending == nil)
        await all?.value
    }

    @Test func anEndedConnectionStopWhoseRowIsGoneNeverRunsUnasked() async throws {
        let rig = try await problem()
        #expect(rig.model.send(.tidy("claude-1-1")) == nil)
        #expect(rig.model.pending == nil)
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .info, message: "그 연결은 이제 목록에 없어요"))
        #expect(rig.actionCalls.isEmpty)
    }

    // MARK: Releasing the tabs of a connection that may be working

    @Test(arguments: ["claude-12345-1792320000", "codex-15888-1792319000"])
    func releasingAnActiveConnectionAsksOnceForBothAgents(id: String) async throws {
        let rig = await Rig(try Fixtures.status("status-ready")) // both are active
        #expect(rig.model.send(.releaseConnection(id)) == nil)
        let prompt = try #require(rig.model.confirmationPrompt)
        #expect(prompt.title.hasSuffix("의 탭을 풀까요?"))
        #expect(prompt.detail == "이 연결이 잡고 있는 브라우저 탭만 풀어요. 연결은 그대로예요.")
        #expect(prompt.warning == "이 대화가 아직 일하는 중이면 하던 브라우저 작업이 끊겨요")
        #expect(prompt.confirmTitle == "탭 풀기")
        #expect(rig.actionCalls.isEmpty)
        await rig.model.confirmPending()
        #expect(rig.actionCalls == [.releaseConnection(id)])
        #expect(rig.model.pending == nil, "one question, then it runs")
    }

    @Test func theQuestionNamesTheConnection() async throws {
        let rig = await Rig(try Fixtures.status("status-ready"))
        rig.model.send(.releaseConnection("codex-15888-1792319000"))
        #expect(rig.model.confirmationPrompt?.title == "Codex · dev/new-chat의 탭을 풀까요?")
    }

    @Test func releasingAnIdleConnectionRunsAtOnce() async throws {
        let rig = try await problem()
        let idle = rig.model.send(.releaseConnection("codex-15888-1792319000")) // idle: asleep for 42 minutes
        #expect(rig.model.pending == nil)
        await idle?.value
        #expect(rig.actionCalls.filter { if case .releaseConnection = $0 { true } else { false } }
                == [.releaseConnection("codex-15888-1792319000")])
    }

    @Test func anActiveConnectionWhoseIdleTimeIsUnknownStillAsks() async throws {
        var status = try Fixtures.status("status-ready")
        status.connections[0].idleSeconds = nil
        let rig = await Rig(status)
        let row = try #require(rig.model.content?.connections.groups.flatMap(\.rows).first { $0.id == status.connections[0].id })
        #expect(row.state.text == "알 수 없음", "it reads unknown, but the contract says active")
        rig.model.send(.releaseConnection(row.id))
        #expect(rig.model.confirmationPrompt?.warning == "이 대화가 아직 일하는 중이면 하던 브라우저 작업이 끊겨요")
    }

    @Test func aConnectionThatIsNotInTheStatusGetsNoQuestion() async throws {
        let rig = await Rig(try Fixtures.status("status-ready"))
        #expect(rig.model.confirmation(for: .releaseConnection("claude-1-1")) == nil)
    }

    @Test func aQuestionAboutAConnectionThatMeanwhileEndedIsWithdrawn() async throws {
        let rig = await Rig(try Fixtures.status("status-ready"))
        rig.model.send(.releaseConnection("claude-12345-1792320000"))
        #expect(rig.model.pending != nil)
        var later = try Fixtures.status("status-ready")
        later.connections[0].state = .ended
        rig.engine.setStatus(later)
        await rig.model.refresh()
        #expect(rig.model.pending == nil, "an ended connection needs no question")
    }

    // MARK: Clicks that are their own consent

    @Test func theseClicksNeverAsk() async throws {
        let rig = try await problem()
        let actions: [CUAAction] = [
            .tidy("claude-4001-1792300000"), .tidyAll, .releaseSession("019a1b2c-0009", user: true),
            .releaseSession("019a1b2c-0009", user: false), .copyDiagnosis, .runSetup, .refresh, .openCodex,
            .retryRelease("claude-4001-1792300000"), .releaseConnection("claude-4001-1792300000"),
        ]
        for action in actions { #expect(rig.model.confirmation(for: action) == nil, "\(action)") }
    }

    // MARK: Restart Codex (F1 case 2)

    @Test func restartingCodexAsksWithTheLineAndCallsRestartOnlyAfterConfirming() async throws {
        let rig = try await problem()
        let fix = try #require(rig.model.summary.fix)
        #expect(fix == .restartCodex)
        #expect(rig.model.send(fix) == nil)
        let prompt = try #require(rig.model.confirmationPrompt)
        #expect(prompt.title == "Codex를 다시 켤까요?")
        #expect(prompt.warning == "하던 Codex 작업이 끊겨요")
        #expect(prompt.detail == "정상 종료한 뒤 다시 켜요. 강제로 끄지 않아요.")
        #expect(prompt.confirmTitle == "다시 켜기")
        #expect(!rig.engine.calls.contains(.restartCodex), "no restart until the answer")
        await rig.model.confirmPending()
        #expect(rig.engine.calls.contains(.restartCodex))
        #expect(rig.actionCalls == [.restartCodex])
    }

    @Test func cancellingTheRestartLeavesCodexAlone() async throws {
        let rig = try await problem()
        rig.model.send(.restartCodex)
        rig.model.cancelPending()
        #expect(!rig.engine.calls.contains(.restartCodex))
    }

    @Test func aCancelledQuitSaysSoAndDoesNothingMore() async throws {
        let rig = try await problem()
        rig.engine.configure { $0.restartCodex = RestartResult(ok: false, reason: "quit_cancelled") }
        rig.model.send(.restartCodex)
        let outcome = await rig.model.confirmPending()
        #expect(outcome == ActionOutcome(kind: .info, message: "Codex가 종료를 취소했어요"))
        #expect(rig.model.banner?.outcome.message == "Codex가 종료를 취소했어요")
        #expect(rig.model.banner?.outcome.followUp == nil)
        #expect(rig.actionCalls == [.restartCodex], "nothing else happened")
        #expect(rig.opener.openedPaths.isEmpty)
    }

    @Test func aFailedRelaunchOffersAButtonAndTheButtonOpensCodexOnlyWhenPressed() async throws {
        let rig = try await problem()
        rig.engine.configure { $0.restartCodex = RestartResult(ok: false, reason: "relaunch_failed") }
        rig.model.send(.restartCodex)
        await rig.model.confirmPending()
        let banner = try #require(rig.model.banner)
        #expect(banner.outcome.message == "Codex를 껐지만 다시 열지 못했어요")
        let followUp = try #require(banner.outcome.followUp)
        #expect(followUp.title == "Codex 열기")
        #expect(rig.opener.openedPaths.isEmpty, "R1: not before the click")
        // The button is a click of its own: no question, and it opens the app the status names.
        await rig.model.send(followUp.action)?.value
        #expect(rig.opener.openedPaths == ["/Applications/ChatGPT.app"])
        #expect(rig.model.pending == nil)
    }

    // MARK: A quit Codex took but had not finished (S10)

    /// The restart came back `quit_pending` for the Codex of the problem fixture (pid 15400).
    private func quitPending() async throws -> Rig {
        let rig = try await problem()
        rig.engine.configure { $0.restartCodex = RestartResult(ok: false, reason: "quit_pending") }
        rig.model.send(.restartCodex)
        await rig.model.confirmPending()
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

    // MARK: One question at a time

    @Test func aNewPressReplacesAQuestionThatIsStillWaiting() async throws {
        let rig = try await problem()
        rig.model.send(.restartCodex)
        let first = try #require(rig.model.pending)
        rig.model.send(.releaseConnection("claude-12345-1792320000")) // active: it asks too
        let second = try #require(rig.model.pending)
        #expect(first.id != second.id)
        #expect(second.action == .releaseConnection("claude-12345-1792320000"))
        // A press that needs no question withdraws the waiting one and runs.
        let task = rig.model.send(.copyDiagnosis)
        #expect(rig.model.pending == nil)
        await task?.value
        #expect(stopCalls(rig).isEmpty)
    }

    @Test func closingThePopoverWithdrawsTheQuestion() async throws {
        let rig = try await problem()
        rig.model.setPopoverOpen(true)
        rig.model.send(.restartCodex)
        #expect(rig.model.pending != nil)
        rig.model.setPopoverOpen(false)
        #expect(rig.model.pending == nil)
        #expect(stopCalls(rig).isEmpty)
    }

    @Test func anUnreadableStatusWithdrawsTheQuestion() async throws {
        let rig = try await problem()
        rig.model.send(.restartCodex)
        rig.engine.setStatusError(.engineMissing)
        await rig.model.refresh()
        #expect(rig.model.pending == nil, "restarting now would be a guess")
    }
}
