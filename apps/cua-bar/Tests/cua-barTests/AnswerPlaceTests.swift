import AppKit
import Foundation
import SwiftUI
import Testing
@testable import cua_bar

/// Ask and answer next to the button that was pressed (the person's "위아래로 클릭을 왔다갔다 시키는게 ux적으로
/// 맞는지 잘 모르겠네"): a question about a line is asked right under that line and not under the status
/// card; the answer to a line's button is one line on it; 모두 정리 answers under the head of 손볼 것; 진단
/// 복사 answers at the bottom of 기록. Only when that place is gone does the banner under the card say it.
@MainActor
struct AnswerPlaceTests {
    private static let active = "claude-12345-1792320000"

    private func fittingSize<V: View>(_ view: V) -> CGSize {
        _ = NSApplication.shared
        return NSHostingView(rootView: view).fittingSize
    }

    private func ended(_ id: String, startedAgo: TimeInterval = 100) -> Connection {
        Connection(
            id: id, agent: .claude, state: .ended, cwd: "/Users/chenjing/dev/gone",
            startedAt: Fixtures.now.addingTimeInterval(-startedAgo), sessionID: "019a-\(id)", canRelease: true, canStop: true)
    }

    // MARK: Questions

    @Test func aWorkingConnectionsQuestionIsAskedOnItsLineAndNotUnderTheCard() async throws {
        let rig = await Rig(try Fixtures.status("status-ready")) // both connections are active
        #expect(rig.model.send(.releaseConnection(Self.active)) == nil, "it asks")
        #expect(rig.model.cardConfirmationPrompt == nil, "nothing under the status card")
        let prompt = try #require(rig.model.confirmationPrompt(forConnection: Self.active))
        #expect(prompt.title == "Claude · dev/computer-use의 탭을 풀까요?")
        #expect(prompt.confirmTitle == "탭 풀기")
        #expect(rig.model.confirmationPrompt(forConnection: "codex-15888-1792319000") == nil, "only under its own line")
        rig.model.cancelPending()
        #expect(rig.model.confirmationPrompt(forConnection: Self.active) == nil)
    }

    @Test func theCardsOwnQuestionStaysUnderTheCardAndNotOnAnyLine() async throws {
        let rig = await Rig(try Fixtures.status("status-problem")) // Codex runs without its host: 다시 켜기
        #expect(rig.model.send(.restartCodex) == nil)
        #expect(rig.model.cardConfirmationPrompt?.title == "Codex를 다시 켤까요?")
        for id in ["claude-12345-1792320000", "codex-15888-1792319000", "claude-4001-1792300000"] {
            #expect(rig.model.confirmationPrompt(forConnection: id) == nil, "\(id)")
        }
    }

    @Test func theQuestionAboutARefusedReleaseIsAskedOnItsLineToo() async throws {
        let refused = ReleaseResult(ok: false, released: false, reason: "request_in_flight", scopeCount: 0)
        var status = try Fixtures.status("status-ready")
        status.connections[0].state = .idle // so the first press asks nothing and the engine refuses it
        status.connections[0].idleSeconds = 2000
        let rig = await Rig(status)
        rig.engine.configure { $0.releaseConnectionQueue = [refused] }
        rig.model.setPopoverOpen(true)
        await rig.model.send(.releaseConnection(Self.active))?.value
        #expect(rig.model.pending?.kind == .retryRelease)
        #expect(rig.model.cardConfirmationPrompt == nil)
        #expect(rig.model.confirmationPrompt(forConnection: Self.active)?.title == "AI가 하던 조작이 아직 안 끝났어요. 한 번 더 풀어 볼까요?")
    }

    @Test func aQuestionOnALineGoesWithTheTabItWasAskedOn() async throws {
        let rig = await Rig(try Fixtures.status("status-ready"))
        rig.model.send(.releaseConnection(Self.active))
        #expect(rig.model.pending != nil)
        rig.model.selectedTab = .activity // the question is on a line of the list, which is not shown now
        #expect(rig.model.pending == nil)
        // The card's own question is not about a line: it stays when the tab changes.
        let problem = await Rig(try Fixtures.status("status-problem"))
        problem.model.send(.restartCodex)
        problem.model.selectedTab = .activity
        #expect(problem.model.pending?.action == .restartCodex)
    }

