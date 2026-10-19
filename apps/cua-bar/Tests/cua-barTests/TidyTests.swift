import Foundation
import Testing
@testable import cua_bar

/// F3, F4 and R17: 정리 of one line and 모두 정리 of the lines at the top of the list. Neither asks; a
/// stop that does not finish in time is repeated with `--force` at once; a Codex chat's lease and a
/// live cmux-cua connection are never touched by 모두 정리.
@MainActor
struct TidyTests {
    /// A healthy status (one live Claude, one live Codex) to add ended connections and leases to.
    private func base() throws -> EngineStatus { try Fixtures.status("status-ready") }

    private func ended(
        _ id: String, agent: AgentKind = .claude, canStop: Bool = true, canRelease: Bool = true, startedAgo: TimeInterval = 100
    ) -> Connection {
        Connection(
            id: id, agent: agent, state: .ended, cwd: "/Users/chenjing/dev/gone",
            startedAt: Fixtures.now.addingTimeInterval(-startedAgo), sessionID: "019a-\(id)", canRelease: canRelease, canStop: canStop)
    }

    private func lease(_ session: String, agent: AgentKind = .claude, releasable: Bool = true) -> LeftoverLease {
        LeftoverLease(sessionID: session, agent: agent, connectionID: nil, cwd: "/Users/chenjing/dev/y", endedAt: nil, releasable: releasable)
    }

    private func orphanCmux(_ id: String, canStop: Bool = true) -> OtherTool {
        OtherTool(name: "cmux-cua", running: true, pids: [1], clients: [
            ToolClient(id: id, pid: nil, mcpPID: 1, agent: .other(""), cwd: nil, startedAt: nil, canStop: canStop),
            ToolClient(id: "cmux-77-1", pid: 9, mcpPID: 77, agent: .claude, cwd: "/a/b", startedAt: nil, canStop: true),
        ])
    }

    // MARK: 정리 of one ended connection

    @Test func anEndedConnectionIsStoppedNormallyAndSaidToBeTidied() async throws {
        var status = try base()
        status.connections.append(ended("claude-9-9"))
        let rig = await Rig(status)
        let task = rig.model.send(.tidy("claude-9-9"))
        #expect(task != nil, "no question")
        await task?.value
        #expect(rig.actionCalls == [.stopConnection("claude-9-9", force: false)], "the engine releases the tabs first, then stops")
        #expect(rig.model.placedResults[.connection("claude-9-9")] == ActionOutcome(kind: .success, message: "정리했어요"))
    }

    @Test func aStopThatTimesOutIsRepeatedByForceAtOnceWithoutAskingAndSaysSo() async throws {
        var status = try base()
        status.connections.append(ended("codex-9-9", agent: .codex))
        let rig = await Rig(status)
        rig.engine.configure {
            $0.stopConnectionQueue = [
                .success(StopResult(ok: false, stopped: false, released: true, reason: "timeout")),
                .success(StopResult(ok: true, stopped: true, released: true, reason: nil)),
            ]
        }
        await rig.model.send(.tidy("codex-9-9"))?.value
        #expect(rig.actionCalls == [.stopConnection("codex-9-9", force: false), .stopConnection("codex-9-9", force: true)])
        #expect(rig.model.pending == nil)
        #expect(rig.model.placedResults[.connection("codex-9-9")] == ActionOutcome(kind: .success, message: "정리했어요 — 제때 안 꺼져서 강제로 껐어요"))
    }

    @Test func theAppsOwnTimeLimitOnTheStopCommandIsForcedToo() async throws {
        var status = try base()
        status.connections.append(ended("claude-9-9"))
        let rig = await Rig(status)
        rig.engine.configure {
            $0.stopConnectionQueue = [.failure(.timeout), .success(StopResult(ok: true, stopped: true, released: true, reason: nil))]
        }
        await rig.model.send(.tidy("claude-9-9"))?.value
        #expect(rig.actionCalls == [.stopConnection("claude-9-9", force: false), .stopConnection("claude-9-9", force: true)])
        #expect(rig.model.placedResults[.connection("claude-9-9")]?.message == "정리했어요 — 제때 안 꺼져서 강제로 껐어요")
    }

