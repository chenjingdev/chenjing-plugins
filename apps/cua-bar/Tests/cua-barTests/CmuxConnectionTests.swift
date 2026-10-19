import Foundation
import Testing
@testable import cua_bar

/// R17 for cmux-cua: a connection (one `cmux-cua mcp` process) whose AI client is alive is only listed,
/// with no button; one nobody owns is a line of 손볼 것 with 정리. The fixture `status-cmux` has two of
/// them: Claude in dev/z, and one whose AI client is gone (reported with `pid`, `agent` and `cwd` all null).
@MainActor
struct CmuxConnectionTests {
    static let first = "cmux-12892-1792284408"
    static let orphan = "cmux-13440-1792229400"

    private func cmuxFixture() throws -> EngineStatus { try Fixtures.status("status-cmux") }

    private func content(_ status: EngineStatus) -> PopoverContent {
        PopoverContent(status: status, now: Fixtures.now, calendar: Fixtures.utc)
    }

    /// The live clients of the tool, the lines under "cmux-cua · 실행 중".
    private func live(_ content: PopoverContent?) throws -> [ToolClientRow] {
        try #require(content).connections.tools.flatMap(\.clients)
    }

    /// The connections nobody owns, the lines of 손볼 것.
    private func orphans(_ content: PopoverContent?) throws -> [ToolClientRow] {
        (try #require(content).connections.tidy?.rows ?? []).compactMap(\.orphanRow)
    }

    private func cmuxStatus(editing change: (inout ToolClient) -> Void, at index: Int = 0) throws -> EngineStatus {
        var status = try cmuxFixture()
        change(&status.otherTools[0].clients[index])
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

    @Test func aLiveClientIsALineUnderTheToolWithNoButtonAndAnOrphanIsALineOfTheTidyList() throws {
        let content = content(try cmuxFixture())
        let tool = try #require(content.connections.tools.first)
        #expect(tool.title == "cmux-cua · 실행 중 · 프로세스 2개")
        #expect(try live(content).map(\.id) == [Self.first])
        #expect(try live(content).allSatisfy { $0.button == nil }, "its conversation is using it: nothing to press (R17)")
        #expect(try orphans(content).map(\.id) == [Self.orphan])
        #expect(try orphans(content).map(\.button?.title) == ["정리"])
    }

    @Test func everyClientIsItsOwnRowKeyedByItsIDEvenWhenTheyShareAPid() throws {
        var status = try cmuxFixture()
        // The same AI client (pid 12221) holds a second connection: same pid, another mcp process.
        var twin = status.otherTools[0].clients[0]
        twin.id = "cmux-12950-1792290000"
        twin.mcpPID = 12950
        status.otherTools[0].clients.insert(twin, at: 1)

        let content = content(status)
        let rows = try live(content)
        #expect(rows.map(\.id) == [Self.first, "cmux-12950-1792290000"])
        #expect(Set(rows.map(\.id)).count == 2, "pid repeats, id does not")
        #expect(rows.map(\.connectionID) == [Self.first, "cmux-12950-1792290000"])
        #expect(try orphans(content).map(\.connectionID) == [Self.orphan])
        // The orphan's button is aimed at its own connection, not at the AI client the others share.
        #expect(try orphans(content).first?.button?.action == .tidy(Self.orphan))
    }

    @Test func aRowSaysAgentFolderAndHowLongAgoItStarted() throws {
        let row = try #require(try live(content(cmuxFixture())).first)
        #expect(row.title == "Claude · dev/z")
        #expect(row.path == "/Users/chenjing/dev/z")
        #expect(row.startedText == "11시간 전 시작")
        #expect(row.isOrphan == false)

        let noFolder = try cmuxStatus { $0.cwd = nil; $0.startedAt = nil }
        let bare = try #require(try live(content(noFolder)).first)
        #expect(bare.title == "Claude")
        #expect(bare.startedText == "시작 시각 알 수 없음")
    }

    @Test func aClientWhoseAIClientIsGoneReadsAsHavingNoOwnerAndCanBeTidied() throws {
        let row = try #require(try orphans(content(cmuxFixture())).first)
        #expect(row.id == Self.orphan)
        #expect(row.title == "주인 없는 연결")
        #expect(row.title == ToolClientRow.orphanTitle)
        #expect(row.isOrphan)
        #expect(row.startedText == "1일 전 시작")
        let button = try #require(row.button)
        #expect(button == ButtonSpec(
            title: "정리", action: .tidy(Self.orphan),
            help: "남은 연결을 꺼요. 띄운 AI가 이미 없어서 끊길 대화도 없어요. 제때 안 꺼지면 강제로 꺼요"))
    }

