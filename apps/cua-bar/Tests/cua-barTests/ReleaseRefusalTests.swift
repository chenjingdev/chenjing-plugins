import Foundation
import Testing
@testable import cua_bar

/// R15: a release the engine refuses because a tool call has not finished is asked about once
/// more; refused again, the row says so and offers 다시 하기 and 강제 종료.
@MainActor
struct ReleaseRefusalTests {
    private static let ended = "claude-4001-1792300000" // ended: releasing it asks nothing first
    private static let refused = ReleaseResult(ok: false, released: false, reason: "request_in_flight", scopeCount: 0)

    private func rig(_ results: [ReleaseResult]) async throws -> Rig {
        let engine = FakeEngineClient(status: try Fixtures.status("status-problem"))
        engine.configure { $0.releaseConnectionQueue = results }
        return await Rig(try Fixtures.status("status-problem"), engine: engine)
    }

    private func releaseCalls(_ rig: Rig) -> Int {
        rig.actionCalls.filter { if case .releaseConnection = $0 { true } else { false } }.count
    }

    @Test func theFirstRefusalAsksOnceMoreInsteadOfReporting() async throws {
        let rig = try await rig([Self.refused])
        await rig.model.send(.releaseConnection(Self.ended))?.value
        let question = try #require(rig.model.pending)
        #expect(question.kind == .retryRelease)
        #expect(question.action == .retryRelease(Self.ended))
        let prompt = try #require(rig.model.confirmationPrompt)
        #expect(prompt.title == "AI가 하던 조작이 아직 안 끝났어요. 한 번 더 놓아 볼까요?")
        #expect(prompt.cancelTitle == "그만두기")
        #expect(rig.model.banner == nil, "the question is the message")
        #expect(rig.model.refusedReleaseIDs.isEmpty)
        #expect(releaseCalls(rig) == 1)
    }

