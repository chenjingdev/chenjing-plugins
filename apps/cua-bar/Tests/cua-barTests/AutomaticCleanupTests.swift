import Foundation
import Testing
@testable import cua_bar

/// F5: the app releases what nobody can come back to, by itself, once per connection or session,
/// one run at a time, never with `--user`, never stopping or signalling anything.
@MainActor
struct AutomaticCleanupTests {
    /// A healthy status with nothing for the cleanup to do; tests add what they need.
    private func quiet() throws -> EngineStatus { try Fixtures.status("status-ready") }

    private func ended(_ id: String, canRelease: Bool = true) -> Connection {
        Connection(
            id: id, agent: .claude, state: .ended, cwd: "/Users/chenjing/dev/gone", sessionID: "019a-\(id)",
            canRelease: canRelease, canStop: true)
    }

    private func claudeLeftover(_ session: String, releasable: Bool = true) -> LeftoverLease {
        LeftoverLease(sessionID: session, agent: .claude, connectionID: nil, cwd: "/Users/chenjing/dev/y", endedAt: Fixtures.now.addingTimeInterval(-5), releasable: releasable)
    }

    private func releaseEndedCalls(_ rig: Rig) -> Int { rig.engine.calls.filter { $0 == .releaseEnded }.count }

    @Test func anEndedConnectionWithAControlEndpointIsReleasedByItself() async throws {
        var status = try quiet()
        status.connections.append(ended("claude-9-9"))
        let rig = await Rig(status, refresh: false)
        await rig.model.refresh()
        await rig.model.waitForBackgroundWork()
        #expect(rig.engine.calls.filter { $0 != .status } == [.releaseEnded])
        #expect(rig.model.banner == nil, "nothing is shown for an automatic attempt")
    }

    @Test func aClaudeLeftoverSessionTheEngineCanAimAtTriggersItToo() async throws {
        var status = try quiet()
        status.leases.maybeLeft = [claudeLeftover("019a-left")]
        let rig = await Rig(status, refresh: false)
        await rig.model.refresh()
        await rig.model.waitForBackgroundWork()
        #expect(rig.engine.calls.filter { $0 != .status } == [.releaseEnded])
    }

    @Test func nothingElseIsReleasedByItself() async throws {
        var status = try quiet()
        status.connections.append(ended("claude-8-8", canRelease: false)) // no control endpoint
        status.leases.maybeLeft = [
            LeftoverLease(sessionID: "019a-codex", agent: .codex, connectionID: nil, cwd: nil, endedAt: nil, releasable: true), // a Codex chat
            claudeLeftover("019a-claude-unaimable", releasable: false),
        ]
        let rig = await Rig(status, refresh: false)
        for _ in 0..<3 {
            await rig.model.refresh()
            await rig.model.waitForBackgroundWork()
        }
        #expect(rig.engine.calls.filter { $0 != .status }.isEmpty)
    }

    @Test func eachIdIsTriedAtMostOncePerRun() async throws {
        var status = try quiet()
        status.connections.append(ended("claude-9-9"))
        status.leases.maybeLeft = [claudeLeftover("019a-left")]
        let rig = await Rig(status, refresh: false)
        for _ in 0..<4 {
            await rig.model.refresh()
            await rig.model.waitForBackgroundWork()
        }
        #expect(releaseEndedCalls(rig) == 1, "both candidates go in one run, and neither is tried again")
        // A new one is tried, once, and the old ones are not tried again with it.
        status.connections.append(ended("claude-10-10"))
        rig.engine.setStatus(status)
        for _ in 0..<3 {
            await rig.model.refresh()
            await rig.model.waitForBackgroundWork()
        }
        #expect(releaseEndedCalls(rig) == 2)
    }

    @Test func itNeverPassesUserAndNeverStopsOrRestartsAnything() async throws {
        var status = try Fixtures.status("status-problem") // also has Codex running without a host
        status.leases.maybeLeft.append(claudeLeftover("019a-extra"))
        let rig = await Rig(status, refresh: false)
        for _ in 0..<3 {
            await rig.model.refresh()
            await rig.model.waitForBackgroundWork()
        }
        for call in rig.engine.calls {
            switch call {
            case .status, .releaseEnded: break
            default: Issue.record("automatic cleanup made a call it must never make: \(call)")
            }
        }
        #expect(releaseEndedCalls(rig) == 1)
    }