    @Test func aStopRefusedForAnotherReasonIsNotForced() async throws {
        var status = try base()
        status.connections.append(ended("claude-9-9"))
        let rig = await Rig(status)
        rig.engine.configure {
            $0.stopConnectionByID["claude-9-9"] = StopResult(ok: false, stopped: false, released: false, reason: "unverified")
        }
        await rig.model.send(.tidy("claude-9-9"))?.value
        #expect(rig.actionCalls == [.stopConnection("claude-9-9", force: false)])
        #expect(rig.model.placedResults[.connection("claude-9-9")] == ActionOutcome(
            kind: .failure, message: "정리하지 못했어요 — 프로세스가 바뀌었거나 확인되지 않아 건드리지 않았어요"))
    }

    @Test func aTidyWhoseTabsWereNotConfirmedReleasedWarnsAndLeavesTheRestToTheList() async throws {
        var status = try base()
        status.connections.append(ended("claude-9-9"))
        let rig = await Rig(status)
        rig.engine.configure {
            $0.stopConnectionByID["claude-9-9"] = StopResult(ok: true, stopped: true, released: false, reason: "request_in_flight")
        }
        await rig.model.send(.tidy("claude-9-9"))?.value
        let outcome = try #require(rig.model.placedResults[.connection("claude-9-9")])
        #expect(outcome.kind == .warning)
        #expect(outcome.message.hasPrefix("정리했어요 — 도구 호출이 끝나지 않아 탭은 못 풀었어요."))
        #expect(outcome.message.hasSuffix("남으면 목록에 점유로 보여요"))
    }

    @Test func aConnectionTheAppMayNotStopHasOnlyItsTabsReleased() async throws {
        var status = try base()
        status.connections.append(ended("claude-9-9", canStop: false))
        let rig = await Rig(status)
        await rig.model.send(.tidy("claude-9-9"))?.value
        #expect(rig.actionCalls == [.releaseConnection("claude-9-9")], "release only: no stop of any kind")
        #expect(rig.model.placedResults[.connection("claude-9-9")] == ActionOutcome(kind: .success, message: "탭만 풀었어요 — 이 연결은 앱이 끌 수 없어요"))
    }

    @Test func aConnectionTheAppCanNeitherStopNorReleaseHasTheButtonOffAndRunsNothing() async throws {
        var status = try base()
        status.connections.append(ended("claude-9-9", canStop: false, canRelease: false))
        let rig = await Rig(status)
        let row = try #require(rig.model.content?.connections.tidy?.rows.compactMap(\.endedRow).first)
        #expect(row.button.isEnabled == false)
        let outcome = await rig.model.perform(.tidy("claude-9-9"))
        #expect(outcome == ActionOutcome(kind: .info, message: "앱이 정리할 수 없는 연결이에요"))
        #expect(rig.actionCalls.isEmpty)
    }

    @Test func tidyNeverStopsALiveAIEvenIfItsActionIsSentAnyway() async throws {
        var status = try base()
        status.connections.append(ended("claude-9-9"))
        let rig = await Rig(status)
        let outcome = await rig.model.perform(.tidy("claude-12345-1792320000"))
        #expect(outcome.message == "앱이 정리할 수 없는 연결이에요")
        #expect(rig.actionCalls.isEmpty, "a live connection is the AI's to end")
    }

    @Test func anEngineErrorIsOneFixedLineWithTheLead() async throws {
        var status = try base()
        status.connections.append(ended("claude-9-9"))
        let rig = await Rig(status)
        rig.engine.configure { $0.actionError = .commandFailed(exitCode: 70, message: "Traceback /Users/someone/secret") }
        await rig.model.send(.tidy("claude-9-9"))?.value
        #expect(rig.model.placedResults[.connection("claude-9-9")] == ActionOutcome(kind: .failure, message: "정리하지 못했어요 — 명령이 오류로 끝났어요"))
    }

    // MARK: 모두 정리

    @Test func tidyAllDoesEachTargetInTheListsOrderAndLeavesWhatIsNotItsToTouch() async throws {
        var status = try base()
        status.connections.append(ended("claude-1-1", startedAgo: 10))
        status.connections.append(ended("codex-2-2", agent: .codex, canStop: false, startedAgo: 500))
        status.connections.append(ended("claude-3-3", canStop: false, canRelease: false, startedAgo: 900))
        status.leases.maybeLeft = [
            lease("019a-claude"), lease("019a-claude-no-way", releasable: false), lease("019a-codex", agent: .codex),
        ]
        status.otherTools = [orphanCmux("cmux-13440-1")]
        let rig = await Rig(status)
        await rig.model.send(.tidyAll)?.value
        #expect(rig.actionCalls == [
            .stopConnection("claude-1-1", force: false),
            .releaseConnection("codex-2-2"),
            .releaseSession("019a-claude", user: false),
            .stopConnection("cmux-13440-1", force: false),
        ], "newest ended first, the Claude session without --user, the orphan last; not the Codex chat, not the live cmux-cua")
        #expect(rig.model.placedResults[.tidyAll] == ActionOutcome(kind: .success, message: "4개 정리했어요"))
        #expect(rig.model.pending == nil, "it asked nothing")
    }

    @Test func oneThatFailsDoesNotKeepTheRestFromBeingTried() async throws {
        var status = try base()
        status.connections.append(ended("claude-1-1", startedAgo: 10))
        status.connections.append(ended("claude-2-2", startedAgo: 20))
        status.leases.maybeLeft = [lease("019a-claude")]
        let rig = await Rig(status)
        rig.engine.configure {
            $0.stopConnectionByID["claude-1-1"] = StopResult(ok: false, stopped: false, released: false, reason: "protected")
        }
        await rig.model.send(.tidyAll)?.value
        #expect(rig.actionCalls == [
            .stopConnection("claude-1-1", force: false),
            .stopConnection("claude-2-2", force: false),
            .releaseSession("019a-claude", user: false),
        ])
        #expect(rig.model.placedResults[.tidyAll] == ActionOutcome(
            kind: .warning, message: "2개 정리, 1개는 못 했어요 — 앱이 건드리지 않는 프로세스예요"))
    }

    @Test func aTimedOutStopInsideTidyAllIsForcedToo() async throws {
        var status = try base()
        status.connections.append(ended("claude-1-1"))
        let rig = await Rig(status)
        rig.engine.configure {
            $0.stopConnectionQueue = [
                .success(StopResult(ok: false, stopped: false, released: false, reason: "timeout")),
                .success(StopResult(ok: true, stopped: true, released: true, reason: nil)),
            ]
        }
        await rig.model.send(.tidyAll)?.value
        #expect(rig.actionCalls == [.stopConnection("claude-1-1", force: false), .stopConnection("claude-1-1", force: true)])
        #expect(rig.model.placedResults[.tidyAll] == ActionOutcome(kind: .success, message: "1개 정리했어요"))
    }

    @Test func anEngineThatTimesOutOnEverythingFailsEachAndSaysWhyOnce() async throws {
        var status = try base()
        status.connections.append(ended("claude-1-1", startedAgo: 10))
        status.connections.append(ended("claude-2-2", startedAgo: 20))
        let rig = await Rig(status)
        rig.engine.configure { $0.actionError = .timeout }
        await rig.model.send(.tidyAll)?.value
        #expect(rig.actionCalls.count == 4, "each: normal, then forced, then it gives up")
        #expect(rig.model.placedResults[.tidyAll] == ActionOutcome(kind: .failure, message: "2개를 정리하지 못했어요 — 시간이 너무 오래 걸렸어요"))
    }

    @Test func aMissingPluginStopsItAllWithOneLine() async throws {
        var status = try base()
        status.connections.append(ended("claude-1-1", startedAgo: 10))
        status.connections.append(ended("claude-2-2", startedAgo: 20))
        let rig = await Rig(status)
        rig.engine.configure { $0.actionError = .pluginMissing }
        await rig.model.send(.tidyAll)?.value
        #expect(rig.actionCalls.count == 1, "nobody to ask: the rest is not tried")
        #expect(rig.model.placedResults[.tidyAll] == ActionOutcome(kind: .failure, message: "정리하지 못했어요 — Claude 플러그인이 없어요"))
    }

    @Test func withNothingToTidyItSaysSoAndRunsNothing() async throws {
        let rig = await Rig(try base())
        let outcome = await rig.model.perform(.tidyAll)
        #expect(outcome == ActionOutcome(kind: .info, message: "정리할 것이 없어요"))
        #expect(rig.actionCalls.isEmpty)
    }

    @Test func aCodexChatsLeaseIsLeftToItsOwnLine() async throws {
        var status = try base()
        status.leases.maybeLeft = [lease("019a-codex", agent: .codex)]
        let rig = await Rig(status)
        let tidy = try #require(rig.model.content?.connections.tidy)
        #expect(tidy.tidyAllButton == nil, "nothing for it to do")
        // 모두 정리 pressed anyway (a press already on its way) does nothing; its own line's button releases it, with --user.
        _ = await rig.model.perform(.tidyAll)
        #expect(rig.actionCalls.isEmpty)
        let button = try #require(tidy.rows.compactMap(\.leaseRow).first?.releaseButton)
        await rig.model.send(button.action)?.value
        #expect(rig.actionCalls == [.releaseSession("019a-codex", user: true)])
    }

    @Test func eachLeftoverSessionKeepsItsOwnResultOnItsOwnLineAndAFailureOpensTheGuidance() async throws {
        var status = try base()
        status.connections.append(ended("claude-1-1"))
        status.leases.maybeLeft = [lease("019a-ok"), lease("019a-extra"), lease("019a-codex", agent: .codex)]
        let rig = await Rig(status)
        rig.engine.configure {
            $0.releaseSessionByID["019a-ok"] = SessionReleaseResult(ok: true, released: true, reason: nil, tabCount: 2)
            $0.releaseSessionByID["019a-extra"] = SessionReleaseResult(ok: true, released: false, reason: "cleanup_not_confirmed")
        }
        rig.model.guidanceOpenByUser = false
        rig.model.selectedTab = .activity
        await rig.model.send(.tidyAll)?.value
        #expect(rig.actionCalls.filter { if case .releaseSession = $0 { true } else { false } }
                == [.releaseSession("019a-ok", user: false), .releaseSession("019a-extra", user: false)])
        #expect(rig.model.placedResults[.tidyAll] == ActionOutcome(
            kind: .warning, message: "2개 정리, 1개는 못 했어요 — 정리가 확인되지 않았어요"))
        #expect(rig.model.sessionResults["019a-ok"] == ActionOutcome(kind: .success, message: "탭 2개를 풀었어요"))
        #expect(rig.model.sessionResults["019a-extra"] == ActionOutcome(kind: .failure, message: "탭을 풀지 못했어요 — 정리가 확인되지 않았어요"))
        #expect(rig.model.sessionResults["019a-codex"] == nil)
        #expect(rig.model.failedSessionIDs == ["019a-extra"])
        // The guidance is what the person needs next, so it is on screen: the list, with the guidance open.
        #expect(rig.model.selectedTab == .connections)
        #expect(rig.model.guidanceOpenByUser == true)
    }

    @Test func aFailureThatIsNotTheExtensionsLeavesTheGuidanceAlone() async throws {
        var status = try base()
        status.leases.maybeLeft = [lease("019a-extra")]
        let rig = await Rig(status)
        rig.engine.configure { $0.releaseSession = SessionReleaseResult(ok: false, released: false, reason: "session_live") }
        rig.model.guidanceOpenByUser = false
        await rig.model.send(.tidyAll)?.value
        #expect(rig.model.placedResults[.tidyAll] == ActionOutcome(
            kind: .failure, message: "정리하지 못했어요 — 살아 있는 연결이 아직 이 세션을 쓰고 있어요"))
        #expect(rig.model.guidanceOpenByUser == false)
        #expect(rig.model.failedSessionIDs.isEmpty)
    }

    @Test func aSessionThatCannotBeAskedIsAFailureOnItsLineAndTheRestGoesOn() async throws {
        var status = try base()
        status.leases.maybeLeft = [lease("019a-a"), lease("019a-b")]
        let rig = await Rig(status)
        rig.engine.configure {
            $0.releaseSessionErrorByID["019a-a"] = .timeout
            $0.releaseSession = SessionReleaseResult(ok: true, released: true, reason: nil, tabCount: 1)
        }
        await rig.model.send(.tidyAll)?.value
        #expect(rig.actionCalls == [.releaseSession("019a-a", user: false), .releaseSession("019a-b", user: false)])
        #expect(rig.model.sessionResults["019a-a"] == ActionOutcome(kind: .failure, message: "탭을 풀지 못했어요 — 응답이 없어 기다리다 멈췄어요"))
        #expect(rig.model.placedResults[.tidyAll] == ActionOutcome(
            kind: .warning, message: "1개 정리, 1개는 못 했어요 — 시간이 너무 오래 걸렸어요"))
        // A timeout points at the extension reset: the guidance opens for that line.
        #expect(rig.model.failedSessionIDs == ["019a-a"])
        #expect(rig.model.guidanceOpenByUser == true)
    }

    @Test func aLineWhoseOwnTidyOrReleaseIsAlreadyRunningIsLeftOutOfTidyAll() async throws {
        var status = try base()
        status.connections.append(ended("claude-1-1", startedAgo: 10))
        status.connections.append(ended("claude-2-2", startedAgo: 20))
        status.leases.maybeLeft = [lease("019a-claude")]
        let rig = await Rig(status)
        let gate = AsyncGate()
        rig.engine.configure { $0.actionGate = gate }
        // The person tidies one line and releases the session's tabs; both are stuck in the engine.
        let tidying = Task { await rig.model.perform(.tidy("claude-1-1")) }
        let releasing = Task { await rig.model.perform(.releaseSession("019a-claude", user: true)) }
        #expect(await yieldUntil {
            rig.engine.calls.contains(.stopConnection("claude-1-1", force: false))
                && rig.engine.calls.contains(.releaseSession("019a-claude", user: true))
        })
        // Then 모두 정리 comes: it does the line that is not busy and leaves those two to their own presses.
        let all = Task { await rig.model.perform(.tidyAll) }
        #expect(await yieldUntil { rig.engine.calls.contains(.stopConnection("claude-2-2", force: false)) })
        gate.open()
        _ = await tidying.value
        _ = await releasing.value
        _ = await all.value
        #expect(rig.actionCalls.filter { $0 == .stopConnection("claude-1-1", force: false) }.count == 1, "asked once, not twice")
        #expect(rig.actionCalls.filter { if case .releaseSession("019a-claude", _) = $0 { true } else { false } }.count == 1)
        #expect(rig.actionCalls.filter { $0 == .stopConnection("claude-2-2", force: false) }.count == 1)
        #expect(rig.model.placedResults[.tidyAll] == ActionOutcome(kind: .success, message: "1개 정리했어요"), "it counts only what it did")
    }

    // MARK: The tabs of a connection the app may not stop

    @Test func onceTheTabsOfAConnectionTheAppMayNotStopAreReleasedTheCardAndTheLineSayThereIsNothingMore() async throws {
        var status = try base()
        status.connections.append(ended("claude-9-9", canStop: false))
        let rig = await Rig(status)
        // Whether the automatic cleanup released its tabs is not known (its answer is not read): 정리 is still the way.
        #expect(rig.model.summary.nextStep == "목록 맨 위의 정리를 눌러 주세요")
        #expect(try #require(rig.model.content?.connections.tidy).tidyAllButton == nil, "one line: its own 정리 is the place")

        await rig.model.send(.tidy("claude-9-9"))?.value
        #expect(rig.actionCalls == [.releaseConnection("claude-9-9")])
        // Now it is known, and the card says so instead of sending the person to 정리 again.
        #expect(rig.model.summary.icon == .problem, "the connection is still there")
        #expect(rig.model.summary.headline == "끝난 연결이 1개 남아 있어요")
        #expect(rig.model.summary.nextStep == "앱이 끌 수 없는 끝난 연결이에요 — 탭은 풀었어요")
        #expect(rig.model.summary.fix == nil)
        let tidy = try #require(rig.model.content?.connections.tidy)
        let row = try #require(tidy.rows.compactMap(\.endedRow).first)
        #expect(row.hint == "탭은 풀었어요 — 앱이 끌 수 없는 연결이에요")
        #expect(row.button.isEnabled == false, "nothing more for the button to do")
        #expect(tidy.tidyAllButton == nil)
        // 모두 정리 pressed anyway has nothing to do.
        _ = await rig.model.perform(.tidyAll)
        #expect(rig.actionCalls == [.releaseConnection("claude-9-9")])
    }

    @Test func aReleaseThatDidNotWorkIsNeverClaimedOnTheCard() async throws {
        var status = try base()
        status.connections.append(ended("claude-9-9", canStop: false))
        let rig = await Rig(status)
        rig.engine.configure { $0.releaseConnection = ReleaseResult(ok: false, released: false, reason: "request_in_flight", scopeCount: 0) }
        await rig.model.send(.tidy("claude-9-9"))?.value
        #expect(rig.model.summary.nextStep == "목록 맨 위의 정리를 눌러 주세요")
        let row = try #require(rig.model.content?.connections.tidy?.rows.compactMap(\.endedRow).first)
        #expect(row.hint == nil)
        #expect(row.button.isEnabled)
    }

    @Test func aConnectionTheAppCanStopStaysOnTheCardsWayEvenNextToOneWhoseTabsAreReleased() async throws {
        var status = try base()
        status.connections.append(ended("claude-1-1", canStop: false, startedAgo: 10))
        status.connections.append(ended("claude-2-2", startedAgo: 20))
        let rig = await Rig(status)
        // Its own 정리 only releases the first one's tabs.
        await rig.model.send(.tidy("claude-1-1"))?.value
        #expect(rig.model.summary.nextStep == "목록 맨 위의 정리를 눌러 주세요", "the other can still be stopped")
    }

    @Test func whileTidyAllRunsOnlyItsTargetLinesAndItsButtonWait() async throws {
        var status = try base()
        status.connections.append(ended("claude-1-1"))
        status.leases.maybeLeft = [lease("019a-claude"), lease("019a-codex", agent: .codex)]
        status.otherTools = [orphanCmux("cmux-13440-1")]
        let rig = await Rig(status)
        let gate = AsyncGate()
        rig.engine.configure { $0.actionGate = gate }
        let task = rig.model.send(.tidyAll)
        #expect(await yieldUntil { rig.model.tidyAllIsWaiting })
        #expect(rig.model.isWaiting(onConnection: "claude-1-1"))
        #expect(rig.model.isWaiting(onConnection: "cmux-13440-1"), "a line the status does not list waits for anything wide")
        #expect(rig.model.isWaiting(onSession: "019a-claude"))
        #expect(rig.model.isWaiting(onSession: "019a-codex") == false, "a Codex chat's line is not 모두 정리's")
        #expect(rig.model.isWaiting(onConnection: "claude-12345-1792320000") == false, "a live connection is not either")
        gate.open()
        await task?.value
        #expect(rig.model.tidyAllIsWaiting == false)
        #expect(rig.model.isWaiting(onSession: "019a-claude") == false)
    }
}
