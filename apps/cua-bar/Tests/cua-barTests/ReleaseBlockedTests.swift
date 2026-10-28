import Foundation
import Testing
@testable import cua_bar

/// The user's screen of 0.8.7 under Codex 26.1023: seven Claude conversations that may have left a lease behind, ended
/// at 11:48, the lease list unreadable, and the engine saying that this Codex refuses the browser to it
/// (`leases.release_blocked`).
enum ReleaseBlockedFixture {
    static let sessions = (1...7).map { "019a-left-\($0)" }
    static let endedAt = Date(timeIntervalSince1970: 1_792_324_800 - 12 * 60)        // 11:48 UTC, the fixtures' day

    static func status(blocked: Bool, ended: Bool = false) throws -> EngineStatus {
        var status = try Fixtures.status("status-ready")
        if ended { status.connections[0].state = .ended }
        status.leases.readable = false
        status.leases.releaseBlocked = blocked
        status.leases.maybeLeft = sessions.enumerated().map { index, session in
            LeftoverLease(
                sessionID: session, agent: .claude, connectionID: "claude-\(7000 + index)-1792300000",
                cwd: "/Users/chenjing/dev/tmp/2026-10-28/new-chat-\(index + 1)", endedAt: endedAt, releasable: true)
        }
        return status
    }
}

/// 0.8.8: the leftover leases Codex refuses to let go of are dismissed, not released, and are no problem of the card.
@MainActor
struct ReleaseBlockedTests {
    private func dismissed(_ rig: Rig) -> [String] {
        rig.actionCalls.compactMap { if case .dismissSession(let id) = $0 { id } else { nil } }
    }

    private func released(_ rig: Rig) -> Int {
        rig.actionCalls.filter { if case .releaseSession = $0 { true } else { false } }.count
    }

    @Test func theEngineSaysItInTheLeases() throws {
        let json = #"{"readable": false, "items": [], "maybe_left": [], "release_blocked": true}"#
        #expect(try JSONDecoder().decode(Leases.self, from: Data(json.utf8)).releaseBlocked)
        let older = #"{"readable": false, "items": [], "maybe_left": []}"#
        #expect(try JSONDecoder().decode(Leases.self, from: Data(older.utf8)).releaseBlocked == false, "an engine before 0.8.8")
    }