    @Test func neverTwoAtATimeNorBesideTheUsersOwnRelease() async throws {
        var status = try quiet()
        status.connections.append(ended("claude-9-9"))
        let gate = AsyncGate()
        let engine = FakeEngineClient(status: status)
        engine.configure { $0.actionGate = gate }
        defer { gate.open() }
        let rig = await Rig(status, engine: engine, refresh: false)
        await rig.model.refresh()
        // The run is under way, stuck inside the engine.
        #expect(rig.model.automaticCleanupTask != nil)
        #expect(await yieldUntil { engine.calls.contains(.releaseEnded) })

        // Another candidate shows up and the status is read again: no second run beside the first.
        status.connections.append(ended("claude-10-10"))
        engine.setStatus(status)
        await rig.model.refresh()
        #expect(releaseEndedCalls(rig) == 1)
        // The person's own 모두 정리 is not a second one either: it says why and does not run.
        let outcome = await rig.model.perform(.tidyAll)
        #expect(outcome == ActionOutcome(kind: .info, message: "자동 정리 중이에요. 끝나면 다시 눌러 주세요"))
        #expect(rig.model.placedResults[.tidyAll] == outcome, "said under the head of 손볼 것, where the button is")
        #expect(releaseEndedCalls(rig) == 1)

        gate.open()
        await rig.model.waitForBackgroundWork()
        // The first run is over; what appeared meanwhile is tried by a run of its own, after it.
        #expect(releaseEndedCalls(rig) == 2)
        #expect(rig.model.automaticCleanupTask == nil)
    }

    @Test func itWaitsWhileTheUserIsRunningSomethingAndGoesOnAfterwards() async throws {
        var status = try quiet()
        status.connections.append(ended("claude-9-9"))
        let gate = AsyncGate()
        let engine = FakeEngineClient(status: try quiet())
        engine.configure { $0.actionGate = gate }
        let rig = await Rig(try quiet(), engine: engine)
        defer { gate.open() }
        let action = Task { await rig.model.perform(.copyDiagnosis) } // stuck in the engine
        #expect(await yieldUntil { engine.calls.contains(.diagnose) })

        engine.setStatus(status)
        await rig.model.refresh()
        #expect(releaseEndedCalls(rig) == 0, "not while an action is running")
        #expect(rig.model.automaticCleanupTask == nil)

        gate.open()
        _ = await action.value
        await rig.model.refresh()
        await rig.model.waitForBackgroundWork()
        #expect(releaseEndedCalls(rig) == 1)
    }

    @Test func itsOwnResultIsNeverShownWhateverItWas() async throws {
        var status = try quiet()
        status.connections.append(ended("claude-9-9"))
        let engine = FakeEngineClient(status: status)
        engine.configure {
            $0.releaseEnded = ReleaseEndedResult(ok: false, results: [EndedRelease(connectionID: "claude-9-9", released: false, reason: "request_in_flight")])
        }
        let rig = await Rig(status, engine: engine, refresh: false)
        await rig.model.refresh()
        await rig.model.waitForBackgroundWork()
        #expect(rig.model.banner == nil)
        #expect(rig.model.pending == nil, "and it does not start the retry question either")
        #expect(rig.model.refusedReleaseIDs.isEmpty)
    }

    @Test func anEngineErrorInTheAutomaticRunIsSwallowedAndNotRetried() async throws {
        var status = try quiet()
        status.connections.append(ended("claude-9-9"))
        let engine = FakeEngineClient(status: status)
        engine.configure { $0.actionError = .commandFailed(exitCode: 70, message: "secret stderr") }
        let rig = await Rig(status, engine: engine, refresh: false)
        for _ in 0..<3 {
            await rig.model.refresh()
            await rig.model.waitForBackgroundWork()
        }
        #expect(releaseEndedCalls(rig) == 1)
        #expect(rig.model.banner == nil)
    }

    @Test func aLeftoverTheAutomaticRunCouldNotClearIsNotifiedOnceItIsAMinuteOld() async throws {
        // The two together (F5 then R16): tried and still listed, a minute after the owner went.
        var status = try quiet()
        status.leases.maybeLeft = [claudeLeftover("019a-left")] // ended 5 s before the clock
        let rig = await Rig(status)
        #expect(releaseEndedCalls(rig) == 1)
        #expect(rig.notifier.delivered.isEmpty, "the first minute is the cleanup's")
        rig.clock.advance(61)
        await rig.model.refresh()
        await rig.model.waitForBackgroundWork()
        #expect(rig.notifier.delivered.map(\.kind) == [.lingeringLease])
        #expect(releaseEndedCalls(rig) == 1, "and it is not tried again")
    }

    @Test func aLeftoverTheAutomaticRunDidClearIsNeverNotified() async throws {
        var status = try quiet()
        status.leases.maybeLeft = [claudeLeftover("019a-left")]
        let engine = FakeEngineClient(status: status)
        let rig = await Rig(status, engine: engine, refresh: false)
        await rig.model.refresh()
        engine.setStatus(try quiet()) // the release worked: the next status no longer lists it
        await rig.model.waitForBackgroundWork()
        rig.clock.advance(600)
        await rig.model.refresh()
        await rig.model.waitForBackgroundWork()
        #expect(rig.notifier.delivered.isEmpty)
    }
}
