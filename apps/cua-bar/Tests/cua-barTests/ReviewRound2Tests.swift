import Foundation
import Testing
@testable import cua_bar

/// What the second review found (A1A2-review-2.md, items 1 to 12), each fix with its tests here.
/// The wording fixes (items 2, 9, 11) are in `ActionMessagesTests`, the time limits (item 1) in
/// `EngineClientTests`, the card's rule (item 3) also in `StatusEvaluatorTests`.
@MainActor
struct ReviewRound2Tests {
    private static let busy = ActionOutcome(kind: .info, message: "자동 정리 중이에요. 끝나면 다시 눌러 주세요")

    private func claudeLeftover(_ session: String, endedAgo seconds: TimeInterval = 20) -> LeftoverLease {
        LeftoverLease(
            sessionID: session, agent: .claude, connectionID: nil, cwd: "/Users/chenjing/dev/y",
            endedAt: Fixtures.now.addingTimeInterval(-seconds), releasable: true)
    }

    private func codexLeftover(_ session: String) -> LeftoverLease {
        LeftoverLease(sessionID: session, agent: .codex, connectionID: nil, cwd: "/Users/chenjing/dev/z", endedAt: nil, releasable: true)
    }

    /// One ended connection (releasable, stoppable), a Claude leftover and a Codex chat's leftover.
    private func somethingToCleanUp() throws -> EngineStatus {
        var status = try Fixtures.status("status-ready")
        status.connections[0].state = .ended
        status.leases.maybeLeft = [claudeLeftover("019a-claude"), codexLeftover("019a-codex")]
        return status
    }

    /// Codex runs without its host and nothing else is wrong.
    private func codexProblem() throws -> EngineStatus {
        var status = try Fixtures.status("status-problem")
        status.connections.removeAll { $0.state == .ended }
        status.leases.maybeLeft = []
        return status
    }

    // MARK: 1. The automatic cleanup's time limit follows what it has to do

    @Test func theCleanupAndThePersonsReleaseTellTheEngineHowMuchThereIsToDo() async throws {
        let status = try somethingToCleanUp()
        let rig = await Rig(status)
        #expect(rig.engine.releaseEndedLoads == [ReleaseEndedLoad(endedConnections: 1, claudeSessions: 1)])
        await rig.model.perform(.releaseEnded)
        #expect(rig.engine.releaseEndedLoads.last == ReleaseEndedLoad(endedConnections: 1, claudeSessions: 1))
    }

    // MARK: 3. Released but still ended: the card stops them next

    @Test func afterTheAutomaticRunTheCardStopsTheEndedOnesInsteadOfReleasingThemAgain() async throws {
        let status = try somethingToCleanUp()
        let gate = AsyncGate()
        let engine = FakeEngineClient(status: status)
        engine.configure { $0.actionGate = gate }
        defer { gate.open() }
        let rig = await Rig(status, engine: engine, refresh: false)
        await rig.model.refresh()
        #expect(rig.model.summary.fix == .releaseEnded, "until the run is done, the release stays")
        gate.open()
        await rig.model.waitForBackgroundWork()
        // The engine keeps a released connection `ended` while its runtime lives.
        #expect(rig.model.summary.headline == "끝난 연결이 1개 남아 있어요")
        #expect(rig.model.summary.fix == .stopEnded)
        #expect(rig.model.summary.fixLabel == "끝난 연결 끄기 1")
        // It asks once, then stops it normally.
        rig.model.send(.stopEnded)
        #expect(rig.model.confirmationPrompt?.title == "끝난 연결 1개를 끌까요?")
        await rig.model.confirmPending()
        #expect(rig.engine.calls.filter { $0 != .status }.last == .stopConnection(status.connections[0].id, force: false))
    }

