import Foundation
import Testing
@testable import cua_bar

/// F1 case 2 and R16: two kinds of notification, each once, and nothing else changes when they
/// cannot be shown (R21).
struct NotificationPlannerTests {
    private let t0 = Fixtures.now

    private func codexStatus(pids: [Int] = [15400]) throws -> EngineStatus {
        var status = try Fixtures.status("status-problem")
        status.codex.pids = pids
        status.connections.removeAll { $0.state == .ended } // leave only the Codex-without-host problem
        status.leases.maybeLeft = []
        return status
    }

    private func leaseStatus(_ entries: [LeftoverLease]) throws -> EngineStatus {
        var status = try Fixtures.status("status-ready")
        status.leases.maybeLeft = entries
        return status
    }

    private func codexLease(_ id: String, endedAt: Date?) -> LeftoverLease {
        LeftoverLease(sessionID: id, agent: .codex, connectionID: nil, cwd: "/Users/chenjing/dev/y", endedAt: endedAt, releasable: true)
    }

    // MARK: Codex without a host

    @Test func codexWithoutAHostIsDueOncePerCodexProcess() throws {
        var planner = NotificationPlanner()
        let first = planner.due(status: try codexStatus(), appVersion: "0.7.0", now: t0, cleanupTried: [], cleanupRunning: false)
        #expect(first.map(\.kind) == [.codexWithoutHost])
        #expect(first.first?.key == "codex:15400")
        // Still being posted: not due again.
        #expect(planner.due(status: try codexStatus(), appVersion: "0.7.0", now: t0, cleanupTried: [], cleanupRunning: false).isEmpty)
        planner.finish("codex:15400", wasDelivered: true, now: t0)
        #expect(planner.due(status: try codexStatus(), appVersion: "0.7.0", now: t0.addingTimeInterval(3600), cleanupTried: [], cleanupRunning: false).isEmpty)
        // Another Codex app process (other pids) is another notification, in any order of pids.
        let again = planner.due(status: try codexStatus(pids: [15999, 15400]), appVersion: "0.7.0", now: t0, cleanupTried: [], cleanupRunning: false)
        #expect(again.first?.key == "codex:15400,15999")
        planner.finish("codex:15400,15999", wasDelivered: true, now: t0)
        #expect(planner.due(status: try codexStatus(pids: [15400, 15999]), appVersion: "0.7.0", now: t0, cleanupTried: [], cleanupRunning: false).isEmpty)
    }

