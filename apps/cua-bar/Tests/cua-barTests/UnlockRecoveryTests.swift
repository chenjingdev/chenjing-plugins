import Foundation
import Testing
@testable import cua_bar

/// A call the computer-use service refused because its automatic unlock could not unlock the Mac, `secondsAgo` before
/// the test clock.
private func unlockFailure(_ secondsAgo: TimeInterval, error: String? = "unlock_failed", ok: Bool = false) -> ActivityEntry {
    ActivityEntry(at: Fixtures.now.addingTimeInterval(-secondsAgo), agent: .claude, tool: "js", ok: ok, ms: 180, error: error)
}

private func reset(_ reason: String?, ok: Bool = false, restarts: Int = 0) -> UnlockResetResult {
    UnlockResetResult(ok: ok, reason: reason, restarts: restarts, limit: 5)
}

/// The planner behind a reference, so `#expect` can call its mutating methods.
private final class PlannerBox {
    private var planner = UnlockRecoveryPlanner()
    func due(_ status: EngineStatus, now: Date = Fixtures.now) -> Bool { planner.due(in: status, now: now) }
    func tells(_ result: UnlockResetResult) -> Bool { planner.tells(result) }
}

/// F8, the pure part: which status asks the engine's `unlock-reset`, and which answer the person hears about.
struct UnlockRecoveryPlannerTests {
    private func status(_ lines: [ActivityEntry]) throws -> EngineStatus {
        var status = try Fixtures.status("status-ready")
        status.activity = lines
        return status
    }

    @Test func eachNewFailureIsAskedAboutOnce() throws {
        let planner = PlannerBox()
        let first = try status([unlockFailure(30)])
        #expect(planner.due(first, now: Fixtures.now))
        #expect(!planner.due(first, now: Fixtures.now), "the same line is not asked about twice")
        #expect(!planner.due(first, now: Fixtures.now.addingTimeInterval(5)))
        // A newer failure is: the service may have spent the tries a restart gave it.
        let second = try status([unlockFailure(2), unlockFailure(30)])
        #expect(planner.due(second, now: Fixtures.now))
        #expect(!planner.due(second, now: Fixtures.now))
    }

    @Test(arguments: [
        unlockFailure(5, error: "screen_locked"), // automatic unlock paused for physical input, or no thread for it
        unlockFailure(5, error: "timeout"),
        unlockFailure(5, error: "error"),
        unlockFailure(5, error: nil),
        unlockFailure(5, ok: true),
    ])
    func noOtherLineAsks(line: ActivityEntry) throws {
        let planner = PlannerBox()
        #expect(!planner.due(try status([line]), now: Fixtures.now))
    }

    @Test func aFailureOlderThanTenMinutesIsHistory() throws {
        let planner = PlannerBox()
        #expect(!planner.due(try status([unlockFailure(601)]), now: Fixtures.now))
        #expect(planner.due(try status([unlockFailure(600)]), now: Fixtures.now))
    }

    @Test func aLineWithoutATimeNeverAsks() throws {
        let planner = PlannerBox()
        var line = unlockFailure(5)
        line.at = nil
        #expect(!planner.due(try status([line]), now: Fixtures.now))
    }

    @Test func theLimitIsToldOnceALock() {
        let planner = PlannerBox()
        #expect(!planner.tells(reset(nil, ok: true, restarts: 4)))
        #expect(planner.tells(reset("limit", restarts: 5)))
        #expect(!planner.tells(reset("limit", restarts: 5)), "the same lock")
        // Waiting, busy and an unreadable status say nothing about the lock.
        for reason in ["call_in_flight", "busy", "status_unreadable", "not_running", "not_ours", "still_running"] {
            #expect(!planner.tells(reset(reason, restarts: 5)))
        }
        #expect(!planner.tells(reset("limit", restarts: 5)))
        // The Mac was unlocked: the next lock that no restart helps is told again.
        #expect(!planner.tells(reset("not_locked")))
        #expect(planner.tells(reset("limit", restarts: 5)))
        // So is one after a restart or a service that needed nothing, both of which a new lock starts with.
        #expect(!planner.tells(reset(nil, ok: true, restarts: 1)))
        #expect(planner.tells(reset("limit", restarts: 5)))
        #expect(!planner.tells(reset("not_needed")))
        #expect(planner.tells(reset("limit", restarts: 5)))
    }
}

/// F8 through the view model with the fake engine: it asks after each new such failure and never beside itself, says
/// nothing on screen, reads the status again after a restart and notifies once a lock when the restarts did not help.
@MainActor
struct UnlockRecoveryViewModelTests {
    private func locked(_ lines: [ActivityEntry] = [unlockFailure(5)]) throws -> EngineStatus {
        var status = try Fixtures.status("status-ready")
        status.activity = lines + status.activity
        return status
    }

    private func resets(_ rig: Rig) -> Int { rig.engine.calls.filter { $0 == .unlockReset }.count }
    private func reads(_ rig: Rig) -> Int { rig.engine.calls.filter { $0 == .status }.count }