    @Test func aPersonsReleaseThatWentThroughCountsAsTriedToo() async throws {
        var status = try Fixtures.status("status-ready")
        status.connections[0].state = .ended
        let gate = AsyncGate()
        let engine = FakeEngineClient(status: status)
        engine.configure { $0.actionGate = gate }
        defer { gate.open() }
        let rig = await Rig(status, engine: engine, refresh: false)
        // The person's 끝난 연결 놓아주기 is under way before the app got to clean up by itself.
        let release = Task { await rig.model.perform(.releaseEnded) }
        #expect(await yieldUntil { engine.calls.contains(.releaseEnded) })
        await rig.model.refresh()
        #expect(!rig.model.isCleaningUp, "never beside the person's own action")
        #expect(rig.model.summary.fix == .releaseEnded)
        gate.open()
        _ = await release.value
        #expect(rig.model.summary.fix == .stopEnded)
    }

    @Test func aReleaseThatFailedIsNotCountedAsTried() async throws {
        var status = try Fixtures.status("status-ready")
        status.connections[0].state = .ended
        let id = status.connections[0].id
        let gate = AsyncGate()
        let engine = FakeEngineClient(status: status)
        engine.configure {
            $0.actionGate = gate
            $0.releaseEnded = ReleaseEndedResult(ok: false, results: [EndedRelease(connectionID: id, released: false, reason: "relay_unavailable")])
        }
        defer { gate.open() }
        let rig = await Rig(status, engine: engine, refresh: false)
        let release = Task { await rig.model.perform(.releaseEnded) }
        #expect(await yieldUntil { engine.calls.contains(.releaseEnded) })
        gate.open()
        _ = await release.value
        #expect(rig.model.summary.fix == .releaseEnded)
    }

    // MARK: 4. The automatic cleanup is visible, and what would collide with it waits

