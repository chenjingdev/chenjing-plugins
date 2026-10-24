import Foundation
import Testing
@testable import cua_bar

/// R15: a release the engine refuses because a tool call has not finished is asked about once
/// more; refused again, the row says so and its button stays 탭 풀기 (a live AI is not stopped).
@MainActor
struct ReleaseRefusalTests {
    /// Idle, so releasing its tabs asks nothing first.
    private static let target = "claude-12345-1792320000"
    private static let refused = ReleaseResult(ok: false, released: false, reason: "request_in_flight", scopeCount: 0)

    private func idleStatus() throws -> EngineStatus {
        var status = try Fixtures.status("status-problem")
        status.connections[1].state = .idle
        status.connections[1].idleSeconds = 2000
        return status
    }

    /// The popover is open: that is where the question appears (closed, the row state shows instead).
    private func rig(_ results: [ReleaseResult]) async throws -> Rig {
        let engine = FakeEngineClient(status: try idleStatus())
        engine.configure { $0.releaseConnectionQueue = results }
        let rig = await Rig(try idleStatus(), engine: engine)
        rig.model.setPopoverOpen(true)
        return rig
    }

    private func releaseCalls(_ rig: Rig) -> Int {
        rig.actionCalls.filter { if case .releaseConnection = $0 { true } else { false } }.count
    }

    @Test func theFirstRefusalAsksOnceMoreInsteadOfReporting() async throws {
        let rig = try await rig([Self.refused])
        await rig.model.send(.releaseConnection(Self.target))?.value
        let question = try #require(rig.model.pending)
        #expect(question.kind == .retryRelease)
        #expect(question.action == .retryRelease(Self.target))
        let prompt = try #require(rig.model.confirmationPrompt)
        #expect(prompt.title == "AI가 하던 조작이 아직 안 끝났어요. 한 번 더 풀어 볼까요?")
        #expect(prompt.detail == "한 번 더 안 되면 줄에서 탭 풀기를 다시 누를 수 있어요.")
        #expect(prompt.confirmTitle == "한 번 더 풀기")
        #expect(prompt.cancelTitle == "그만두기")
        #expect(rig.model.banner == nil, "the question is the message")
        #expect(rig.model.refusedReleaseIDs.isEmpty)
        #expect(releaseCalls(rig) == 1)
    }

    @Test func refusedWhileTheListIsNotShownTheRowSaysItInsteadOfAQuestionNobodySees() async throws {
        // The question is asked under the row: on 기록 it was never seen, and coming back to 연결 withdrew it, so a
        // 탭 풀기 that did nothing left no trace.
        let rig = try await rig([Self.refused])
        rig.model.selectedTab = .activity
        await rig.model.send(.releaseConnection(Self.target))?.value
        #expect(rig.model.pending == nil)
        #expect(rig.model.refusedReleaseIDs == [Self.target])
        rig.model.selectedTab = .connections
        #expect(rig.model.refusedReleaseIDs == [Self.target], "coming back to the list keeps it")
        let row = try #require(rig.model.content?.connections.groups.flatMap(\.rows).first { $0.id == Self.target })
        #expect(row.retryButton.action == .retryRelease(Self.target))
    }

    @Test func refusedAgainTheRowSaysSoAndKeepsOnlyTabRelease() async throws {
        let rig = try await rig([Self.refused, Self.refused])
        await rig.model.send(.releaseConnection(Self.target))?.value
        await rig.model.confirmPending()
        #expect(releaseCalls(rig) == 2)
        #expect(rig.model.pending == nil, "it does not ask a third time")
        #expect(rig.model.refusedReleaseIDs == [Self.target])
        // The line says it by itself from now on, so it is not told a second time as a result or a banner.
        #expect(rig.model.banner == nil)
        #expect(rig.model.placedResults[.connection(Self.target)] == nil)
        let row = try #require(rig.model.content?.connections.groups.flatMap(\.rows).first { $0.id == Self.target })
        // The button is 탭 풀기 still; pressing it tries again without asking. There is no 끄기 and no 강제 종료.
        #expect(row.retryButton.title == "탭 풀기")
        #expect(row.retryButton.action == .retryRelease(Self.target))
        #expect(row.retryButton.isEnabled)
        #expect(ConnectionRow.refusedNote == "작업이 끝나지 않아 못 풀었어요")
    }