    @Test func aCallTheServiceCouldNotUnlockForAsksTheEngineOnce() async throws {
        let rig = await Rig(try locked(), refresh: false)
        for _ in 0..<3 {
            await rig.model.refresh()
            await rig.model.waitForBackgroundWork()
        }
        #expect(resets(rig) == 1)
        #expect(rig.model.banner == nil, "nothing is shown for it")
        #expect(rig.notifier.delivered.isEmpty)
    }

    @Test func aNewFailureAsksAgain() async throws {
        let engine = FakeEngineClient(status: try locked())
        let rig = await Rig(try locked(), engine: engine)
        #expect(resets(rig) == 1)
        engine.setStatus(try locked([unlockFailure(1), unlockFailure(5)]))
        await rig.model.refresh()
        await rig.model.waitForBackgroundWork()
        #expect(resets(rig) == 2)
    }

    @Test func noOtherStatusAsks() async throws {
        let status = try locked([unlockFailure(5, error: "screen_locked"), unlockFailure(9, error: "timeout")])
        let rig = await Rig(status, refresh: false)
        await rig.model.refresh()
        await rig.model.waitForBackgroundWork()
        #expect(rig.engine.calls.filter { $0 != .status }.isEmpty)
    }

    @Test func aRestartReadsTheStatusAgain() async throws {
        let engine = FakeEngineClient(status: try locked())
        engine.configure { $0.unlockResetQueue = [reset(nil, ok: true, restarts: 1)] }
        let rig = await Rig(try locked(), engine: engine, refresh: false)
        await rig.model.refresh()
        await rig.model.waitForBackgroundWork()
        #expect(resets(rig) == 1)
        #expect(reads(rig) == 2, "the restart's line shows in 기록 at once")
        #expect(rig.notifier.delivered.isEmpty)
    }

    @Test func anAnswerThatChangedNothingReadsNothing() async throws {
        let engine = FakeEngineClient(status: try locked())
        engine.configure { $0.unlockResetQueue = [reset("not_needed")] }
        let rig = await Rig(try locked(), engine: engine, refresh: false)
        await rig.model.refresh()
        await rig.model.waitForBackgroundWork()
        #expect(reads(rig) == 1)
    }

    @Test func restartsThatDidNotHelpAreNotifiedOnceALockAndTheClickOpensTheLog() async throws {
        let engine = FakeEngineClient(status: try locked())
        engine.configure { $0.unlockResetQueue = [reset("limit", restarts: 5), reset("limit", restarts: 5)] }
        let rig = await Rig(try locked(), engine: engine)
        let notification = try #require(rig.notifier.delivered.first)
        #expect(rig.notifier.delivered.count == 1)
        #expect(notification.kind == .unlockGaveUp)
        #expect(notification.title == "Mac 잠금을 자동으로 풀지 못했어요")
        #expect(notification.body == "CUA 서비스를 5번 다시 켰지만 자동 잠금 해제가 되지 않았어요. 맥에서 직접 잠금을 풀어 주세요.")
        #expect(NotificationResponse.make(tap: .body, kind: notification.kind, key: notification.key) == .openPopover(.activity))

        // Another refused call in the same lock asks again, and hears the limit again: nobody is told twice.
        engine.setStatus(try locked([unlockFailure(1), unlockFailure(5)]))
        await rig.model.refresh()
        await rig.model.waitForBackgroundWork()
        #expect(resets(rig) == 2)
        #expect(rig.notifier.delivered.count == 1)
        #expect(rig.model.banner == nil)
    }

    @Test func neverTwoAtATimeAndNoUpdateMeanwhile() async throws {
        let gate = AsyncGate()
        let engine = FakeEngineClient(status: try locked())
        engine.configure { $0.actionGate = gate }
        defer { gate.open() }
        let rig = await Rig(try locked(), engine: engine, refresh: false)
        await rig.model.refresh()
        #expect(await yieldUntil { engine.calls.contains(.unlockReset) })
        #expect(rig.model.unlockResetTask != nil)
        #expect(!rig.model.isQuietForUpdate, "an update would cut the restart off")

        // A newer failure while the engine is still at it: not a second run beside the first.
        engine.setStatus(try locked([unlockFailure(1), unlockFailure(5)]))
        await rig.model.refresh()
        #expect(resets(rig) == 1)

        gate.open()
        await rig.model.waitForBackgroundWork()
        #expect(rig.model.unlockResetTask == nil)
        // That failure is asked about on the next read, after the first run.
        await rig.model.refresh()
        await rig.model.waitForBackgroundWork()
        #expect(resets(rig) == 2)
    }

    @Test func anEngineErrorIsSwallowedAndTheSameFailureIsNotAskedAgain() async throws {
        let engine = FakeEngineClient(status: try locked())
        engine.configure { $0.actionError = .commandFailed(exitCode: 70, message: "secret stderr") }
        let rig = await Rig(try locked(), engine: engine, refresh: false)
        for _ in 0..<3 {
            await rig.model.refresh()
            await rig.model.waitForBackgroundWork()
        }
        #expect(resets(rig) == 1)
        #expect(rig.model.banner == nil)
        #expect(rig.notifier.delivered.isEmpty)
    }
}