    @Test func whileTheCleanupRunsItsButtonsWaitAndAPressSaysWhy() async throws {
        let status = try somethingToCleanUp()
        let gate = AsyncGate()
        let engine = FakeEngineClient(status: status)
        engine.configure { $0.actionGate = gate }
        defer { gate.open() }
        let rig = await Rig(status, engine: engine, refresh: false)
        await rig.model.refresh()
        #expect(await yieldUntil { engine.calls.contains(.releaseEnded) })
        #expect(rig.model.isCleaningUp)

        // The card's fix, 끝난 연결 놓아주기 and the Claude session rows show busy, with why.
        #expect(rig.model.summary.fix == .releaseEnded)
        #expect(rig.model.fixIsBusy)
        let content = try #require(rig.model.content)
        #expect(rig.model.cleanupHelp(for: content.connections.releaseEndedButton.action) == "자동 정리 중이에요")
        let claudeRow = try #require(content.leases.rows.first { $0.sessionID == "019a-claude" }?.releaseButton)
        let codexRow = try #require(content.leases.rows.first { $0.sessionID == "019a-codex" }?.releaseButton)
        #expect(rig.model.waitsForAutomaticCleanup(claudeRow.action))
        #expect(rig.model.cleanupHelp(for: claudeRow.action) == "자동 정리 중이에요")
        #expect(!rig.model.waitsForAutomaticCleanup(codexRow.action), "a Codex chat is not the cleanup's")
        for action: CUAAction in [.releaseLeftover, .stopEnded] { #expect(rig.model.waitsForAutomaticCleanup(action), "\(action)") }
        for action: CUAAction in [.restartCodex, .runSetup, .stopGroup(.all, force: false), .releaseConnection(status.connections[1].id)] {
            #expect(!rig.model.waitsForAutomaticCleanup(action), "\(action)")
        }
        // S18: the row of the ended connection it releases waits too, and says why; the live one does not.
        let ended = status.connections[0].id, live = status.connections[1].id
        #expect(rig.model.isWaiting(onConnection: ended))
        #expect(rig.model.cleanupHelp(onConnection: ended) == "자동 정리 중이에요")
        for action: CUAAction in [.releaseConnection(ended), .stopConnection(ended, force: true), .retryRelease(ended)] {
            #expect(rig.model.waitsForAutomaticCleanup(action), "\(action)")
        }
        #expect(!rig.model.isWaiting(onConnection: live))
        #expect(rig.model.cleanupHelp(onConnection: live) == nil)

        // A press that still arrives does not run and is not queued.
        #expect(rig.model.send(.releaseEnded) == nil)
        #expect(rig.model.banner?.outcome == Self.busy)
        rig.model.dismissBanner()
        #expect(rig.model.send(claudeRow.action) == nil)
        #expect(rig.model.banner?.outcome == Self.busy)
        #expect(rig.model.send(.stopEnded) == nil)
        #expect(rig.model.pending == nil, "no question either")
        #expect(await rig.model.perform(.releaseLeftover) == Self.busy)

        gate.open()
        await rig.model.waitForBackgroundWork()
        #expect(!rig.model.isCleaningUp)
        #expect(!rig.model.fixIsBusy)
        #expect(rig.model.cleanupHelp(for: .releaseEnded) == nil)
        #expect(!rig.model.isWaiting(onConnection: ended))
        #expect(rig.model.cleanupHelp(onConnection: ended) == nil)
        #expect(rig.engine.calls.filter { $0 != .status } == [.releaseEnded], "only the cleanup's own call, and nothing after it")
    }

    // MARK: 5. The card's leftover release goes on after an error

    @Test func theCardsLeftoverReleaseTriesTheRestAfterAnErrorAndCountsIt() async throws {
        var status = try Fixtures.status("status-ready")
        status.leases.maybeLeft = [claudeLeftover("019a-a"), claudeLeftover("019a-b")]
        let rig = await Rig(status) // the automatic run is over
        #expect(rig.model.summary.fix == .releaseLeftover)
        rig.engine.configure {
            $0.releaseSessionErrorByID["019a-a"] = .timeout
            $0.releaseSession = SessionReleaseResult(ok: true, released: true, reason: nil, tabCount: 2)
        }
        rig.model.guidanceOpenByUser = false
        let outcome = await rig.model.perform(.releaseLeftover)
        #expect(rig.actionCalls == [.releaseSession("019a-a", user: false), .releaseSession("019a-b", user: false)])
        #expect(rig.model.sessionResults["019a-a"] == ActionOutcome(kind: .failure, message: "풀지 못했어요 — 응답이 없어 기다리다 멈췄어요"))
        #expect(rig.model.sessionResults["019a-b"] == ActionOutcome(kind: .success, message: "탭 2개를 놓았어요"))
        #expect(outcome == ActionOutcome(kind: .warning, message: "남은 세션 2개 중 1개의 점유를 놓았어요 (탭 2개) — 나머지는 시간이 너무 오래 걸렸어요"))
        // A timeout points at the extension reset: the guidance opens for that row.
        #expect(rig.model.failedSessionIDs == ["019a-a"])
        #expect(rig.model.selectedTab == .leases)
        #expect(rig.model.guidanceOpenByUser == true)
    }

    // MARK: 6. Stale questions are withdrawn

    private func refusing() async throws -> Rig {
        let refused = ReleaseResult(ok: false, released: false, reason: "request_in_flight", scopeCount: 0)
        let engine = FakeEngineClient(status: try Fixtures.status("status-problem"))
        engine.configure { $0.releaseConnectionQueue = [refused, refused] }
        return await Rig(try Fixtures.status("status-problem"), engine: engine)
    }

    private static let ended = "claude-4001-1792300000"
    private static let active = "claude-12345-1792320000"

    @Test func theRetryQuestionGoesWhenItsConnectionLeavesTheList() async throws {
        let rig = try await refusing()
        rig.model.setPopoverOpen(true)
        await rig.model.send(.releaseConnection(Self.ended))?.value
        #expect(rig.model.pending?.kind == .retryRelease)
        var later = try Fixtures.status("status-problem")
        later.connections.removeAll { $0.id == Self.ended }
        rig.engine.setStatus(later)
        await rig.model.refresh()
        #expect(rig.model.pending == nil)
        #expect(await rig.model.confirmPending() == nil)
    }

    @Test func theRetryQuestionGoesWhenTheStatusCannotBeRead() async throws {
        let rig = try await refusing()
        rig.model.setPopoverOpen(true)
        await rig.model.send(.releaseConnection(Self.ended))?.value
        #expect(rig.model.pending?.kind == .retryRelease)
        rig.engine.setStatusError(.pluginMissing)
        await rig.model.refresh()
        #expect(rig.model.pending == nil)
    }

    @Test func aRefusalWhileThePopoverIsClosedShowsTheRowStateInsteadOfAQuestion() async throws {
        let rig = try await refusing()
        await rig.model.send(.releaseConnection(Self.ended))?.value
        #expect(rig.model.pending == nil, "a question in a closed popover would be stale when it opens")
        #expect(rig.model.refusedReleaseIDs == [Self.ended])
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .failure, message: "작업이 끝나지 않아 못 놓음"))
        let row = try #require(rig.model.content?.connections.groups.flatMap(\.rows).first { $0.id == Self.ended })
        #expect(row.refusedButtons.map(\.title) == ["다시 하기", "끄기", "강제 종료"])
    }

    @Test func theForceStopQuestionGoesWhenItsConnectionLeavesOrTheStatusCannotBeRead() async throws {
        let rig = await Rig(try Fixtures.status("status-problem"))
        rig.model.send(.stopConnection(Self.active, force: true))
        #expect(rig.model.pending != nil)
        var later = try Fixtures.status("status-problem")
        later.connections.removeAll { $0.id == Self.active }
        rig.engine.setStatus(later)
        await rig.model.refresh()
        #expect(rig.model.pending == nil)

        let second = await Rig(try Fixtures.status("status-problem"))
        second.model.send(.stopConnection(Self.active, force: true))
        #expect(second.model.pending != nil)
        second.engine.setStatusError(.pluginMissing)
        await second.model.refresh()
        #expect(second.model.pending == nil)
        #expect(second.actionCalls.isEmpty)
    }

    @Test func aForceStopOfAConnectionThatIsNoLongerListedNeitherAsksNorRuns() async throws {
        let rig = await Rig(try Fixtures.status("status-problem"))
        #expect(rig.model.send(.stopConnection("claude-1-1", force: true)) == nil)
        #expect(rig.model.pending == nil)
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .info, message: "그 연결은 이제 목록에 없어요"))
        #expect(rig.actionCalls.isEmpty)
    }

    @Test func theRestartQuestionGoesWhenTheStatusCannotBeReadOrCodexHasItsHost() async throws {
        let rig = await Rig(try codexProblem())
        rig.model.send(.restartCodex)
        #expect(rig.model.pending != nil)
        var healthy = try codexProblem()
        healthy.host.state = .ready
        rig.engine.setStatus(healthy)
        await rig.model.refresh()
        #expect(rig.model.pending == nil, "restarting now would only cut work off")

        let second = await Rig(try codexProblem())
        second.model.send(.restartCodex)
        #expect(second.model.pending != nil)
        second.engine.setStatusError(.pluginMissing)
        await second.model.refresh()
        #expect(second.model.pending == nil)
        #expect(!second.engine.calls.contains(.restartCodex))
    }

    // MARK: 7. An action that has to ask does not run without a status to ask from

    @Test(arguments: [
        CUAAction.stopGroup(.all, force: false), .stopGroup(.claude, force: true), .stopConnection("claude-12345-1792320000", force: true),
        .stopEnded, .restartCodex, .releaseConnection("claude-12345-1792320000"),
    ])
    func withoutAStatusAnActionThatMustAskDoesNotRun(action: CUAAction) async throws {
        let engine = FakeEngineClient()
        engine.setStatusError(.timeout)
        let rig = await Rig(EngineStatus(), engine: engine)
        #expect(rig.model.content == nil)
        #expect(rig.model.send(action) == nil)
        #expect(rig.model.pending == nil)
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .info, message: "상태를 읽은 뒤 다시 눌러 주세요"))
        #expect(rig.actionCalls.isEmpty)
    }

    // MARK: 8. The notification's 다시 켜기: the result shows in the popover

    @Test func theNotificationsRestartWithoutAStatusSaysSoInThePopover() async throws {
        let rig = await Rig(try codexProblem())
        let key = try #require(rig.notifier.delivered.first?.key)
        var opened = 0
        rig.model.openPopoverHandler = { opened += 1 }
        rig.engine.setStatusError(.pluginMissing)
        await rig.model.refresh()
        rig.notifier.tap(.restartCodex(key: key))
        await rig.model.waitForBackgroundWork()
        #expect(opened == 1, "the person just clicked: the answer is shown")
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .info, message: "상태를 읽지 못해 다시 켜지 않았어요. 잠시 뒤 다시 눌러 주세요"))
        #expect(!rig.engine.calls.contains(.restartCodex))
    }

    @Test func theNotificationsRestartOpensThePopoverForItsResult() async throws {
        let rig = await Rig(try codexProblem())
        let key = try #require(rig.notifier.delivered.first?.key)
        var opened = 0
        rig.model.openPopoverHandler = { opened += 1 }
        rig.notifier.tap(.restartCodex(key: key))
        await rig.model.waitForBackgroundWork()
        #expect(opened == 1)
        #expect(rig.actionCalls == [.restartCodex])
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .success, message: "Codex를 다시 켰어요"))
    }

    // MARK: 10. 점유 보기 only shows the tab

    @Test func showLeasesOnlySelectsTheTab() async throws {
        var status = try Fixtures.status("status-ready")
        status.leases.maybeLeft = [codexLeftover("019a-codex")]
        let rig = await Rig(status)
        #expect(rig.model.summary.fix == .showLeases)
        #expect(rig.model.summary.fixLabel == "점유 보기")
        rig.model.selectedTab = .activity
        await rig.model.send(.showLeases)?.value
        #expect(rig.model.selectedTab == .leases)
        #expect(rig.model.guidanceOpenByUser == nil, "the extension-reset guidance is left as it was")
        #expect(rig.model.banner == nil)
        #expect(rig.actionCalls.isEmpty)
    }

    // MARK: 12. Finished background work is dropped

    @Test func finishedBackgroundTasksAreDropped() async throws {
        let rig = await Rig(try codexProblem())
        #expect(rig.notifier.delivered.count == 1, "a notification went out")
        #expect(rig.model.backgroundTaskCount == 0)
        rig.model.start() // asks for notification permission in the background
        rig.notifier.tap(.restartCodex(key: try #require(rig.notifier.delivered.first?.key)))
        #expect(rig.model.backgroundTaskCount == 2)
        await rig.model.waitForBackgroundWork()
        #expect(rig.model.backgroundTaskCount == 0)
        rig.model.stop()
    }
}

/// Item 11: the lingering-lease notification for a session from before Codex restarted.
struct OldHostNotificationTests {
    private let t0 = Fixtures.now

    private func due(_ entry: LeftoverLease) throws -> AppNotification? {
        var status = try Fixtures.status("status-ready") // claude-12345 is active
        status.leases.maybeLeft = [entry]
        var planner = NotificationPlanner()
        let tried: Set<String> = ["lease:" + (entry.sessionID ?? "")]
        _ = planner.due(status: status, appVersion: "0.7.0", now: t0, cleanupTried: tried, cleanupRunning: false)
        return planner.due(status: status, appVersion: "0.7.0", now: t0.addingTimeInterval(61), cleanupTried: tried, cleanupRunning: false).first
    }

    @Test func aSessionOfABridgeThatStillRunsIsNotCalledAnEndedConnection() throws {
        let old = LeftoverLease(
            sessionID: "019a-old", agent: .claude, connectionID: "claude-12345-1792320000",
            cwd: "/Users/chenjing/dev/computer-use", endedAt: nil, releasable: true)
        let notification = try #require(try due(old))
        #expect(notification.body.hasPrefix("Codex가 다시 켜지기 전 세션의 점유가 1분 넘게 남아 있어요"))
        #expect(!notification.body.contains("연결이 끝난 지"))
    }

    @Test func aWriterThatIsGoneWithoutAnEndTimeStillReadsAsAnEndedConnection() throws {
        // A killed writer has no `ended_at` either (P4), but its connection is not running.
        let killed = LeftoverLease(
            sessionID: "019a-killed", agent: .claude, connectionID: "claude-777-1792000000",
            cwd: "/Users/chenjing/dev/y", endedAt: nil, releasable: true)
        let notification = try #require(try due(killed))
        #expect(notification.body.hasPrefix("Claude · dev/y 연결이 끝난 지 1분이 넘었는데"))
    }
}
