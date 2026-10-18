import Foundation
import Testing
@testable import cua_bar

/// R17 for cmux-cua: its connections (one `cmux-cua mcp` process each) are stopped one at a time from
/// the 다른 도구 tab. The fixture `status-cmux` has two of them: Claude in dev/z, and one whose AI
/// client is gone (reported with `pid`, `agent` and `cwd` all null).
@MainActor
struct CmuxConnectionTests {
    static let first = "cmux-12892-1792284408"
    static let orphan = "cmux-13440-1792229400"

    private func cmuxFixture() throws -> EngineStatus { try Fixtures.status("status-cmux") }

    private func content(_ status: EngineStatus) -> PopoverContent {
        PopoverContent(status: status, now: Fixtures.now, calendar: Fixtures.utc)
    }

    private func clients(_ content: PopoverContent?) throws -> [ToolClientRow] {
        try #require(content).otherTools.tools.flatMap(\.clients)
    }

    private func cmuxStatus(editing change: (inout ToolClient) -> Void) throws -> EngineStatus {
        var status = try cmuxFixture()
        change(&status.otherTools[0].clients[0])
        return status
    }

    private func stopCalls(_ rig: Rig) -> [FakeEngineClient.Call] {
        rig.actionCalls.filter { if case .stopConnection = $0 { true } else { false } }
    }

    // MARK: Decoding