    @Test func theCodexNotificationSaysRestartingInterruptsWorkAndOffersTheButton() throws {
        var planner = NotificationPlanner()
        let notification = try #require(
            planner.due(status: try codexStatus(), appVersion: "0.7.0", now: t0, cleanupTried: [], cleanupRunning: false).first)
        #expect(notification.title == "Codex가 연결 없이 켜져 있어요")
        #expect(notification.body.contains("하던 Codex 작업이 끊겨요"))
        #expect(notification.buttons == [.restartCodex])
    }

    @Test func noCodexNotificationWhileAnotherProblemIsTheOneShown() throws {
        var planner = NotificationPlanner()
        var status = try codexStatus()
        status.setup.wrapper = "broken" // setup_incomplete outranks codex_without_host: a restart would not help
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0, cleanupTried: [], cleanupRunning: false).isEmpty)
        status.setup.wrapper = "ready"
        status.host.state = .ready // and with a host there is no problem at all
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0, cleanupTried: [], cleanupRunning: false).isEmpty)
    }

    @Test func aPostThatDidNotGoOutIsTriedAgainNoSoonerThanAMinute() throws {
        var planner = NotificationPlanner()
        let status = try codexStatus()
        _ = planner.due(status: status, appVersion: "0.7.0", now: t0, cleanupTried: [], cleanupRunning: false)
        planner.finish("codex:15400", wasDelivered: false, now: t0)
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0.addingTimeInterval(30), cleanupTried: [], cleanupRunning: false).isEmpty)
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0.addingTimeInterval(61), cleanupTried: [], cleanupRunning: false).count == 1)
    }

    // MARK: Lingering leases (R16)

    @Test func aLeaseIsDueOnlyAfterTheOwnerHasBeenGoneForMoreThanAMinute() throws {
        var planner = NotificationPlanner()
        let endedAt = t0.addingTimeInterval(-100)
        let status = try leaseStatus([codexLease("019a-1", endedAt: endedAt)])
        // 59 s and exactly 60 s after it ended: not yet.
        #expect(planner.due(status: status, appVersion: "0.7.0", now: endedAt.addingTimeInterval(59), cleanupTried: [], cleanupRunning: false).isEmpty)
        #expect(planner.due(status: status, appVersion: "0.7.0", now: endedAt.addingTimeInterval(60), cleanupTried: [], cleanupRunning: false).isEmpty)
        let due = planner.due(status: status, appVersion: "0.7.0", now: endedAt.addingTimeInterval(61), cleanupTried: [], cleanupRunning: false)
        #expect(due.map(\.kind) == [.lingeringLease])
        #expect(due.first?.key == "lease:019a-1")
        #expect(due.first?.title == "브라우저 탭이 아직 잡혀 있을 수 있어요")
        #expect(due.first?.body.contains("Codex · dev/y") == true)
        #expect(due.first?.buttons == [])
    }

    @Test func aLeaseIsNotifiedOncePerSessionForTheLifeOfTheApp() throws {
        var planner = NotificationPlanner()
        let endedAt = t0.addingTimeInterval(-300)
        let one = try leaseStatus([codexLease("019a-1", endedAt: endedAt)])
        _ = planner.due(status: one, appVersion: "0.7.0", now: t0, cleanupTried: [], cleanupRunning: false)
        planner.finish("lease:019a-1", wasDelivered: true, now: t0)
        #expect(planner.due(status: one, appVersion: "0.7.0", now: t0.addingTimeInterval(600), cleanupTried: [], cleanupRunning: false).isEmpty)
        // It disappears and comes back: still the same session, still once.
        let none = try leaseStatus([])
        _ = planner.due(status: none, appVersion: "0.7.0", now: t0.addingTimeInterval(700), cleanupTried: [], cleanupRunning: false)
        #expect(planner.due(status: one, appVersion: "0.7.0", now: t0.addingTimeInterval(800), cleanupTried: [], cleanupRunning: false).isEmpty)
        // Another session is another notification.
        let two = try leaseStatus([codexLease("019a-1", endedAt: endedAt), codexLease("019a-2", endedAt: endedAt)])
        #expect(planner.due(status: two, appVersion: "0.7.0", now: t0.addingTimeInterval(900), cleanupTried: [], cleanupRunning: false).map(\.key) == ["lease:019a-2"])
    }

    @Test func whenTheEndTimeIsNullTheClockStartsWhenTheAppFirstSawTheEntry() throws {
        var planner = NotificationPlanner()
        let status = try leaseStatus([codexLease("019a-old-host", endedAt: nil)])
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0, cleanupTried: [], cleanupRunning: false).isEmpty)
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0.addingTimeInterval(60), cleanupTried: [], cleanupRunning: false).isEmpty)
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0.addingTimeInterval(61), cleanupTried: [], cleanupRunning: false).count == 1)
    }

    @Test func anEntryThatLeftTheListStartsItsMinuteOverIfItComesBack() throws {
        var planner = NotificationPlanner()
        let status = try leaseStatus([codexLease("019a-x", endedAt: nil)])
        _ = planner.due(status: status, appVersion: "0.7.0", now: t0, cleanupTried: [], cleanupRunning: false)
        _ = planner.due(status: try leaseStatus([]), appVersion: "0.7.0", now: t0.addingTimeInterval(50), cleanupTried: [], cleanupRunning: false)
        // Back at +70 s: first seen again just now, so not due until a minute later.
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0.addingTimeInterval(70), cleanupTried: [], cleanupRunning: false).isEmpty)
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0.addingTimeInterval(131), cleanupTried: [], cleanupRunning: false).count == 1)
    }

    @Test func aClaudeSessionTheAppReleasesByItselfIsNotNotifiedUntilThatHasFailed() throws {
        var planner = NotificationPlanner()
        let entry = LeftoverLease(sessionID: "019a-claude", agent: .claude, connectionID: nil, cwd: nil, endedAt: t0.addingTimeInterval(-600), releasable: true)
        let status = try leaseStatus([entry])
        let key = "lease:019a-claude"
        // Not tried yet, or being tried right now: wait.
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0, cleanupTried: [], cleanupRunning: false).isEmpty)
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0, cleanupTried: [key], cleanupRunning: true).isEmpty)
        // Tried, finished, and still listed: now it is worth a notification.
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0, cleanupTried: [key], cleanupRunning: false).count == 1)
    }

    @Test func aClaudeSessionTheEngineCannotAimAtIsNotWaitedFor() throws {
        var planner = NotificationPlanner()
        let entry = LeftoverLease(sessionID: "019a-claude", agent: .claude, connectionID: nil, cwd: nil, endedAt: t0.addingTimeInterval(-600), releasable: false)
        #expect(planner.due(status: try leaseStatus([entry]), appVersion: "0.7.0", now: t0, cleanupTried: [], cleanupRunning: false).count == 1)
    }

    /// S21 itself is stopped one level down. The engine asks a release that could not be confirmed once more; a
    /// release confirmed at once takes the session out of the dead bridge's record, and one confirmed only when asked
    /// again lets the same cleanup release the session by id through the browser (`ReleaseBookingTests`,
    /// `SecondAskTests` in tests/cua), so the next status has no such lease and there is nothing to notify. What is left here is a
    /// release that stayed unconfirmed after both asks: it waits for the cleanup, and then it is worth a minute's news.
    @Test func aLeaseAnEndedConnectionStillServesWaitsForThatConnectionsCleanup() throws {
        var planner = NotificationPlanner()
        let entry = LeftoverLease(sessionID: "019a-claude", agent: .claude, connectionID: "claude-31569-1", cwd: nil, endedAt: t0.addingTimeInterval(-600), releasable: false)
        var status = try leaseStatus([entry])
        status.connections = [Connection(id: "claude-31806-1", agent: .claude, state: .ended, sessionID: "019a-claude", canRelease: true, canStop: true)]
        let key = "connection:claude-31806-1"
        // The cleanup that lets go of the connection lets go of the lease too: not tried yet, or being tried now, wait.
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0, cleanupTried: [], cleanupRunning: false).isEmpty)
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0, cleanupTried: [key], cleanupRunning: true).isEmpty)
        // Tried, finished, and the lease is still listed: now it is worth a notification.
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0, cleanupTried: [key], cleanupRunning: false).map(\.key) == ["lease:019a-claude"])
    }

    @Test func aLeaseOfAnEndedConnectionTheCleanupCannotReachIsNotWaitedFor() throws {
        var planner = NotificationPlanner()
        let entry = LeftoverLease(sessionID: "019a-claude", agent: .claude, connectionID: "claude-31569-1", cwd: nil, endedAt: t0.addingTimeInterval(-600), releasable: false)
        var status = try leaseStatus([entry])
        status.connections = [Connection(id: "claude-31806-1", agent: .claude, state: .ended, sessionID: "019a-claude", canRelease: false, canStop: true)]
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0, cleanupTried: [], cleanupRunning: false).count == 1)
    }

    @Test func aLeaseALiveConnectionHoldsIsNeverNewsOfAnOwnerThatIsGone() throws {
        var planner = NotificationPlanner()
        let entry = LeftoverLease(sessionID: "019a-live", agent: .codex, connectionID: "codex-23654-1", cwd: nil, endedAt: nil, releasable: false)
        var status = try leaseStatus([entry])
        status.connections = [Connection(id: "claude-23601-1", agent: .claude, state: .idle, sessionID: "019a-live", canRelease: true, canStop: true)]
        // The owner is there, with its 탭 풀기 or without it: nothing was left behind, so there is nothing to say.
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0, cleanupTried: [], cleanupRunning: false).isEmpty)
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0.addingTimeInterval(3600), cleanupTried: [], cleanupRunning: false).isEmpty)
        status.connections[0].canRelease = false
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0.addingTimeInterval(7200), cleanupTried: [], cleanupRunning: false).isEmpty)
        // The owner goes (an ended line the app cannot tidy): the lease is news a minute after the app saw it without one.
        status.connections[0].state = .ended
        status.connections[0].canStop = false
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0.addingTimeInterval(10_800), cleanupTried: [], cleanupRunning: false).isEmpty)
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0.addingTimeInterval(10_861), cleanupTried: [], cleanupRunning: false).map(\.key) == ["lease:019a-live"])
    }

    @Test func theMinuteOfAHeldLeaseCountsFromTheOwnerGoingEvenWhenItsEndTimeIsOld() throws {
        // The lease the dead relay left (it ended long ago, `ended_at` says so) is held by a live conversation. When that
        // conversation is closed the lease is news a minute after the app first sees it without one, not at once.
        var planner = NotificationPlanner()
        let entry = LeftoverLease(sessionID: "019a-live", agent: .claude, connectionID: "codex-23654-1", cwd: nil, endedAt: t0.addingTimeInterval(-50_000), releasable: false)
        var status = try leaseStatus([entry])
        status.connections = [Connection(id: "claude-23601-1", agent: .claude, state: .idle, sessionID: "019a-live", canRelease: true, canStop: true)]
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0, cleanupTried: [], cleanupRunning: false).isEmpty)
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0.addingTimeInterval(3600), cleanupTried: [], cleanupRunning: false).isEmpty)
        status.connections[0].state = .ended
        status.connections[0].canStop = false
        status.connections[0].canRelease = false // an ended line with no way: nothing to wait for
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0.addingTimeInterval(7200), cleanupTried: [], cleanupRunning: false).isEmpty,
                "the first look without the owner: not news yet, however old ended_at is")
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0.addingTimeInterval(7260), cleanupTried: [], cleanupRunning: false).isEmpty)
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0.addingTimeInterval(7261), cleanupTried: [], cleanupRunning: false).map(\.key) == ["lease:019a-live"])
    }

    @Test func aLeaseNobodyLiveEverHeldKeepsCountingFromItsEndTime() throws {
        var planner = NotificationPlanner()
        let entry = LeftoverLease(sessionID: "019a-old", agent: .codex, connectionID: nil, cwd: nil, endedAt: t0.addingTimeInterval(-50_000), releasable: false)
        #expect(planner.due(status: try leaseStatus([entry]), appVersion: "0.7.0", now: t0, cleanupTried: [], cleanupRunning: false).map(\.key) == ["lease:019a-old"])
    }

    @Test func anEndedLineTheAppHasDoneAllItCanForDoesNotHoldTheNotificationBack() throws {
        var planner = NotificationPlanner()
        let entry = LeftoverLease(sessionID: "019a-claude", agent: .claude, connectionID: "claude-31569-1", cwd: nil, endedAt: t0.addingTimeInterval(-600), releasable: false)
        var status = try leaseStatus([entry])
        status.connections = [Connection(id: "claude-31806-1", agent: .claude, state: .ended, sessionID: "019a-claude", canRelease: true, canStop: false)]
        // The line's 정리 releases the tabs: the cleanup comes first.
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0, cleanupTried: [], cleanupRunning: false).isEmpty)
        // Its tabs already released in this run, the 정리 is off: there is no way left on that line, so the lease is news.
        #expect(planner.due(status: status, appVersion: "0.7.0", now: t0, cleanupTried: [], cleanupRunning: false, tabsReleased: ["claude-31806-1"]).map(\.key) == ["lease:019a-claude"])
    }

    @Test func anEntryWithNoSessionIsKeyedByItsConnection() throws {
        var planner = NotificationPlanner()
        let entry = LeftoverLease(sessionID: nil, agent: .codex, connectionID: "codex-5-5", cwd: nil, endedAt: t0.addingTimeInterval(-600), releasable: false)
        #expect(planner.due(status: try leaseStatus([entry]), appVersion: "0.7.0", now: t0, cleanupTried: [], cleanupRunning: false).first?.key == "lease:codex-5-5")
        let nameless = LeftoverLease(sessionID: nil, agent: .codex, connectionID: nil, cwd: nil, endedAt: t0.addingTimeInterval(-600), releasable: false)
        #expect(planner.due(status: try leaseStatus([nameless]), appVersion: "0.7.0", now: t0, cleanupTried: [], cleanupRunning: false).isEmpty)
    }

    // MARK: Clicks

    @Test func whatEachClickMeans() {
        #expect(NotificationResponse.make(tap: .body, kind: .codexWithoutHost, key: "codex:1") == .openPopover(nil))
        // A lingering lease opens 연결: its line is at the top of that list.
        #expect(NotificationResponse.make(tap: .body, kind: .lingeringLease, key: "lease:a") == .openPopover(.connections))
        #expect(NotificationResponse.make(tap: .body, kind: .newVersion, key: "new-version-0.7.1") == .openPopover(nil))
        #expect(NotificationResponse.make(tap: .dismissed, kind: .newVersion, key: "new-version-0.7.1") == nil)
        #expect(NotificationResponse.make(tap: .button(.restartCodex), kind: .codexWithoutHost, key: "codex:1") == .restartCodex(key: "codex:1"))
        #expect(NotificationResponse.make(tap: .button(.restartCodex), kind: .lingeringLease, key: "lease:a") == nil)
        #expect(NotificationResponse.make(tap: .dismissed, kind: .codexWithoutHost, key: "codex:1") == nil)
    }
}

