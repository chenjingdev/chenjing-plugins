import Foundation
import Testing
@testable import cua_bar

/// Codex 26.1023 lets only the conversations the desktop app started use the browser, so the engine's own
/// conversations are refused and every release by session id ends in `browser_blocked`. That is Codex's access
/// control: the Chrome extension reset does not help, so the guidance for it stays shut and the screen stays where it is.
@MainActor
struct BrowserBlockedTests {
    private static let line = "Codex가 Claude 대화의 브라우저 사용을 막아서 풀 수 없어요"
    private static let blocked = SessionReleaseResult(ok: true, released: false, reason: "browser_blocked")

    private func base() throws -> EngineStatus { try Fixtures.status("status-ready") }

    private func lease(_ session: String) -> LeftoverLease {
        LeftoverLease(sessionID: session, agent: .claude, connectionID: nil, cwd: "/Users/chenjing/dev/y", endedAt: nil, releasable: true)
    }

    private func ended(_ id: String) -> Connection {
        Connection(
            id: id, agent: .claude, state: .ended, cwd: "/Users/chenjing/dev/gone", sessionID: "019a-\(id)",
            canRelease: true, canStop: true)
    }

    // MARK: The words

    @Test func theReasonHasOneLineAndDoesNotPointAtTheExtension() {
        #expect(ActionMessages.reason("browser_blocked") == Self.line)
        #expect(ActionMessages.browserBlocked == Self.line)
        #expect(!CUABarViewModel.reasonsPointingAtTheExtension.contains("browser_blocked"))
        #expect(ActionMessages.releaseSession(Self.blocked) == ActionOutcome(kind: .failure, message: Self.line))
        #expect(ActionMessages.releaseConnection(ReleaseResult(ok: false, released: false, reason: "browser_blocked"))
                == ActionOutcome(kind: .failure, message: Self.line))
        // The other reasons keep their lead-in.
        #expect(ActionMessages.releaseSession(SessionReleaseResult(ok: true, released: false, reason: "unsupported")).message
                == "탭을 풀지 못했어요 — \(ActionMessages.reason("unsupported"))")
    }

    // MARK: 탭 풀기 of one session

    @Test func aBlockedReleaseOfOneSessionOpensNoGuidanceAndMovesNothing() async throws {
        let rig = await Rig(try Fixtures.status("status-problem"))
        rig.engine.configure { $0.releaseSession = Self.blocked }
        rig.model.guidanceOpenByUser = false
        rig.model.selectedTab = .activity
        await rig.model.perform(.releaseSession("019a1b2c-0009", user: true))
        #expect(rig.model.sessionResults["019a1b2c-0009"] == ActionOutcome(kind: .failure, message: Self.line))
        #expect(rig.model.failedSessionIDs.isEmpty)
        #expect(rig.model.guidanceOpenByUser == false, "the guidance is not opened for it, nor opened again")
        #expect(rig.model.selectedTab == .activity)
    }

    // MARK: 모두 정리

    @Test func tidyingEverythingStopsAtTheFirstBlockedSessionAndStaysOnItsTab() async throws {
        var status = try base()
        status.leases.maybeLeft = [lease("019a-one"), lease("019a-two"), lease("019a-three")]
        let rig = await Rig(status)
        rig.engine.configure { $0.releaseSession = Self.blocked }
        rig.model.guidanceOpenByUser = false
        rig.model.selectedTab = .activity
        await rig.model.send(.tidyAll)?.value
        let released = rig.actionCalls.filter { if case .releaseSession = $0 { true } else { false } }
        #expect(released.count == 1, "the sessions that are left are not asked")
        // The person is on another tab, so the answer is said in the banner: the screen is not moved to the list.
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .failure, message: "정리하지 못했어요 — \(Self.line)"))
        #expect(rig.model.selectedTab == .activity)
        #expect(rig.model.guidanceOpenByUser == false)
        #expect(rig.model.failedSessionIDs.isEmpty)
    }

    @Test func aSessionThatWasReleasedBeforeTheBlockStillCounts() async throws {
        var status = try base()
        status.leases.maybeLeft = [lease("019a-ok"), lease("019a-blocked"), lease("019a-never-asked")]
        let rig = await Rig(status)
        rig.engine.configure {
            $0.releaseSessionByID["019a-ok"] = SessionReleaseResult(ok: true, released: true, reason: nil, tabCount: 2)
            $0.releaseSessionByID["019a-blocked"] = Self.blocked
        }
        await rig.model.send(.tidyAll)?.value
        let released = rig.actionCalls.filter { if case .releaseSession = $0 { true } else { false } }
        #expect(released == [.releaseSession("019a-ok", user: false), .releaseSession("019a-blocked", user: false)])
        #expect(rig.model.placedResults[.tidyAll] == ActionOutcome(kind: .warning, message: "1개 정리, 1개는 못 했어요 — \(Self.line)"))
    }

    // MARK: The automatic cleanup

    @Test func theAutomaticCleanupDoesNotTryAgainInThisRunAfterABlock() async throws {
        var status = try base()
        status.connections.append(ended("claude-9-9"))
        let engine = FakeEngineClient(status: status)
        engine.configure {
            $0.releaseEnded = ReleaseEndedResult(
                ok: false, results: [EndedRelease(connectionID: "claude-9-9", released: false, reason: "browser_blocked")])
        }
        let rig = await Rig(status, engine: engine, refresh: false)
        await rig.model.refresh()
        await rig.model.waitForBackgroundWork()
        #expect(engine.calls.filter { $0 == .releaseEnded }.count == 1)
        // A new session, status after status: it is not tried.
        status.leases.maybeLeft = [lease("019a-new")]
        engine.setStatus(status)
        for _ in 0..<3 {
            await rig.model.refresh()
            await rig.model.waitForBackgroundWork()
        }
        #expect(engine.calls.filter { $0 == .releaseEnded }.count == 1)
        #expect(rig.model.banner == nil)
    }

    @Test func butAnEndedConnectionIsStillCleanedAndTheEngineIsToldToLeaveTheSessionsOut() async throws {
        // The ended connections are released through their own writers; they never reach the browser.
        var status = try base()
        status.connections.append(ended("claude-9-9"))
        status.leases.maybeLeft = [lease("019a-left")]
        let engine = FakeEngineClient(status: status)
        engine.configure {
            $0.releaseEnded = ReleaseEndedResult(
                ok: false, results: [EndedRelease(connectionID: "claude-9-9", released: false, reason: "browser_blocked")])
        }
        let rig = await Rig(status, engine: engine, refresh: false)
        await rig.model.refresh()
        await rig.model.waitForBackgroundWork()
        status.connections.append(ended("claude-10-10"))
        engine.setStatus(status)
        for _ in 0..<3 {
            await rig.model.refresh()
            await rig.model.waitForBackgroundWork()
        }
        #expect(engine.releaseEndedLoads.count == 2, "the new connection is tried, once")
        #expect(engine.releaseEndedLoads[0].withSessions == true)
        #expect(engine.releaseEndedLoads[1] == ReleaseEndedLoad(endedConnections: 2, claudeSessions: 0, withSessions: false))
        #expect(rig.model.banner == nil)
    }

    @Test func aBlockSeenOnAButtonStopsTheAutomaticCleanupToo() async throws {
        let rig = await Rig(try Fixtures.status("status-problem"))
        rig.engine.configure { $0.releaseSession = Self.blocked }
        await rig.model.perform(.releaseSession("019a1b2c-0009", user: true))
        var status = try Fixtures.status("status-problem")
        status.leases.maybeLeft.append(lease("019a-new"))
        rig.engine.setStatus(status)
        let before = rig.engine.calls.filter { $0 == .releaseEnded }.count
        for _ in 0..<2 {
            await rig.model.refresh()
            await rig.model.waitForBackgroundWork()
        }
        #expect(rig.engine.calls.filter { $0 == .releaseEnded }.count == before)
    }

    @Test func afterABlockThePlannerStillListsEndedConnectionsButNoSessions() throws {
        var status = try base()
        status.connections.append(ended("claude-9-9"))
        status.leases.maybeLeft = [lease("019a-left")]
        var planner = CleanupPlanner()
        #expect(Set(planner.untried(in: status)) == ["connection:claude-9-9", "lease:019a-left"])
        planner.markBrowserBlocked()
        #expect(planner.untried(in: status) == ["connection:claude-9-9"])
        planner.markTried(["connection:claude-9-9"])
        #expect(planner.untried(in: status).isEmpty)
    }

    @Test func thePlannerStopsOnlyWhenToldTo() {
        var planner = CleanupPlanner()
        planner.markTried(["connection:a"])
        #expect(planner.browserBlocked == false)
        planner.markBrowserBlocked()
        #expect(planner.browserBlocked)
    }
}