    // MARK: Answers of a line

    @Test func theAnswerToALinesButtonIsOneLineOnThatLineForAWhileAndNotInTheBanner() async throws {
        var status = try Fixtures.status("status-ready")
        status.connections[1].state = .idle // the Codex one: no question
        status.connections[1].idleSeconds = 2000
        let rig = await Rig(status)
        let id = "codex-15888-1792319000"
        await rig.model.send(.releaseConnection(id))?.value
        #expect(rig.model.placedResults[.connection(id)] == ActionOutcome(kind: .success, message: "탭을 풀었어요"))
        #expect(rig.model.banner == nil, "the line is on screen: the answer is on it")
        #expect(rig.model.placedResults.count == 1)
        // It stays as long as a banner would, and then it is gone.
        #expect(rig.sleeper.pendingDurations == [.seconds(6)])
        rig.sleeper.releaseAll()
        #expect(await yieldUntil { rig.model.placedResults.isEmpty })
    }

    @Test func aNewerAnswerOnTheSameLineReplacesTheOlderAndOnlyItsOwnTimerClearsIt() async throws {
        var status = try Fixtures.status("status-ready")
        status.connections[1].state = .idle
        status.connections[1].idleSeconds = 2000
        let rig = await Rig(status)
        let id = "codex-15888-1792319000"
        await rig.model.send(.releaseConnection(id))?.value
        rig.engine.configure { $0.releaseConnection = ReleaseResult(ok: false, released: false, reason: "relay_unavailable", scopeCount: 0) }
        await rig.model.send(.releaseConnection(id))?.value
        #expect(rig.model.placedResults[.connection(id)]?.message == "탭을 풀지 못했어요 — 중계기를 쓸 수 없어요")
        #expect(rig.sleeper.cancelledCount == 1, "the older answer's timer was cancelled")
        #expect(rig.sleeper.pendingDurations == [.seconds(6)])
    }

    @Test func aLeaseLinesAnswerIsOnItAndItsFailureStaysAfterTheAnswerTimesOut() async throws {
        let rig = await Rig(try Fixtures.status("status-problem"))
        rig.engine.configure { $0.releaseSession = SessionReleaseResult(ok: true, released: false, reason: "unsupported") }
        await rig.model.send(.releaseSession("019a1b2c-0009", user: true))?.value
        let lease = try #require(rig.model.content?.connections.tidy?.rows.compactMap(\.leaseRow).first)
        #expect(rig.model.banner == nil)
        let told = try #require(TidySectionView.result(of: lease, in: rig.model))
        #expect(told.kind == .failure)
        #expect(rig.model.placedResults[.session("019a1b2c-0009")] == told)
        rig.sleeper.releaseAll()
        #expect(await yieldUntil { rig.model.placedResults.isEmpty })
        // The failure is the line's own state, as before: the same words, still on the line.
        #expect(TidySectionView.result(of: lease, in: rig.model) == told)
    }