/// The same, through the view model with a fake notification center: what is posted, what a
/// click does, and that a person who said no changes nothing else.
@MainActor
struct NotificationViewModelTests {
    private func codexProblem() throws -> EngineStatus {
        var status = try Fixtures.status("status-problem")
        status.connections.removeAll { $0.state == .ended }
        status.leases.maybeLeft = []
        return status
    }

    @Test func permissionIsAskedOnceWhenTheAppStarts() async throws {
        let rig = await Rig(try codexProblem(), refresh: false)
        #expect(rig.notifier.authorizationRequests == 0, "not before the app starts")
        rig.model.start()
        rig.model.start()
        await rig.model.waitForBackgroundWork()
        rig.model.stop()
        #expect(rig.notifier.authorizationRequests == 1)
    }

    @Test func theSettingIsReadAtTheStartAndEachTimeThePopoverOpens() async throws {
        let notifier = FakeNotifier(allowed: false)
        let rig = await Rig(try codexProblem(), notifier: notifier, refresh: false)
        #expect(rig.model.notificationPermission == .unavailable, "nothing read before the start")
        rig.model.start()
        await rig.model.waitForBackgroundWork()
        rig.model.stop()
        #expect(rig.model.notificationPermission == .off)
        // Turned on in System Settings: the next look at the popover knows.
        notifier.setAllowed(true)
        rig.model.setPopoverOpen(true)
        await rig.model.waitForBackgroundWork()
        #expect(rig.model.notificationPermission == .allowed)
        #expect(notifier.authorizationRequests == 1, "reading never asks")
    }