    @Test func theNewFieldsAreReadFromTheContractExample() throws {
        let tool = try #require(try Fixtures.status("contract-example").otherTools.first)
        #expect(tool.clients == [
            ToolClient(
                id: "cmux-12892-1792310808", pid: 12221, mcpPID: 12892, agent: .claude, cwd: "/Users/chenjing/dev/z",
                startedAt: Date(timeIntervalSince1970: 1_792_284_408), canStop: true)
        ])
    }

    @Test func anOrphanIsReportedWithNullsAndStillDecodes() throws {
        let orphan = try #require(try cmuxFixture().otherTools.first?.clients.last)
        #expect(orphan.id == Self.orphan)
        #expect(orphan.pid == nil)
        #expect(orphan.mcpPID == 13440)
        #expect(orphan.agent == .other(""))
        #expect(orphan.cwd == nil)
        #expect(orphan.startedAt == Date(timeIntervalSince1970: 1_792_229_400))
        #expect(orphan.canStop)
        #expect(orphan.isOrphan)
        #expect(try #require(try cmuxFixture().otherTools.first?.clients.first).isOrphan == false)
    }

    @Test func aClientFromAnOlderEngineDecodesWithoutTheNewFields() throws {
        // status-ready.json still has the old shape: {"pid", "agent", "cwd"}.
        let client = try #require(try Fixtures.status("status-ready").otherTools.first?.clients.first)
        #expect(client == ToolClient(pid: 12221, agent: .claude, cwd: "/Users/chenjing/dev/z"))
        #expect(client.id == nil)
        #expect(client.mcpPID == nil)
        #expect(client.startedAt == nil)
        #expect(client.canStop == false)
    }

    @Test func aWrongTypeInTheNewFieldsDoesNotLoseTheRest() throws {
        let json = #"""
        {"other_tools": [{"name": "cmux-cua", "running": true, "clients": [
          {"id": 7, "pid": 100, "mcp_pid": "x", "agent": "claude", "cwd": "/a/b", "started_at": "yesterday", "can_stop": "yes"},
          {"id": "cmux-1-1", "pid": null, "mcp_pid": 1.0, "agent": null, "cwd": null,
           "started_at": "2026-10-18T11:00:00Z", "can_stop": true, "future_key": [1]},
          "not a client", 5
        ]}]}
        """#
        let status = try JSONDecoder().decode(EngineStatus.self, from: Data(json.utf8))
        let clients = try #require(status.otherTools.first?.clients)
        #expect(clients.count == 2, "what is not an object is dropped, the rest stays")
        #expect(clients[0] == ToolClient(id: nil, pid: 100, mcpPID: nil, agent: .claude, cwd: "/a/b", startedAt: nil, canStop: false))
        #expect(clients[1] == ToolClient(
            id: "cmux-1-1", pid: nil, mcpPID: 1, agent: .other(""), cwd: nil,
            startedAt: Date(timeIntervalSince1970: 1_792_321_200), canStop: true))
    }

    // MARK: Rows

    @Test func everyClientIsItsOwnRowKeyedByItsIDEvenWhenTheyShareAPid() throws {
        var status = try cmuxFixture()
        // The same AI client (pid 12221) holds a second connection: same pid, another mcp process.
        var twin = status.otherTools[0].clients[0]
        twin.id = "cmux-12950-1792290000"
        twin.mcpPID = 12950
        status.otherTools[0].clients.insert(twin, at: 1)

        let rows = try clients(content(status))
        #expect(rows.map(\.id) == [Self.first, "cmux-12950-1792290000", Self.orphan])
        #expect(Set(rows.map(\.id)).count == 3, "pid repeats, id does not")
        #expect(rows.map(\.connectionID) == [Self.first, "cmux-12950-1792290000", Self.orphan])
        // Each row's button is aimed at its own connection, not at the AI client they share.
        #expect(rows[0].buttons.map(\.action) == [.stopConnection(Self.first, force: false)])
        #expect(rows[1].buttons.map(\.action) == [.stopConnection("cmux-12950-1792290000", force: false)])
        #expect(rows[2].buttons.map(\.action) == [.stopConnection(Self.orphan, force: false)])
    }

    @Test func aRowSaysAgentFolderAndHowLongAgoItStarted() throws {
        let row = try #require(try clients(content(cmuxFixture())).first)
        #expect(row.title == "Claude · dev/z")
        #expect(row.path == "/Users/chenjing/dev/z")
        #expect(row.startedText == "11시간 전 시작")
        #expect(row.isOrphan == false)

        let noFolder = try cmuxStatus { $0.cwd = nil; $0.startedAt = nil }
        let bare = try #require(try clients(content(noFolder)).first)
        #expect(bare.title == "Claude")
        #expect(bare.startedText == "시작 시각 알 수 없음")
    }

    @Test func aClientWhoseAIClientIsGoneReadsAsHavingNoOwner() throws {
        let row = try #require(try clients(content(cmuxFixture())).last)
        #expect(row.id == Self.orphan)
        #expect(row.title == "주인 없는 연결")
        #expect(row.title == ToolClientRow.orphanTitle)
        #expect(row.isOrphan)
        #expect(row.startedText == "1일 전 시작")
        #expect(row.buttons.map(\.title) == ["끄기"], "it can still be stopped, which is the point")
    }

    @Test func aClientWithAPidButAnUnknownAgentIsNotAnOrphan() throws {
        // A parent the engine did not recognise is still somebody: only a missing pid means gone.
        let status = try cmuxStatus { $0.agent = .other(""); $0.cwd = nil }
        let row = try #require(try clients(content(status)).first)
        #expect(row.isOrphan == false)
        #expect(row.title == "AI")
    }

    @Test func aRowHasAStopButtonOnlyWhenTheEngineAllowsItAndNamedTheConnection() throws {
        let allowed = try #require(try clients(content(cmuxFixture())).first)
        #expect(allowed.buttons.map(\.title) == ["끄기"])
        #expect(allowed.buttons.map(\.isEnabled) == [true])
        #expect(allowed.buttons.map(\.isDestructive) == [false])
        #expect(allowed.buttons.allSatisfy { !$0.help.isEmpty })

        let protected = try cmuxStatus { $0.canStop = false }
        let notAllowed = try #require(try clients(content(protected)).first)
        #expect(notAllowed.buttons.isEmpty)
        #expect(notAllowed.timedOutButtons.isEmpty)

        let unnamed = try cmuxStatus { $0.id = nil }
        let noID = try #require(try clients(content(unnamed)).first)
        #expect(noID.buttons.isEmpty)
        #expect(noID.timedOutButtons.isEmpty)
        #expect(noID.title == "Claude · dev/z", "the row still reads as before")
    }

    @Test func anOlderEngineGivesRowsThatReadAsBeforeAndHaveNoButton() throws {
        let row = try #require(try clients(content(try Fixtures.status("status-ready"))).first)
        #expect(row.title == "Claude · dev/z")
        #expect(row.connectionID == nil)
        #expect(row.startedText == "시작 시각 알 수 없음")
        #expect(row.buttons.isEmpty)
        #expect(row.timedOutButtons.isEmpty)
    }

    @Test func forceStopIsOfferedOnlyAfterATimeoutAndOnlyNextToANormalStop() throws {
        let row = try #require(try clients(content(cmuxFixture())).first)
        #expect(row.buttons.map(\.title) == ["끄기"])
        #expect(row.timedOutButtons.map(\.title) == ["끄기", "강제 종료"])
        #expect(row.timedOutButtons.map(\.action) == [
            .stopConnection(Self.first, force: false), .stopConnection(Self.first, force: true),
        ])
        #expect(row.timedOutButtons.map(\.isDestructive) == [false, true])
        #expect(row.timedOutButtons.allSatisfy { $0.isEnabled && !$0.help.isEmpty })
    }

    @Test func theDaemonLineIsOnlyTextAndEveryButtonBelongsToAClient() throws {
        let tool = try #require(try content(cmuxFixture()).otherTools.tools.first)
        #expect(tool.detail == "프로세스 2개")
        let ids = Set(tool.clients.compactMap(\.connectionID))
        let actions = tool.clients.flatMap { $0.buttons + $0.timedOutButtons }.map(\.action)
        #expect(!actions.isEmpty)
        #expect(actions.allSatisfy { if case .stopConnection(let id, _) = $0 { ids.contains(id) } else { false } })
    }

    @Test(arguments: [(0.0, "방금 시작"), (300.0, "5분 전 시작"), (40_392.0, "11시간 전 시작"), (95_400.0, "1일 전 시작")])
    func startedAgoReadsHowLongAgo(secondsAgo: Double, text: String) {
        #expect(Format.startedAgo(Fixtures.now.addingTimeInterval(-secondsAgo), now: Fixtures.now) == text)
    }

    @Test func startedAgoSaysSoWhenTheStartIsUnknown() {
        #expect(Format.startedAgo(nil, now: Fixtures.now) == "시작 시각 알 수 없음")
    }

    // MARK: 끄기: one plain stop, no question

    @Test func stopSendsAPlainStopForThatConnectionWithoutAskingFirst() async throws {
        let rig = await Rig(try cmuxFixture())
        let button = try #require(try clients(rig.model.content).first?.buttons.first)
        #expect(rig.model.confirmation(for: button.action) == nil)
        let task = rig.model.send(button.action)
        #expect(task != nil, "it ran at once")
        #expect(rig.model.pending == nil)
        #expect(rig.model.confirmationPrompt == nil)
        await task?.value
        #expect(rig.actionCalls == [.stopConnection(Self.first, force: false)], "that one connection, normal, nothing else")
    }

    @Test func stoppingOneRowLeavesTheOtherRowsAlone() async throws {
        let rig = await Rig(try cmuxFixture())
        await rig.model.send(.stopConnection(Self.orphan, force: false))?.value
        #expect(rig.actionCalls == [.stopConnection(Self.orphan, force: false)])
        // While it runs, only its own row waits.
        let gate = AsyncGate()
        rig.engine.configure { $0.actionGate = gate }
        let task = rig.model.send(.stopConnection(Self.first, force: false))
        #expect(await yieldUntil { rig.model.isWaiting(onConnection: Self.first) })
        #expect(rig.model.isWaiting(onConnection: Self.orphan) == false)
        gate.open()
        await task?.value
        #expect(rig.model.isWaiting(onConnection: Self.first) == false)
    }

    // MARK: What the answer reads as

    @Test func theEnginesAnswerForACmuxStopReadsAsPlainSuccessWithNoReleaseWording() async throws {
        // No release step exists for cmux-cua, so the engine says `released: false` and has no reason.
        let answer = StopResult(ok: true, stopped: true, released: false, reason: nil)
        let rig = await Rig(try cmuxFixture())
        rig.engine.configure { $0.stopConnectionByID[Self.first] = answer }
        await rig.model.send(.stopConnection(Self.first, force: false))?.value
        let outcome = try #require(rig.model.banner?.outcome)
        #expect(outcome == ActionOutcome(kind: .success, message: "cmux-cua 연결을 껐어요"))
        #expect(!outcome.message.contains("점유") && !outcome.message.contains("놓") && !outcome.message.contains("확인"))
    }

    @Test func theSameAnswerForAClaudeOrCodexConnectionStillMeansTheReleaseIsUnknown() {
        let answer = StopResult(ok: true, stopped: true, released: false, reason: nil)
        #expect(ActionMessages.stopConnection(answer, force: false).kind == .warning)
        #expect(ActionMessages.stopCmuxConnection(answer, force: false)
                == ActionOutcome(kind: .success, message: "cmux-cua 연결을 껐어요"))
        #expect(ActionMessages.stopCmuxConnection(answer, force: true)
                == ActionOutcome(kind: .success, message: "cmux-cua 연결을 강제로 껐어요"))
        // Stopped but not ok: said as for the other connections, still without release wording.
        let unconfirmed = StopResult(ok: false, stopped: true, released: false, reason: nil)
        #expect(ActionMessages.stopCmuxConnection(unconfirmed, force: false)
                == ActionOutcome(kind: .warning, message: "cmux-cua 연결을 껐어요. 마무리는 확인되지 않았어요"))
    }

    @Test func aStopOfAClaudeConnectionStillReadsAsBefore() async throws {
        // Only a `cmux-` id gets the cmux wording; the connections keep theirs.
        let answer = StopResult(ok: true, stopped: true, released: false, reason: nil)
        let rig = await Rig(try cmuxFixture())
        rig.engine.configure { $0.stopConnectionByID["claude-12345-1792320000"] = answer }
        await rig.model.send(.stopConnection("claude-12345-1792320000", force: false))?.value
        #expect(rig.model.banner?.outcome == ActionMessages.stopConnection(answer, force: false))
        #expect(rig.model.stopTimedOutIDs.isEmpty)
    }

    @Test(arguments: [
        ("not_found", "끄지 못했어요 — 대상을 찾지 못했어요"),
        ("protected", "끄지 못했어요 — 앱이 건드리지 않는 프로세스예요"),
    ])
    func notFoundAndProtectedReadAsTheyDoForOtherConnections(reason: String, text: String) async throws {
        let answer = StopResult(ok: false, stopped: false, released: false, reason: reason)
        let rig = await Rig(try cmuxFixture())
        rig.engine.configure { $0.stopConnectionByID[Self.first] = answer }
        await rig.model.send(.stopConnection(Self.first, force: false))?.value
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .failure, message: text))
        #expect(rig.model.banner?.outcome == ActionMessages.stopConnection(answer, force: false))
        #expect(rig.model.stopTimedOutIDs.isEmpty, "only a timeout offers 강제 종료")
    }

    // MARK: Timeout: 강제 종료 asks once

    @Test func aTimedOutStopOffersForceStopWhichAsksOnceAndThenSendsForce() async throws {
        let rig = await Rig(try cmuxFixture())
        rig.engine.configure {
            $0.stopConnectionByID[Self.first] = StopResult(ok: false, stopped: false, released: false, reason: "timeout")
        }
        #expect(rig.model.stopTimedOutIDs.isEmpty)

        await rig.model.send(.stopConnection(Self.first, force: false))?.value
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .failure, message: "끄지 못했어요 — 시간이 너무 오래 걸렸어요"))
        #expect(rig.model.stopTimedOutIDs == [Self.first], "that row, not the other one")

        // 강제 종료 asks first, with the count of one, and sends nothing until the answer is yes.
        #expect(rig.model.send(.stopConnection(Self.first, force: true)) == nil)
        let prompt = try #require(rig.model.confirmationPrompt)
        #expect(prompt.title == "cmux-cua · Claude · dev/z 연결 1개를 강제로 끌까요?")
        #expect(prompt.confirmTitle == "강제 종료")
        #expect(prompt.isDestructive)
        #expect(prompt.warning == "이 대화의 cmux-cua 도구가 다시 붙을 때까지 끊겨요")
        #expect(prompt.detail == Confirmations.cmuxForceDetail)
        #expect(prompt.detail?.contains("탭") == false, "there are no tabs to release first")
        #expect(stopCalls(rig) == [.stopConnection(Self.first, force: false)])

        rig.engine.configure {
            $0.stopConnectionByID[Self.first] = StopResult(ok: true, stopped: true, released: false, reason: nil)
        }
        await rig.model.confirmPending()
        #expect(rig.model.pending == nil, "asked once")
        #expect(stopCalls(rig) == [.stopConnection(Self.first, force: false), .stopConnection(Self.first, force: true)])
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .success, message: "cmux-cua 연결을 강제로 껐어요"))
        #expect(rig.model.stopTimedOutIDs.isEmpty, "it is stopped")
    }

    @Test func cancellingTheForceQuestionSendsNothing() async throws {
        let rig = await Rig(try cmuxFixture())
        rig.model.send(.stopConnection(Self.first, force: true))
        #expect(rig.model.pending != nil)
        rig.model.cancelPending()
        #expect(await rig.model.confirmPending() == nil)
        #expect(stopCalls(rig).isEmpty)
    }

    @Test func theForceQuestionForAnOrphanHasNoOwnerToWarnAbout() async throws {
        let rig = await Rig(try cmuxFixture())
        rig.model.send(.stopConnection(Self.orphan, force: true))
        let prompt = try #require(rig.model.confirmationPrompt)
        #expect(prompt.title == "cmux-cua · 주인 없는 연결 1개를 강제로 끌까요?")
        #expect(prompt.warning == nil)
        #expect(prompt.isDestructive)
    }

    @Test func aForceStopOfACmuxConnectionWhoseLineIsGoneNeverRunsUnasked() throws {
        // As for any force stop: no status, or no such line, and the press does not run at all.
        let content = content(try cmuxFixture())
        #expect(Confirmations.gate(for: .stopConnection("cmux-1-1", force: true), content: nil)
            == .refuse(Confirmations.readStatusFirst))
        #expect(Confirmations.gate(for: .stopConnection("cmux-1-1", force: true), content: content)
            == .refuse(Confirmations.targetGone))
        #expect(Confirmations.prompt(for: .stopConnection("cmux-1-1", force: false), content: nil) == nil)
    }

    @Test func aStopCommandThatItselfTimesOutAlsoOffersForceStop() async throws {
        let rig = await Rig(try cmuxFixture())
        rig.engine.configure { $0.actionError = .timeout }
        await rig.model.send(.stopConnection(Self.first, force: false))?.value
        #expect(rig.model.stopTimedOutIDs == [Self.first])
    }

    @Test func theTimeoutMarkGoesWhenTheConnectionGoesOrTheEngineCannotBeRead() async throws {
        let rig = await Rig(try cmuxFixture())
        rig.engine.configure {
            $0.stopConnectionByID[Self.first] = StopResult(ok: false, stopped: false, released: false, reason: "timeout")
            $0.stopConnectionByID[Self.orphan] = StopResult(ok: false, stopped: false, released: false, reason: "timeout")
        }
        await rig.model.send(.stopConnection(Self.first, force: false))?.value
        await rig.model.send(.stopConnection(Self.orphan, force: false))?.value
        #expect(rig.model.stopTimedOutIDs == [Self.first, Self.orphan])

        // One of them is gone from the next answer: its mark goes with it.
        var smaller = try cmuxFixture()
        smaller.otherTools[0].clients.removeFirst()
        rig.engine.setStatus(smaller)
        await rig.model.refresh()
        #expect(rig.model.stopTimedOutIDs == [Self.orphan])

        // Nothing can be said about any row while the engine cannot be read.
        rig.engine.setStatusError(.timeout)
        await rig.model.refresh()
        await rig.model.refresh()
        #expect(rig.model.content == nil)
        #expect(rig.model.stopTimedOutIDs.isEmpty)
    }

    // MARK: Groups never include cmux-cua

    @Test func groupStopCountsAndQuestionsNeverIncludeCmuxCua() async throws {
        let status = try cmuxFixture()
        let withCmux = content(status).connections
        var withoutCmux = status
        withoutCmux.otherTools = []
        // Two stoppable cmux-cua connections are in the status; the counts stay the two real ones.
        #expect(status.otherTools.flatMap(\.clients).filter(\.canStop).count == 2)
        #expect(withCmux.stopCounts == GroupStopCounts(all: 2, claude: 1, codex: 1))
        #expect(withCmux.stopCounts == content(withoutCmux).connections.stopCounts)
        #expect(withCmux.stopButtons.map(\.title) == ["전체 끄기 2", "Claude만 1", "Codex만 1"])
        #expect(withCmux.endedStoppableCount == 0)

        let rig = await Rig(status)
        rig.model.send(.stopGroup(.all, force: false))
        #expect(rig.model.confirmationPrompt?.title == "연결 2개를 끌까요?")
        #expect(rig.model.confirmationPrompt?.detail?.contains("cmux-cua 같은 다른 도구는 그대로 둬요") == true)
        await rig.model.confirmPending()
        rig.model.send(.stopGroup(.all, force: true))
        #expect(rig.model.confirmationPrompt?.title == "연결 2개를 강제로 끌까요?")
        rig.model.cancelPending()
        // The group stop is the engine's `stop --group all`; no cmux connection is named in it.
        #expect(rig.actionCalls == [.stopGroup(.all, force: false)])
    }

    // MARK: Every button reaches the engine

    @Test func noCmuxButtonIsDead() async throws {
        let status = try cmuxFixture()
        let actions = Set(try clients(content(status)).flatMap { $0.buttons + $0.timedOutButtons }.map(\.action))
        #expect(actions == [
            .stopConnection(Self.first, force: false), .stopConnection(Self.first, force: true),
            .stopConnection(Self.orphan, force: false), .stopConnection(Self.orphan, force: true),
        ])
        for action in actions {
            let rig = await Rig(status)
            await rig.model.perform(action)
            guard case .stopConnection(let id, let force) = action else {
                Issue.record("\(action) is not a stop")
                continue
            }
            #expect(rig.actionCalls == [.stopConnection(id, force: force)])
            #expect(rig.engine.calls.last == .status, "the status is read again afterwards")
        }
    }
}

/// The merge of A2's stale-question rule with A4's cmux 강제 종료 (A4 review, item 2).
@MainActor @Suite struct CmuxStaleQuestionTests {
    static let first = "cmux-12892-1792284408"

    private func timedOutRig() async throws -> Rig {
        let rig = await Rig(try Fixtures.status("status-cmux"))
        rig.engine.configure {
            $0.stopConnectionByID[Self.first] = StopResult(ok: false, stopped: false, released: false, reason: "timeout")
        }
        await rig.model.send(.stopConnection(Self.first, force: false))?.value
        #expect(rig.model.stopTimedOutIDs == [Self.first])
        await rig.model.send(.stopConnection(Self.first, force: true))?.value
        #expect(rig.model.pending?.action == .stopConnection(Self.first, force: true))
        return rig
    }

    @Test func theQuestionStaysWhileItsLineAndItsForceButtonStay() async throws {
        let rig = try await timedOutRig()
        await rig.model.refresh()
        #expect(rig.model.pending?.action == .stopConnection(Self.first, force: true))
        #expect(rig.engine.calls.contains(.stopConnection(Self.first, force: true)) == false)
    }

    @Test func theQuestionGoesWhenTheConnectionGoes() async throws {
        let rig = try await timedOutRig()
        var status = try Fixtures.status("status-cmux")
        for index in status.otherTools.indices {
            status.otherTools[index].clients.removeAll { $0.id == Self.first }
        }
        rig.engine.configure { $0.status = .success(status) }
        await rig.model.refresh()
        #expect(rig.model.pending == nil)
        #expect(rig.engine.calls.contains(.stopConnection(Self.first, force: true)) == false)
    }

    @Test func theQuestionGoesWhenTheStatusCannotBeRead() async throws {
        let rig = try await timedOutRig()
        rig.engine.configure { $0.status = .failure(.timeout) }
        // One failed read is a hiccup that keeps the last content; the question goes with it.
        for _ in 0..<CUABarViewModel.failuresBeforeProblem { await rig.model.refresh() }
        #expect(rig.model.content == nil)
        #expect(rig.model.pending == nil)
        #expect(rig.engine.calls.contains(.stopConnection(Self.first, force: true)) == false)
    }
}