    @Test func aLineThatLeftTheListTakesNoAnswerWithItSoTheBannerSaysIt() async throws {
        var status = try Fixtures.status("status-ready")
        status.connections.append(ended("claude-9-9"))
        let rig = await Rig(status)
        // The stop works, and the next read no longer lists the connection.
        rig.engine.setStatus(try Fixtures.status("status-ready"))
        await rig.model.send(.tidy("claude-9-9"))?.value
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .success, message: "정리했어요"))
        #expect(rig.model.placedResults[.connection("claude-9-9")] == nil, "nowhere is left to put it")
    }

    @Test func anAnswerToAPressOnALineThatIsNotListedIsInTheBanner() async throws {
        let rig = await Rig(try Fixtures.status("status-ready"))
        await rig.model.send(.tidy("claude-1-1"))?.value // gate: not in the list
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .info, message: "그 연결은 이제 목록에 없어요"))
        #expect(rig.model.placedResults.isEmpty)
    }

    @Test func theAnswerIsMovedToTheBannerWhenTheLineGoesWhileItIsStillShown() async throws {
        var status = try Fixtures.status("status-ready")
        status.connections.append(ended("claude-9-9"))
        let rig = await Rig(status)
        await rig.model.send(.tidy("claude-9-9"))?.value
        #expect(rig.model.placedResults[.connection("claude-9-9")]?.message == "정리했어요")
        #expect(rig.model.banner == nil)
        // The engine lets go of the connection a moment later, within the answer's few seconds.
        rig.engine.setStatus(try Fixtures.status("status-ready"))
        await rig.model.refresh()
        #expect(rig.model.placedResults.isEmpty)
        #expect(rig.model.banner?.outcome.message == "정리했어요")
    }

    // MARK: 모두 정리

    @Test func tidyAllAnswersUnderTheHeadOfTheTidyListWhileTheListRemains() async throws {
        var status = try Fixtures.status("status-ready")
        status.connections.append(ended("claude-1-1", startedAgo: 10))
        status.connections.append(ended("claude-2-2", startedAgo: 20))
        let rig = await Rig(status)
        // One goes, one stays (still listed after the read).
        var after = status
        after.connections.removeAll { $0.id == "claude-1-1" }
        rig.engine.setStatus(after)
        await rig.model.send(.tidyAll)?.value
        #expect(rig.model.placedResults[.tidyAll] == ActionOutcome(kind: .success, message: "2개 정리했어요"))
        #expect(rig.model.banner == nil)
        #expect(rig.model.content?.connections.tidy != nil)
    }

    @Test func tidyAllAnswersInTheBannerOnceTheTidyListIsEmptyAndGone() async throws {
        var status = try Fixtures.status("status-ready")
        status.connections.append(ended("claude-1-1", startedAgo: 10))
        status.connections.append(ended("claude-2-2", startedAgo: 20))
        let rig = await Rig(status)
        rig.engine.setStatus(try Fixtures.status("status-ready")) // everything went
        await rig.model.send(.tidyAll)?.value
        #expect(rig.model.content?.connections.tidy == nil)
        #expect(rig.model.placedResults.isEmpty)
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .success, message: "2개 정리했어요"))
    }

    // MARK: 진단 복사

    @Test func theDiagnosisCopyAnswersAtTheBottomOfActivityAndNotInTheBanner() async throws {
        let rig = await Rig(try Fixtures.status("status-ready"))
        rig.model.selectedTab = .activity // where its button is
        await rig.model.send(.copyDiagnosis)?.value
        #expect(rig.model.placedResults[.diagnosis] == ActionOutcome(kind: .success, message: "진단을 복사했어요"))
        #expect(rig.model.banner == nil, "a banner would push the popover longer, and the buttons down")
        // A failure answers there as well, and both go after a while.
        rig.engine.configure { $0.actionError = .timeout }
        await rig.model.send(.copyDiagnosis)?.value
        #expect(rig.model.placedResults[.diagnosis]?.kind == .failure)
        #expect(rig.model.banner == nil)
        rig.sleeper.releaseAll()
        #expect(await yieldUntil { rig.model.placedResults.isEmpty })
    }

    @Test func theDiagnosisCopyAnswersThereEvenWhenTheStatusCannotBeRead() async throws {
        let engine = FakeEngineClient()
        engine.setStatusError(.timeout)
        let rig = await Rig(EngineStatus(), engine: engine)
        #expect(rig.model.content == nil)
        rig.model.selectedTab = .activity
        await rig.model.send(.copyDiagnosis)?.value
        #expect(rig.model.placedResults[.diagnosis]?.message == "진단을 복사했어요")
        #expect(rig.model.banner == nil)
    }

    @Test func anAnswerOnATabThatIsNotShownIsSaidInTheBanner() async throws {
        // 진단 복사 takes up to 30 seconds: the person may have turned to 연결 by the time it answers.
        let rig = await Rig(try Fixtures.status("status-ready"))
        rig.model.selectedTab = .activity
        let copying = rig.model.send(.copyDiagnosis)
        rig.model.selectedTab = .connections
        await copying?.value
        #expect(rig.model.placedResults.isEmpty)
        #expect(rig.model.banner?.outcome.message == "진단을 복사했어요")
    }

    @Test func anAnswerShownOnATabMovesToTheBannerWhenThePersonTurnsToTheOtherTab() async throws {
        var status = try Fixtures.status("status-ready")
        status.connections[1].state = .idle // the Codex one: no question
        status.connections[1].idleSeconds = 2000
        let rig = await Rig(status)
        let id = "codex-15888-1792319000"
        await rig.model.send(.releaseConnection(id))?.value
        #expect(rig.model.placedResults[.connection(id)]?.message == "탭을 풀었어요")
        rig.model.selectedTab = .activity
        #expect(rig.model.placedResults.isEmpty, "a line of 연결 is not shown on 기록")
        #expect(rig.model.banner?.outcome.message == "탭을 풀었어요")
        // And the other way: 진단 복사's answer at the bottom of 기록, then 연결.
        await rig.model.send(.copyDiagnosis)?.value
        #expect(rig.model.placedResults[.diagnosis]?.message == "진단을 복사했어요")
        rig.model.selectedTab = .connections
        #expect(rig.model.placedResults.isEmpty)
        #expect(rig.model.banner?.outcome.message == "진단을 복사했어요")
    }

    @Test func theCardsOwnButtonsStillAnswerInTheBanner() async throws {
        let rig = await Rig(try Fixtures.status("status-problem"))
        rig.engine.configure { $0.restartCodex = RestartResult(ok: false, reason: "quit_cancelled") }
        rig.model.send(.restartCodex)
        await rig.model.confirmPending()
        #expect(rig.model.banner?.outcome.message == "Codex가 종료를 취소했어요")
        #expect(rig.model.placedResults.isEmpty)
    }

    // MARK: On screen

    @Test func aQuestionOnALineDoesNotGrowThePopoverAndTheCardsQuestionDoes() async throws {
        let model = CUABarViewModel(
            engine: FakeEngineClient(status: try Fixtures.status("status-problem")), appVersion: "0.7.0",
            clock: { Fixtures.now }, calendar: Fixtures.utc, sleep: ManualSleeper().sleep)
        await model.refresh()
        await model.waitForBackgroundWork()
        func height() -> CGFloat { fittingSize(PopoverView(model: model, quit: {})).height }
        let plain = height()
        // A working connection's question is inside the list's own room, under its line.
        model.send(.releaseConnection(Self.active))
        #expect(model.confirmationPrompt(forConnection: Self.active) != nil)
        #expect(abs(height() - plain) < 1, "under the card there is nothing new")
        model.cancelPending()
        // The card's question comes from the card's button and is under the card.
        model.send(.restartCodex)
        #expect(height() > plain + 40, "the restart question is under the card")
    }

    @Test func theDiagnosisAnswerAtTheBottomOfActivityDoesNotPushTheButtonsDown() async throws {
        let model = CUABarViewModel(
            engine: FakeEngineClient(status: try Fixtures.status("status-ready")), appVersion: "0.7.0",
            clock: { Fixtures.now }, calendar: Fixtures.utc, sleep: ManualSleeper().sleep)
        await model.refresh()
        model.selectedTab = .activity
        func height() -> CGFloat { fittingSize(PopoverView(model: model, quit: {})).height }
        let before = height()
        await model.send(.copyDiagnosis)?.value
        #expect(model.banner == nil)
        #expect(model.placedResults[.diagnosis] != nil)
        #expect(abs(height() - before) < 1, "the answer takes room inside the tab, the popover keeps its height")
        // And it is really drawn there: the bottom is one line taller with it.
        let bare = fittingSize(ActivityBottomView(copyButton: ActivityContent.diagnosisButton, copying: false, copy: {}))
        let answered = fittingSize(ActivityBottomView(
            copyButton: ActivityContent.diagnosisButton, copying: false, result: ActionOutcome(kind: .success, message: "진단을 복사했어요"), copy: {}))
        #expect(answered.height > bare.height + 8, "\(bare) vs \(answered)")
    }
}