    @Test func theCopiedDiagnosisSaysWhereNotificationsStand() async throws {
        let rig = await Rig(try codexProblem(), notifier: FakeNotifier(allowed: false))
        rig.engine.configure { $0.diagnosis = "codex-cua diagnose\n" }
        await rig.model.perform(.copyDiagnosis)
        // The lines of the 점검 tab sit between the engine's text and this line (see CheckDiagnosisTests).
        #expect(rig.pasteboard.copied.last.map(CheckFixtures.withoutCheckLines) == "codex-cua diagnose\n알림: 꺼짐\n")
    }

    @Test func eachSettingHasItsLineAndOnlyOffOrUnansweredOffersTurningThemOn() {
        #expect(NotificationPermission.allowed.diagnosisLine == "알림: 켜짐")
        #expect(NotificationPermission.notDecided.diagnosisLine == "알림: 아직 허용하지 않음")
        #expect(NotificationPermission.off.diagnosisLine == "알림: 꺼짐")
        #expect(NotificationPermission.unavailable.diagnosisLine == "알림: 쓸 수 없음")
        #expect([NotificationPermission.allowed, .notDecided, .off, .unavailable].filter(\.offersTurningOn) == [.notDecided, .off])
        #expect(NotificationPermission.settingsURL.absoluteString.hasPrefix(
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id="))
    }