    @Test func aClientWithAPidButAnUnknownAgentIsNotAnOrphan() throws {
        // A parent the engine did not recognise is still somebody: only a missing pid means gone.
        let status = try cmuxStatus { $0.agent = .other(""); $0.cwd = nil }
        let row = try #require(try live(content(status)).first)
        #expect(row.isOrphan == false)
        #expect(row.title == "AI")
        #expect(row.button == nil)
        #expect(try orphans(content(status)).map(\.id) == [Self.orphan], "and it does not go to the tidy list")
    }

    @Test func anOrphanHasAnEnabledButtonOnlyWhenTheEngineAllowsItAndNoneWhenItDidNotNameIt() throws {
        let protected = try cmuxStatus(editing: { $0.canStop = false }, at: 1)
        let notAllowed = try #require(try orphans(content(protected)).first)
        let button = try #require(notAllowed.button, "the line says why the app cannot")
        #expect(button.isEnabled == false)
        #expect(button.help == "신원을 확인하지 못한 프로세스라 앱이 끌 수 없어요")
        #expect(TidyPlan.items(in: protected).isEmpty, "and 모두 정리 leaves it out")

        let unnamed = try cmuxStatus(editing: { $0.id = nil }, at: 1)
        let noID = try #require(try orphans(content(unnamed)).first)
        #expect(noID.button == nil, "an engine that does not name its clients gives no way to aim")
        #expect(noID.title == "주인 없는 연결", "the row still reads as before")
    }

    @Test func anOlderEngineGivesRowsThatReadAsBeforeAndHaveNoButton() throws {
        let row = try #require(try live(content(try Fixtures.status("status-ready"))).first)
        #expect(row.title == "Claude · dev/z")
        #expect(row.connectionID == nil)
        #expect(row.startedText == "시작 시각 알 수 없음")
        #expect(row.button == nil)
    }

    @Test func theDaemonLineIsOnlyTextAndTheOnlyCmuxButtonBelongsToAnOrphan() throws {
        let content = content(try cmuxFixture())
        let tool = try #require(content.connections.tools.first)
        #expect(tool.detail == "프로세스 2개")
        let buttons = (try live(content) + orphans(content)).compactMap(\.button)
        #expect(buttons.map(\.action) == [.tidy(Self.orphan)])
    }

    @Test(arguments: [(0.0, "방금 시작"), (300.0, "5분 전 시작"), (40_392.0, "11시간 전 시작"), (95_400.0, "1일 전 시작")])
    func startedAgoReadsHowLongAgo(secondsAgo: Double, text: String) {
        #expect(Format.startedAgo(Fixtures.now.addingTimeInterval(-secondsAgo), now: Fixtures.now) == text)
    }

    @Test func startedAgoSaysSoWhenTheStartIsUnknown() {
        #expect(Format.startedAgo(nil, now: Fixtures.now) == "시작 시각 알 수 없음")
    }

    // MARK: 정리: stop it, by force when it does not stop in time, never asking

    @Test func tidyStopsTheOrphanNormallyWithoutAskingFirstAndSaysPlainly() async throws {
        let rig = await Rig(try cmuxFixture())
        let button = try #require(try orphans(rig.model.content).first?.button)
        #expect(rig.model.confirmation(for: button.action) == nil)
        let task = rig.model.send(button.action)
        #expect(task != nil, "it ran at once")
        #expect(rig.model.pending == nil)
        #expect(rig.model.confirmationPrompt == nil)
        await task?.value
        #expect(stopCalls(rig) == [.stopConnection(Self.orphan, force: false)], "that one connection, normal, nothing else")
        // No release step exists for cmux-cua: the engine says `released: false` with no reason, and it is a plain success.
        let outcome = try #require(rig.model.banner?.outcome)
        #expect(outcome == ActionOutcome(kind: .success, message: "정리했어요"))
    }