    @Test func aLinesDismissCallsTheEngineAndTheLineLeaves() async throws {
        let rig = await Rig(try ReleaseBlockedFixture.status(blocked: true))
        let row = try #require(rig.model.content?.connections.tidy?.rows.compactMap(\.leaseRow).first)
        let button = try #require(row.button)
        #expect(button.action == .dismissSession("019a-left-1"))
        await rig.model.send(button.action)?.value
        #expect(dismissed(rig) == ["019a-left-1"])
        #expect(released(rig) == 0)
        #expect(rig.model.content?.connections.tidy?.rows.compactMap(\.leaseRow).count == 6)
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .success, message: "목록에서 지웠어요"), "the line left, so it is told above")
    }

    @Test func aDismissTheEngineRefusesSaysWhyOnTheLine() async throws {
        let rig = await Rig(try ReleaseBlockedFixture.status(blocked: true))
        rig.engine.configure { $0.dismissSession = DismissResult(ok: false, dismissed: false, reason: "session_live") }
        await rig.model.send(.dismissSession("019a-left-2"))?.value
        #expect(rig.model.placedResults[.session("019a-left-2")]
                == ActionOutcome(kind: .failure, message: "지우지 못했어요 — 살아 있는 연결이 아직 이 세션을 쓰고 있어요"))
        #expect(rig.model.failedSessionIDs.isEmpty, "the extension guidance does not open for it")
    }

    @Test func tidyAllDismissesTheseLinesAndReleasesNone() async throws {
        let rig = await Rig(try ReleaseBlockedFixture.status(blocked: true, ended: true))
        #expect(TidyPlan.items(in: try ReleaseBlockedFixture.status(blocked: true))
                == ReleaseBlockedFixture.sessions.map(TidyPlan.Item.dismiss))
        await rig.model.send(.tidyAll)?.value
        #expect(dismissed(rig) == ReleaseBlockedFixture.sessions)
        #expect(released(rig) == 0)
        // The ended connection is tidied as before.
        #expect(rig.actionCalls.contains(.stopConnection("claude-12345-1792320000", force: false)))
        #expect(rig.model.placedResults[.tidyAll] == ActionOutcome(kind: .success, message: "8개 정리했어요")
                || rig.model.banner?.outcome == ActionOutcome(kind: .success, message: "8개 정리했어요"))
        #expect(rig.model.selectedTab == .connections && rig.model.guidanceOpenByUser == nil)
    }

    @Test func notBlockedTidyAllStillReleasesTheClaudeSessions() async throws {
        let rig = await Rig(try ReleaseBlockedFixture.status(blocked: false))
        await rig.model.send(.tidyAll)?.value
        #expect(released(rig) == 7)
        #expect(dismissed(rig).isEmpty)
    }

    @Test func theseLinesGetNoNotificationAndNoAutomaticTry() async throws {
        let clock = TestClock()
        let engine = FakeEngineClient(status: try ReleaseBlockedFixture.status(blocked: true))
        let rig = await Rig(try ReleaseBlockedFixture.status(blocked: true), engine: engine, clock: clock)
        for _ in 0..<3 {
            clock.advance(120)
            await rig.model.refresh()
            await rig.model.waitForBackgroundWork()
        }
        #expect(rig.notifier.delivered.isEmpty, "nobody can release them, so nobody is asked to")
        #expect(!engine.calls.contains(.releaseEnded))

        // Not blocked: the cleanup tries them and, a minute on, the notifications come as before.
        let openClock = TestClock()
        let openEngine = FakeEngineClient(status: try ReleaseBlockedFixture.status(blocked: false))
        let open = await Rig(try ReleaseBlockedFixture.status(blocked: false), engine: openEngine, clock: openClock)
        openClock.advance(120)
        await open.model.refresh()
        await open.model.waitForBackgroundWork()
        #expect(openEngine.calls.contains(.releaseEnded))
        #expect(open.notifier.delivered.map(\.kind).allSatisfy { $0 == .lingeringLease } && !open.notifier.delivered.isEmpty)
    }

    @Test func anEndedConnectionIsStillCleanedAutomaticallyButTheSessionsAreLeftOut() async throws {
        let engine = FakeEngineClient(status: try ReleaseBlockedFixture.status(blocked: true, ended: true))
        let rig = await Rig(try ReleaseBlockedFixture.status(blocked: true, ended: true), engine: engine)
        #expect(engine.releaseEndedLoads == [ReleaseEndedLoad(endedConnections: 1, claudeSessions: 0, withSessions: false)])
        #expect(rig.model.summary.problem?.kind == .endedConnections, "the ended connection is still the card's to say")
    }

    @Test func theCardSaysNothingAboutTheseLinesButStillAboutOthers() throws {
        let status = try ReleaseBlockedFixture.status(blocked: true)
        #expect(StatusEvaluator.problem(in: status, appVersion: nil) == nil)
        #expect(StatusEvaluator.problem(in: try ReleaseBlockedFixture.status(blocked: false), appVersion: nil)?.kind == .leasesMaybeLeft)
        #expect(StatusEvaluator.problem(in: try ReleaseBlockedFixture.status(blocked: true, ended: true), appVersion: nil)?.kind
                == .endedConnections)
    }

    @Test func aLeaseALiveConnectionHoldsHasNoDismiss() throws {
        var status = try ReleaseBlockedFixture.status(blocked: true)
        status.leases.maybeLeft = [LeftoverLease(
            sessionID: status.connections[0].sessionID, agent: .claude, connectionID: nil, cwd: "/x", endedAt: nil, releasable: false)]
        status.connections[0].canRelease = false         // its 탭 풀기 is off, so the lease keeps a line of its own
        let content = ConnectionsContent(status: status, now: Fixtures.now, calendar: Fixtures.utc)
        let row = try #require(content.tidy?.rows.compactMap(\.leaseRow).first)
        #expect(row.button == nil && row.hint == LeaseRow.heldByLiveHint)
        #expect(TidyPlan.items(in: status).isEmpty)
    }

    @Test func theEngineClientRunsDismissSession() async throws {
        #expect(EngineTimeouts().dismissSession == .seconds(20))
        #expect(ActionMessages.dismissSession(DismissResult(ok: true, dismissed: true, reason: nil)).message == "목록에서 지웠어요")
        #expect(TidyStep(dismiss: DismissResult(ok: true, dismissed: true, reason: nil)).isDone)
        #expect(TidyStep(dismiss: DismissResult(ok: false, dismissed: false, reason: "not_found")) == .failed("not_found"))
    }
}