    @Test func anUnansweredQuestionIsAskedAgainFromTheFooterInsteadOfOpeningSettings() async throws {
        // The app started while the screen was locked: its question failed at once.
        let notifier = FakeNotifier()
        notifier.setUndecided(answer: .notDecided)
        let rig = await Rig(try codexProblem(), notifier: notifier, refresh: false)
        rig.model.start()
        await rig.model.waitForBackgroundWork()
        rig.model.stop()
        #expect(rig.model.notificationPermission == .notDecided)
        // Someone at the screen presses 알림 켜기: the question shows and they allow it.
        notifier.setUndecided(answer: .allowed)
        #expect(await rig.model.turnOnNotifications() == false, "System Settings stay closed")
        #expect(rig.model.notificationPermission == .allowed)
        #expect(notifier.authorizationRequests == 2)
    }

    @Test func settingsOpenWhenNotificationsAreOffOrTheQuestionStillGoesUnanswered() async throws {
        let notifier = FakeNotifier(allowed: false)
        let rig = await Rig(try codexProblem(), notifier: notifier, refresh: false)
        rig.model.setPopoverOpen(true)
        await rig.model.waitForBackgroundWork()
        #expect(rig.model.notificationPermission == .off)
        #expect(await rig.model.turnOnNotifications())
        #expect(notifier.authorizationRequests == 0, "a no is changed only in System Settings")

        notifier.setUndecided(answer: .notDecided)
        rig.model.setPopoverOpen(false)
        rig.model.setPopoverOpen(true)
        await rig.model.waitForBackgroundWork()
        #expect(await rig.model.turnOnNotifications(), "the system did not show it")
        #expect(notifier.authorizationRequests == 1)
        #expect(rig.model.notificationPermission == .notDecided)
    }