    @Test func aStopThatRanOutOfTimeIsRepeatedAtOnceByForceWithoutAskingAndSaysSo() async throws {
        let rig = await Rig(try cmuxFixture())
        rig.engine.configure {
            $0.stopConnectionQueue = [
                .success(StopResult(ok: false, stopped: false, released: false, reason: "timeout")),
                .success(StopResult(ok: true, stopped: true, released: false, reason: nil)),
            ]
        }
        await rig.model.send(.tidy(Self.orphan))?.value
        #expect(stopCalls(rig) == [.stopConnection(Self.orphan, force: false), .stopConnection(Self.orphan, force: true)])
        #expect(rig.model.pending == nil, "no question, whatever it came to")
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .success, message: "정리했어요 — 제때 안 꺼져서 강제로 껐어요"))
    }

    @Test func theAppsOwnTimeLimitOnTheCommandCountsAsTimingOutToo() async throws {
        let rig = await Rig(try cmuxFixture())
        rig.engine.configure {
            $0.stopConnectionQueue = [.failure(.timeout), .success(StopResult(ok: true, stopped: true, released: false, reason: nil))]
        }
        await rig.model.send(.tidy(Self.orphan))?.value
        #expect(stopCalls(rig) == [.stopConnection(Self.orphan, force: false), .stopConnection(Self.orphan, force: true)])
        #expect(rig.model.banner?.outcome.message == "정리했어요 — 제때 안 꺼져서 강제로 껐어요")
    }

    @Test(arguments: [
        ("not_found", "정리하지 못했어요 — 대상을 찾지 못했어요"),
        ("protected", "정리하지 못했어요 — 앱이 건드리지 않는 프로세스예요"),
    ])
    func otherFailuresAreNotForcedAndReadAsFailuresWithTheirReason(reason: String, text: String) async throws {
        let rig = await Rig(try cmuxFixture())
        rig.engine.configure { $0.stopConnectionByID[Self.orphan] = StopResult(ok: false, stopped: false, released: false, reason: reason) }
        await rig.model.send(.tidy(Self.orphan))?.value
        #expect(stopCalls(rig) == [.stopConnection(Self.orphan, force: false)], "only a timeout is repeated by force")
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .failure, message: text))
    }

    @Test func aForcedStopThatDoesNotWorkEitherIsAFailureAndStopsThere() async throws {
        let rig = await Rig(try cmuxFixture())
        rig.engine.configure {
            $0.stopConnectionQueue = [
                .success(StopResult(ok: false, stopped: false, released: false, reason: "timeout")),
                .failure(.timeout),
            ]
        }
        await rig.model.send(.tidy(Self.orphan))?.value
        #expect(stopCalls(rig).count == 2, "normal, then once by force; never a third")
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .failure, message: "정리하지 못했어요 — 응답이 없어 기다리다 멈췄어요"))
    }

    @Test func aLiveCmuxConnectionCannotBeTidiedEvenByAnActionSentAnyway() async throws {
        let rig = await Rig(try cmuxFixture())
        // No such line in the tidy list: the press does not run.
        #expect(rig.model.send(.tidy(Self.first)) == nil)
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .info, message: "그 연결은 이제 목록에 없어요"))
        // Not even a direct perform stops it: the plan only knows the connections nobody owns.
        let outcome = await rig.model.perform(.tidy(Self.first))
        #expect(outcome == ActionOutcome(kind: .info, message: "앱이 정리할 수 없는 연결이에요"))
        #expect(stopCalls(rig).isEmpty)
    }

    @Test func tidyingOneRowLeavesTheOtherRowsAlone() async throws {
        let rig = await Rig(try cmuxFixture())
        let gate = AsyncGate()
        rig.engine.configure { $0.actionGate = gate }
        let task = rig.model.send(.tidy(Self.orphan))
        #expect(await yieldUntil { rig.model.isWaiting(onConnection: Self.orphan) })
        #expect(rig.model.isWaiting(onConnection: Self.first) == false)
        #expect(rig.model.isWaiting(onConnection: "claude-12345-1792320000") == false)
        gate.open()
        await task?.value
        #expect(rig.model.isWaiting(onConnection: Self.orphan) == false)
    }

    @Test func tidyAllTakesTheOrphanAndNeverTheLiveConnection() async throws {
        let rig = await Rig(try cmuxFixture())
        await rig.model.perform(.tidyAll)
        #expect(stopCalls(rig) == [.stopConnection(Self.orphan, force: false)])
        #expect(rig.model.banner?.outcome == ActionOutcome(kind: .success, message: "1개 정리했어요"))
    }

    // MARK: Every button reaches the engine

    @Test func noCmuxButtonIsDead() async throws {
        let status = try cmuxFixture()
        let buttons = (try live(content(status)) + orphans(content(status))).compactMap(\.button)
        #expect(buttons.map(\.action) == [.tidy(Self.orphan)])
        for button in buttons {
            let rig = await Rig(status)
            await rig.model.perform(button.action)
            #expect(rig.actionCalls == [.stopConnection(Self.orphan, force: false)])
            #expect(rig.engine.calls.last == .status, "the status is read again afterwards")
        }
    }
}
