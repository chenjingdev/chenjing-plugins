import Foundation
import Testing
@testable import cua_bar

/// R17, F1 and the active-release question: which buttons ask first, what they say, and that
/// nothing reaches the engine until the person answers yes.
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

    // MARK: Group stop (R17): the count, then one question

    @Test(arguments: [
        (StopGroup.all, "연결 3개를 끌까요?", "전체 끄기"),
        (.claude, "Claude 연결 2개를 끌까요?", "Claude만 끄기"),
        (.codex, "Codex 연결 1개를 끌까요?", "Codex만 끄기"),
    ])
    func aGroupStopSaysHowManyAndRunsOnlyAfterConfirming(group: StopGroup, title: String, confirmTitle: String) async throws {
        let rig = try await problem()
        #expect(rig.model.send(.stopGroup(group, force: false)) == nil, "it asks instead of running")
        let prompt = try #require(rig.model.confirmationPrompt)
        #expect(prompt.title == title)
        #expect(prompt.confirmTitle == confirmTitle)
        #expect(prompt.cancelTitle == "취소")
        #expect(prompt.isDestructive == false)
        #expect(stopCalls(rig).isEmpty, "nothing runs before the answer")

        let outcome = await rig.model.confirmPending()
        #expect(outcome != nil)
        #expect(rig.model.pending == nil)
        #expect(stopCalls(rig) == [.stopGroup(group, force: false)])
    }

    @Test func cmuxCuaIsNeverCountedInAGroup() async throws {
        var status = try Fixtures.status("status-problem")
        // cmux-cua runs with clients and processes of its own, each client one the engine may stop
        // (`can_stop`); none of that is a connection.
        status.otherTools.append(OtherTool(name: "cmux-cua", running: true, pids: [1, 2, 3, 4, 5], clients: [
            ToolClient(id: "cmux-5-1", pid: 9, mcpPID: 5, agent: .claude, cwd: "/a/b", canStop: true),
            ToolClient(id: "cmux-6-1", pid: 10, mcpPID: 6, agent: .codex, cwd: "/a/c", canStop: true),
        ]))
        let rig = await Rig(status)
        rig.model.send(.stopGroup(.all, force: false))
        #expect(rig.model.confirmationPrompt?.title == "연결 3개를 끌까요?")
        #expect(rig.model.confirmationPrompt?.detail?.contains("cmux-cua 같은 다른 도구는 그대로 둬요") == true)
    }

    @Test func cancelRunsNothing() async throws {
        let rig = try await problem()
        rig.model.send(.stopGroup(.all, force: false))
        #expect(rig.model.pending != nil)
        rig.model.cancelPending()
        #expect(rig.model.pending == nil)
        #expect(rig.model.confirmationPrompt == nil)
        #expect(await rig.model.confirmPending() == nil, "there is nothing left to confirm")
        #expect(stopCalls(rig).isEmpty)
    }

    @Test func theCodexGroupLeavesOutConnectionsWithoutASessionAndSaysSo() async throws {
        var status = try Fixtures.status("status-problem")
        status.connections[2].sessionID = nil // the Codex one: the engine would skip it as unattributed
        let rig = await Rig(status)
        // Nothing for `--group codex` to stop: no question, and the button is off.
        #expect(rig.model.confirmation(for: .stopGroup(.codex, force: false)) == nil)
        rig.model.send(.stopGroup(.all, force: false))
        #expect(rig.model.confirmationPrompt?.title == "연결 3개를 끌까요?", "--group all still stops it")
        // With a session-bearing Codex connection next to it, the prompt names what is left out.
        status.connections.append(Connection(
            id: "codex-77-1", agent: .codex, state: .active, cwd: "/a/b", sessionID: "019a-77", canRelease: true, canStop: true))
        let second = await Rig(status)
        second.model.send(.stopGroup(.codex, force: false))
        let prompt = try #require(second.model.confirmationPrompt)
        #expect(prompt.title == "Codex 연결 1개를 끌까요?")
        #expect(prompt.detail?.contains("주인을 모르는 1개는 빠져요") == true)
    }

    @Test func theCountInAWaitingQuestionFollowsTheLatestStatus() async throws {
        let rig = try await problem()
        rig.model.send(.stopGroup(.all, force: false))
        #expect(rig.model.confirmationPrompt?.title == "연결 3개를 끌까요?")
        var smaller = try Fixtures.status("status-problem")
        smaller.connections.removeLast()
        rig.engine.setStatus(smaller)
        await rig.model.refresh()
        await rig.model.waitForBackgroundWork()
        #expect(rig.model.confirmationPrompt?.title == "연결 2개를 끌까요?")
    }

    // MARK: Force stop (R17)

    @Test func aForceStopSaysHowManyAndWhatItCostsAndAsksOnce() async throws {
        let rig = try await problem()
        rig.model.send(.stopConnection("claude-12345-1792320000", force: true))
        let prompt = try #require(rig.model.confirmationPrompt)
        #expect(prompt.title == "Claude · dev/computer-use 연결 1개를 강제로 끌까요?")
        #expect(prompt.detail == "탭을 놓아준 뒤에도 안 꺼지면 강제로 끝내요.")
        #expect(prompt.warning == "하던 작업이 끊겨요")
        #expect(prompt.confirmTitle == "강제 종료")
        #expect(prompt.isDestructive)
        #expect(stopCalls(rig).isEmpty)
        await rig.model.confirmPending()
        #expect(stopCalls(rig) == [.stopConnection("claude-12345-1792320000", force: true)])
        #expect(rig.model.pending == nil)
    }

    @Test func aForceGroupStopAsksWithTheGroupsCount() async throws {
        let rig = try await problem()
        rig.model.send(.stopGroup(.claude, force: true))
        let prompt = try #require(rig.model.confirmationPrompt)
        #expect(prompt.title == "Claude 연결 2개를 강제로 끌까요?")
        #expect(prompt.warning == "하던 작업이 끊겨요")
        #expect(prompt.isDestructive)
    }

    @Test func aSingleNormalStopRunsAtOnce() async throws {
        let rig = try await problem()
        let task = rig.model.send(.stopConnection("claude-12345-1792320000", force: false))
        #expect(rig.model.pending == nil)
        await task?.value
        #expect(stopCalls(rig) == [.stopConnection("claude-12345-1792320000", force: false)])
    }

    // MARK: Releasing a connection that may be working

    @Test(arguments: ["claude-12345-1792320000", "codex-15888-1792319000"])
    func releasingAnActiveConnectionAsksOnceForBothAgents(id: String) async throws {
        let rig = await Rig(try Fixtures.status("status-ready")) // both are active
        #expect(rig.model.send(.releaseConnection(id)) == nil)
        let prompt = try #require(rig.model.confirmationPrompt)
        #expect(prompt.title.hasSuffix("의 점유를 놓을까요?"))
        #expect(prompt.warning == "이 대화가 아직 일하는 중이면 하던 브라우저 작업이 끊겨요")
        #expect(prompt.confirmTitle == "놓아주기")
        #expect(rig.actionCalls.isEmpty)
        await rig.model.confirmPending()
        #expect(rig.actionCalls == [.releaseConnection(id)])
        #expect(rig.model.pending == nil, "one question, then it runs")
    }

    @Test func theQuestionNamesTheConnection() async throws {
        let rig = await Rig(try Fixtures.status("status-ready"))
        rig.model.send(.releaseConnection("codex-15888-1792319000"))
        #expect(rig.model.confirmationPrompt?.title == "Codex · dev/new-chat의 점유를 놓을까요?")
    }

    @Test func releasingAnIdleOrEndedConnectionRunsAtOnce() async throws {
        let rig = try await problem()
        let idle = rig.model.send(.releaseConnection("codex-15888-1792319000")) // idle: asleep for 42 minutes
        #expect(rig.model.pending == nil)
        await idle?.value
        let ended = rig.model.send(.releaseConnection("claude-4001-1792300000"))
        #expect(rig.model.pending == nil)
        await ended?.value
        #expect(rig.actionCalls.filter { if case .releaseConnection = $0 { true } else { false } }
                == [.releaseConnection("codex-15888-1792319000"), .releaseConnection("claude-4001-1792300000")])
    }

    @Test func anActiveConnectionWhoseIdleTimeIsUnknownStillAsks() async throws {
        var status = try Fixtures.status("status-ready")
        status.connections[0].idleSeconds = nil
        status.connections[0].lastCallAt = nil
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
            .releaseEnded, .releaseSession("019a1b2c-0009", user: true), .releaseSession("019a1b2c-0009", user: false),
            .releaseLeftover, .copyDiagnosis, .runSetup, .refresh, .showLeaseGuidance, .openCodex,
            .retryRelease("claude-4001-1792300000"), .stopConnection("claude-12345-1792320000", force: false),
            .releaseConnection("claude-4001-1792300000"),
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

    // MARK: Ending the ended ones (R17)

    private func endedWithoutAControlEndpoint() throws -> EngineStatus {
        var status = try Fixtures.status("status-ready")
        for index in status.connections.indices {
            status.connections[index].state = .ended
            status.connections[index].canRelease = false
            status.connections[index].ownerAlive = false
        }
        return status
    }

    @Test func whenNoEndedConnectionCanBeReleasedTheCardStopsThemAfterOneQuestionWithTheCount() async throws {
        let rig = await Rig(try endedWithoutAControlEndpoint())
        #expect(rig.model.summary.fix == .stopEnded)
        #expect(rig.model.summary.fixLabel == "끝난 연결 끄기 2")
        rig.model.send(.stopEnded)
        let prompt = try #require(rig.model.confirmationPrompt)
        #expect(prompt.title == "끝난 연결 2개를 끌까요?")
        #expect(prompt.confirmTitle == "끝난 연결 끄기")
        #expect(rig.actionCalls.isEmpty)

        await rig.model.confirmPending()
        // `stop --connection` once for each, normal (not forced); no release, no group stop.
        #expect(rig.actionCalls == [
            .stopConnection("claude-12345-1792320000", force: false),
            .stopConnection("codex-15888-1792319000", force: false),
        ])
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .success, message: "끝난 연결 2개를 껐어요"))
    }

    @Test func endedConnectionsThatCannotBeStoppedAreNotAskedAbout() async throws {
        var status = try endedWithoutAControlEndpoint()
        status.connections[1].canStop = false
        let rig = await Rig(status)
        #expect(rig.model.summary.fixLabel == "끝난 연결 끄기 1")
        rig.model.send(.stopEnded)
        #expect(rig.model.confirmationPrompt?.title == "끝난 연결 1개를 끌까요?")
        await rig.model.confirmPending()
        #expect(rig.actionCalls == [.stopConnection("claude-12345-1792320000", force: false)])
    }

    @Test func stoppingTheEndedOnesReportsEachOnesAnswer() async throws {
        let rig = await Rig(try endedWithoutAControlEndpoint())
        rig.engine.configure {
            $0.stopConnectionByID["codex-15888-1792319000"] = StopResult(ok: false, stopped: false, released: false, reason: "protected")
        }
        rig.model.send(.stopEnded)
        let outcome = await rig.model.confirmPending()
        #expect(outcome == ActionOutcome(kind: .warning, message: "끝난 연결 1개를 껐어요 · 1개는 못 껐어요 — 앱이 건드리지 않는 프로세스예요"))
    }

    @Test func aStopThatTimesOutDoesNotStopTheRestOfTheEndedOnesFromBeingTried() async throws {
        let rig = await Rig(try endedWithoutAControlEndpoint())
        rig.engine.configure { $0.actionError = .timeout }
        rig.model.send(.stopEnded)
        let outcome = await rig.model.confirmPending()
        #expect(rig.actionCalls.count == 2, "both were tried")
        #expect(outcome == ActionOutcome(kind: .failure, message: "끝난 연결 2개를 끄지 못했어요 — 시간이 너무 오래 걸렸어요"))
    }

    // MARK: One question at a time

    @Test func aNewPressReplacesAQuestionThatIsStillWaiting() async throws {
        let rig = try await problem()
        rig.model.send(.stopGroup(.all, force: false))
        let first = try #require(rig.model.pending)
        rig.model.send(.stopGroup(.claude, force: false))
        let second = try #require(rig.model.pending)
        #expect(first.id != second.id)
        #expect(second.action == .stopGroup(.claude, force: false))
        // A press that needs no question withdraws the waiting one and runs.
        let task = rig.model.send(.copyDiagnosis)
        #expect(rig.model.pending == nil)
        await task?.value
        #expect(stopCalls(rig).isEmpty)
    }

    @Test func closingThePopoverWithdrawsTheQuestion() async throws {
        let rig = try await problem()
        rig.model.setPopoverOpen(true)
        rig.model.send(.stopGroup(.all, force: false))
        #expect(rig.model.pending != nil)
        rig.model.setPopoverOpen(false)
        #expect(rig.model.pending == nil)
        #expect(stopCalls(rig).isEmpty)
    }

    @Test func anUnreadableStatusWithdrawsTheQuestion() async throws {
        let rig = try await problem()
        rig.model.send(.stopGroup(.all, force: false))
        rig.engine.setStatusError(.pluginMissing)
        await rig.model.refresh()
        #expect(rig.model.pending == nil, "its count would be a guess now")
    }
}