    @Test func codexWithoutAHostIsPostedOnceAndTheCardShowsItToo() async throws {
        let rig = await Rig(try codexProblem())
        #expect(rig.notifier.delivered.count == 1)
        let notification = try #require(rig.notifier.delivered.first)
        #expect(notification.kind == .codexWithoutHost)
        #expect(notification.buttons == [.restartCodex])
        for _ in 0..<3 {
            await rig.model.refresh()
            await rig.model.waitForBackgroundWork()
        }
        #expect(rig.notifier.delivered.count == 1, "once per Codex process")
        #expect(rig.model.summary.problem?.kind == .codexWithoutHost)
        // A new Codex process is a new notification.
        var restarted = try codexProblem()
        restarted.codex.pids = [16000]
        rig.engine.setStatus(restarted)
        await rig.model.refresh()
        await rig.model.waitForBackgroundWork()
        #expect(rig.notifier.delivered.count == 2)
    }

    @Test func aPersonWhoSaidNoGetsNothingPostedAndTheIconAndCardStillShowTheProblem() async throws {
        let rig = await Rig(try codexProblem(), notifier: FakeNotifier(allowed: false))
        #expect(rig.notifier.delivered.isEmpty)
        #expect(rig.notifier.attempts == 1)
        // R21: the problem is all there without it.
        #expect(rig.model.summary.icon == .problem)
        #expect(rig.model.summary.problem?.kind == .codexWithoutHost)
        #expect(rig.model.summary.fix == .restartCodex)
        #expect(rig.model.summary.tooltip == "CUA 문제 · Codex가 연결 없이 켜져 있어요")
        #expect(rig.model.content != nil)
        // It does not hammer a refusing system: within a minute no further attempt.
        await rig.model.refresh()
        await rig.model.waitForBackgroundWork()
        #expect(rig.notifier.attempts == 1)
        // Switched on later, the notification still goes out.
        rig.notifier.setAllowed(true)
        rig.clock.advance(61)
        await rig.model.refresh()
        await rig.model.waitForBackgroundWork()
        #expect(rig.notifier.delivered.count == 1)
    }