    @Test func refusedAgainTheRowSaysSoAndOffersRetryAndForceStop() async throws {
        let rig = try await rig([Self.refused, Self.refused])
        await rig.model.send(.releaseConnection(Self.ended))?.value
        await rig.model.confirmPending()
        #expect(releaseCalls(rig) == 2)
        #expect(rig.model.pending == nil, "it does not ask a third time")
        #expect(rig.model.refusedReleaseIDs == [Self.ended])
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .failure, message: "작업이 끝나지 않아 못 놓음"))
        let row = try #require(rig.model.content?.connections.groups.flatMap(\.rows).first { $0.id == Self.ended })
        #expect(row.refusedButtons.map(\.title) == ["다시 하기", "끄기", "강제 종료"])
        #expect(ConnectionRow.refusedNote == "작업이 끝나지 않아 못 놓음")
    }

    @Test func theSecondTryCanSucceed() async throws {
        let rig = try await rig([Self.refused, ReleaseResult(ok: true, released: true, reason: nil, scopeCount: 1)])
        await rig.model.send(.releaseConnection(Self.ended))?.value
        await rig.model.confirmPending()
        #expect(rig.model.refusedReleaseIDs.isEmpty)
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .success, message: "놓았어요"))
    }

    @Test func retryFromTheRowRunsWithoutAskingAndStaysRefusedUntilItWorks() async throws {
        let rig = try await rig([Self.refused, Self.refused, Self.refused, ReleaseResult(ok: true, released: true, reason: nil, scopeCount: 1)])
        await rig.model.send(.releaseConnection(Self.ended))?.value
        await rig.model.confirmPending()
        #expect(rig.model.refusedReleaseIDs == [Self.ended])

        await rig.model.send(.retryRelease(Self.ended))?.value // 다시 하기: a click, no question
        #expect(rig.model.pending == nil)
        #expect(rig.model.refusedReleaseIDs == [Self.ended])
        #expect(releaseCalls(rig) == 3)

        await rig.model.send(.retryRelease(Self.ended))?.value
        #expect(rig.model.refusedReleaseIDs.isEmpty)
        #expect(releaseCalls(rig) == 4)
    }

    @Test func cancellingTheQuestionStartsOverWithTheNextClick() async throws {
        let rig = try await rig([Self.refused, Self.refused])
        await rig.model.send(.releaseConnection(Self.ended))?.value
        rig.model.cancelPending()
        #expect(rig.model.pending == nil)
        #expect(rig.model.refusedReleaseIDs.isEmpty)
        // The next click is a first try again: refused, it asks once more instead of showing the row state.
        await rig.model.send(.releaseConnection(Self.ended))?.value
        #expect(rig.model.pending?.kind == .retryRelease)
        #expect(rig.model.refusedReleaseIDs.isEmpty)
    }

    @Test func aNormalStopAfterARefusedReleaseStillReportsTheStopAndReleasesNothingMore() async throws {
        let rig = try await rig([Self.refused, Self.refused])
        await rig.model.send(.releaseConnection(Self.ended))?.value
        await rig.model.confirmPending()
        #expect(rig.model.refusedReleaseIDs == [Self.ended])
        let releasesBefore = releaseCalls(rig)

        rig.engine.configure {
            $0.stopConnectionByID[Self.ended] = StopResult(ok: true, stopped: true, released: false, reason: "request_in_flight")
        }
        let outcome = await rig.model.perform(.stopConnection(Self.ended, force: false))
        #expect(outcome.kind == .warning)
        #expect(outcome.message.hasPrefix("껐어요."))
        #expect(outcome.message.contains("플러그인이 끝날 때 한 번 더 놓고, 남으면 브라우저 점유 탭에 보여요"))
        #expect(rig.model.banner?.outcome == outcome)
        #expect(releaseCalls(rig) == releasesBefore, "the app does not release again by itself")
        #expect(rig.actionCalls.last == .stopConnection(Self.ended, force: false))
    }

    @Test func aForceStopFromTheRefusedRowAsksOnce() async throws {
        let rig = try await rig([Self.refused, Self.refused])
        await rig.model.send(.releaseConnection(Self.ended))?.value
        await rig.model.confirmPending()
        rig.model.send(.stopConnection(Self.ended, force: true))
        let prompt = try #require(rig.model.confirmationPrompt)
        #expect(prompt.title.hasSuffix("연결 1개를 강제로 끌까요?"))
        #expect(prompt.isDestructive)
    }

    @Test func anActiveConnectionAsksFirstThenTheRetryQuestionThenShowsTheRowState() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        engine.configure { $0.releaseConnection = Self.refused }
        let rig = await Rig(try Fixtures.status("status-ready"), engine: engine)
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
        await rig.model.send(.releaseConnection(Self.ended))?.value
        #expect(rig.model.pending == nil)
        #expect(rig.model.refusedReleaseIDs.isEmpty)
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .failure, message: "놓지 못했어요 — 중계기를 쓸 수 없어요"))
    }

    @Test func aRefusalIsForgottenWhenTheConnectionIsGone() async throws {
        let rig = try await rig([Self.refused, Self.refused])
        await rig.model.send(.releaseConnection(Self.ended))?.value
        await rig.model.confirmPending()
        #expect(rig.model.refusedReleaseIDs == [Self.ended])
        var later = try Fixtures.status("status-problem")
        later.connections.removeAll { $0.id == Self.ended }
        rig.engine.setStatus(later)
        await rig.model.refresh()
        #expect(rig.model.refusedReleaseIDs.isEmpty)
    }

    @Test func anUnreadableStatusClearsTheRefusals() async throws {
        let rig = try await rig([Self.refused, Self.refused])
        await rig.model.send(.releaseConnection(Self.ended))?.value
        await rig.model.confirmPending()
        rig.engine.setStatusError(.pluginMissing)
        await rig.model.refresh()
        #expect(rig.model.refusedReleaseIDs.isEmpty)
    }
}