    @Test func theSecondTryCanSucceed() async throws {
        let rig = try await rig([Self.refused, ReleaseResult(ok: true, released: true, reason: nil, scopeCount: 1)])
        await rig.model.send(.releaseConnection(Self.target))?.value
        await rig.model.confirmPending()
        #expect(rig.model.refusedReleaseIDs.isEmpty)
        #expect(rig.model.placedResults[.connection(Self.target)] == ActionOutcome(kind: .success, message: "탭을 풀었어요"))
    }

    @Test func retryFromTheRowRunsWithoutAskingAndStaysRefusedUntilItWorks() async throws {
        let rig = try await rig([Self.refused, Self.refused, Self.refused, ReleaseResult(ok: true, released: true, reason: nil, scopeCount: 1)])
        await rig.model.send(.releaseConnection(Self.target))?.value
        await rig.model.confirmPending()
        #expect(rig.model.refusedReleaseIDs == [Self.target])

        await rig.model.send(.retryRelease(Self.target))?.value // 탭 풀기 on the refused row: a click, no question
        #expect(rig.model.pending == nil)
        #expect(rig.model.refusedReleaseIDs == [Self.target])
        #expect(releaseCalls(rig) == 3)

        await rig.model.send(.retryRelease(Self.target))?.value
        #expect(rig.model.refusedReleaseIDs.isEmpty)
        #expect(releaseCalls(rig) == 4)
    }

    @Test func cancellingTheQuestionStartsOverWithTheNextClick() async throws {
        let rig = try await rig([Self.refused, Self.refused])
        await rig.model.send(.releaseConnection(Self.target))?.value
        rig.model.cancelPending()
        #expect(rig.model.pending == nil)
        #expect(rig.model.refusedReleaseIDs.isEmpty)
        // The next click is a first try again: refused, it asks once more instead of showing the row state.
        await rig.model.send(.releaseConnection(Self.target))?.value
        #expect(rig.model.pending?.kind == .retryRelease)
        #expect(rig.model.refusedReleaseIDs.isEmpty)
    }

    @Test func anActiveConnectionAsksFirstThenTheRetryQuestionThenShowsTheRowState() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        engine.configure { $0.releaseConnection = Self.refused }
        let rig = await Rig(try Fixtures.status("status-ready"), engine: engine)
        rig.model.setPopoverOpen(true)
        let id = "claude-12345-1792320000"
        rig.model.send(.releaseConnection(id))
        #expect(rig.model.pending?.kind == .standard, "first: it may be working")
        await rig.model.confirmPending()
        #expect(rig.model.pending?.kind == .retryRelease, "then: the engine refused")
        await rig.model.confirmPending()
        #expect(rig.model.pending == nil)
        #expect(rig.model.refusedReleaseIDs == [id])
        #expect(releaseCalls(rig) == 2)
    }

    @Test func otherFailuresDoNotAsk() async throws {
        let rig = try await rig([ReleaseResult(ok: false, released: false, reason: "relay_unavailable", scopeCount: 0)])
        await rig.model.send(.releaseConnection(Self.target))?.value
        #expect(rig.model.pending == nil)
        #expect(rig.model.refusedReleaseIDs.isEmpty)
        #expect(rig.model.placedResults[.connection(Self.target)] == ActionOutcome(kind: .failure, message: "탭을 풀지 못했어요 — 중계기를 쓸 수 없어요"))
        #expect(rig.model.banner == nil, "the line is on screen, so its answer is on it")
    }

    @Test func aRefusalIsForgottenWhenTheConnectionIsGone() async throws {
        let rig = try await rig([Self.refused, Self.refused])
        await rig.model.send(.releaseConnection(Self.target))?.value
        await rig.model.confirmPending()
        #expect(rig.model.refusedReleaseIDs == [Self.target])
        var later = try idleStatus()
        later.connections.removeAll { $0.id == Self.target }
        rig.engine.setStatus(later)
        await rig.model.refresh()
        #expect(rig.model.refusedReleaseIDs.isEmpty)
    }

    @Test func anUnreadableStatusClearsTheRefusals() async throws {
        let rig = try await rig([Self.refused, Self.refused])
        await rig.model.send(.releaseConnection(Self.target))?.value
        await rig.model.confirmPending()
        rig.engine.setStatusError(.engineMissing)
        await rig.model.refresh()
        #expect(rig.model.refusedReleaseIDs.isEmpty)
    }
}