    @Test func aLingeringLeaseIsPostedOnlyAfterAMinuteAndOncePerSession() async throws {
        var status = try Fixtures.status("status-ready")
        let endedAt = Fixtures.now.addingTimeInterval(-30)
        status.leases.maybeLeft = [LeftoverLease(sessionID: "019a-1", agent: .codex, connectionID: nil, cwd: "/a/b", endedAt: endedAt, releasable: true)]
        let rig = await Rig(status)
        #expect(rig.notifier.delivered.isEmpty, "gone for 30 s only")
        rig.clock.advance(31) // 61 s since it ended
        await rig.model.refresh()
        await rig.model.waitForBackgroundWork()
        #expect(rig.notifier.delivered.map(\.kind) == [.lingeringLease])
        for _ in 0..<2 {
            rig.clock.advance(30)
            await rig.model.refresh()
            await rig.model.waitForBackgroundWork()
        }
        #expect(rig.notifier.delivered.count == 1, "once per session")
        status.leases.maybeLeft.append(LeftoverLease(sessionID: "019a-2", agent: .codex, connectionID: nil, cwd: "/a/c", endedAt: endedAt, releasable: false))
        rig.engine.setStatus(status)
        await rig.model.refresh()
        await rig.model.waitForBackgroundWork()
        #expect(rig.notifier.delivered.count == 2)
    }

    @Test func onlyThoseTwoKindsEverGoOut() async throws {
        var status = try Fixtures.status("status-ready")
        status.connections[0].state = .ended // an ended connection is a problem, not a notification
        status.connections[0].canRelease = false
        status.setup.relay = "unavailable"
        status.engine.version = "0.6.0"
        let rig = await Rig(status)
        #expect(rig.notifier.attempts == 0)
        #expect(rig.model.summary.icon == .problem)
    }

    @Test func clickingTheBodyOpensThePopoverAndAMatchingTab() async throws {
        let rig = await Rig(try codexProblem())
        var opened = 0
        rig.model.openPopoverHandler = { opened += 1 }
        rig.model.selectedTab = .activity
        rig.notifier.tap(.openPopover(nil))
        #expect(opened == 1)
        #expect(rig.model.selectedTab == .activity, "a Codex notification leaves the tab alone")
        rig.notifier.tap(.openPopover(.connections))
        #expect(opened == 2)
        #expect(rig.model.selectedTab == .connections, "a lingering lease opens 연결, where its line is")
    }

    @Test func theRestartButtonRestartsAtOnceWithNoSecondQuestion() async throws {
        let rig = await Rig(try codexProblem())
        let key = try #require(rig.notifier.delivered.first?.key)
        rig.notifier.tap(.restartCodex(key: key))
        await rig.model.waitForBackgroundWork()
        #expect(rig.actionCalls == [.restartCodex])
        #expect(rig.model.pending == nil, "the notification was the question")
    }

    @Test func anOldRestartButtonDoesNothingWhenThatCodexHasMovedOn() async throws {
        let rig = await Rig(try codexProblem())
        // A button from a Codex process that is gone: another process runs now.
        rig.notifier.tap(.restartCodex(key: "codex:99999"))
        await rig.model.waitForBackgroundWork()
        #expect(rig.actionCalls.isEmpty)
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .info, message: "Codex는 이미 다시 켜졌거나 연결돼서 그대로 뒀어요"))
        // And once that Codex has a host, its own button no longer restarts it either.
        let key = try #require(rig.notifier.delivered.first?.key)
        var healthy = try codexProblem()
        healthy.host.state = .ready
        rig.engine.setStatus(healthy)
        await rig.model.refresh()
        rig.notifier.tap(.restartCodex(key: key))
        await rig.model.waitForBackgroundWork()
        #expect(rig.actionCalls.isEmpty)
    }
}

@Suite struct NewVersionNotificationTests {
    @Test func aNewReleaseIsOneNotificationPerVersionThatPointsAtTheFooter() {
        let note = AppNotification.newVersion("0.7.1")
        #expect(note.kind == .newVersion)
        #expect(note.key == "new-version-0.7.1")
        #expect(note.title.contains("0.7.1"))
        #expect(note.body.contains("새 버전 0.7.1"))
        #expect(note.buttons.isEmpty)
        #expect(AppNotification.newVersion("0.7.2").key != note.key)
    }
}
