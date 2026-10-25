import Foundation
import Testing
@testable import cua_bar

/// R15: a release the engine refuses because a tool call has not finished is said on the row, with no question, and
/// its button stays 탭 풀기 to try again once the call is done (a live AI is not stopped).
@MainActor
struct ReleaseRefusalTests {
    /// Idle, so its release is not a working connection's.
    private static let target = "claude-12345-1792320000"
    private static let refused = ReleaseResult(ok: false, released: false, reason: "request_in_flight", scopeCount: 0)

    private func idleStatus() throws -> EngineStatus {
        var status = try Fixtures.status("status-problem")
        status.connections[1].state = .idle
        status.connections[1].idleSeconds = 2000
        return status
    }

    /// The popover is open on the list, as when a person presses the button.
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

    private func row(_ rig: Rig, _ id: String = target) throws -> ConnectionRow {
        try #require(rig.model.content?.connections.groups.flatMap(\.rows).first { $0.id == id })
    }

    @Test func aRefusalIsSaidOnTheRowAndItsButtonStaysTabRelease() async throws {
        let rig = try await rig([Self.refused])
        await rig.model.send(.releaseConnection(Self.target))?.value
        #expect(releaseCalls(rig) == 1)
        #expect(rig.model.refusedReleaseIDs == [Self.target])
        // The line says it by itself from now on, so it is not told a second time as a result or a banner.
        #expect(rig.model.banner == nil)
        #expect(rig.model.placedResults[.connection(Self.target)] == nil)
        // The button is 탭 풀기 still; pressing it tries again. There is no 끄기 and no 강제 종료.
        let row = try row(rig)
        #expect(row.retryButton.title == "탭 풀기")
        #expect(row.retryButton.action == .retryRelease(Self.target))
        #expect(row.retryButton.isEnabled)
        #expect(ConnectionRow.refusedNote == "작업이 끝나지 않아 못 풀었어요")
    }

    @Test func refusedWhileTheListIsNotShownTheRowSaysItWhenTheListIsBack() async throws {
        let rig = try await rig([Self.refused])
        rig.model.selectedTab = .activity
        await rig.model.send(.releaseConnection(Self.target))?.value
        #expect(rig.model.refusedReleaseIDs == [Self.target])
        rig.model.selectedTab = .connections
        #expect(rig.model.refusedReleaseIDs == [Self.target], "coming back to the list keeps it")
        #expect(try row(rig).retryButton.action == .retryRelease(Self.target))
    }

    @Test func aReleaseWaitsLongerForEachSessionItsBridgeLeftUnderAnEarlierHost() async throws {
        // The engine releases those by id after the bridge's own release; the app's limit grows with them, or it killed
        // an engine that would have finished, leaving its release thread behind.
        var status = try idleStatus()
        status.leases.maybeLeft = [
            LeftoverLease(sessionID: "019a-1", agent: .claude, connectionID: Self.target, cwd: "/a", endedAt: nil, releasable: true),
            LeftoverLease(sessionID: "019a-2", agent: .claude, connectionID: Self.target, cwd: "/a", endedAt: nil, releasable: true),
            LeftoverLease(sessionID: "019a-3", agent: .claude, connectionID: "claude-9-9", cwd: "/b", endedAt: nil, releasable: true)]
        let rig = await Rig(status)
        await rig.model.send(.releaseConnection(Self.target))?.value
        #expect(rig.engine.earlierSessionCounts == [2])
    }

    @Test func theNextTryCanSucceed() async throws {
        let rig = try await rig([Self.refused, ReleaseResult(ok: true, released: true, reason: nil, scopeCount: 1)])
        await rig.model.send(.releaseConnection(Self.target))?.value
        await rig.model.send(.retryRelease(Self.target))?.value
        #expect(rig.model.refusedReleaseIDs.isEmpty)
        #expect(rig.model.placedResults[.connection(Self.target)] == ActionOutcome(kind: .success, message: "탭을 풀었어요"))
    }

    @Test func retryFromTheRowStaysRefusedUntilItWorks() async throws {
        let rig = try await rig([Self.refused, Self.refused, ReleaseResult(ok: true, released: true, reason: nil, scopeCount: 1)])
        await rig.model.send(.releaseConnection(Self.target))?.value
        await rig.model.send(.retryRelease(Self.target))?.value // 탭 풀기 on the refused row
        #expect(rig.model.refusedReleaseIDs == [Self.target])
        #expect(releaseCalls(rig) == 2)

        await rig.model.send(.retryRelease(Self.target))?.value
        #expect(rig.model.refusedReleaseIDs.isEmpty)
        #expect(releaseCalls(rig) == 3)
    }

    @Test func aWorkingConnectionsReleaseRunsAtOnceAndItsRefusalIsSaidOnItsRow() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        engine.configure { $0.releaseConnection = Self.refused }
        let rig = await Rig(try Fixtures.status("status-ready"), engine: engine)
        rig.model.setPopoverOpen(true)
        let id = "claude-12345-1792320000"
        await rig.model.send(.releaseConnection(id))?.value
        #expect(rig.model.refusedReleaseIDs == [id])
        #expect(releaseCalls(rig) == 1)
    }

    @Test func otherFailuresAreTheLinesAnswer() async throws {
        let rig = try await rig([ReleaseResult(ok: false, released: false, reason: "relay_unavailable", scopeCount: 0)])
        await rig.model.send(.releaseConnection(Self.target))?.value
        #expect(rig.model.refusedReleaseIDs.isEmpty)
        #expect(rig.model.placedResults[.connection(Self.target)] == ActionOutcome(kind: .failure, message: "탭을 풀지 못했어요 — 중계기를 쓸 수 없어요"))
        #expect(rig.model.banner == nil, "the line is on screen, so its answer is on it")
    }

    @Test func aRefusalIsForgottenWhenTheConnectionIsGone() async throws {
        let rig = try await rig([Self.refused])
        await rig.model.send(.releaseConnection(Self.target))?.value
        #expect(rig.model.refusedReleaseIDs == [Self.target])
        var later = try idleStatus()
        later.connections.removeAll { $0.id == Self.target }
        rig.engine.setStatus(later)
        await rig.model.refresh()
        #expect(rig.model.refusedReleaseIDs.isEmpty)
    }

    @Test func anUnreadableStatusClearsTheRefusals() async throws {
        let rig = try await rig([Self.refused])
        await rig.model.send(.releaseConnection(Self.target))?.value
        #expect(rig.model.refusedReleaseIDs == [Self.target])
        rig.engine.setStatusError(.engineMissing)
        await rig.model.refresh()
        #expect(rig.model.refusedReleaseIDs.isEmpty)
    }
}
