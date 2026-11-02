import Foundation
import Testing
@testable import cua_bar

struct ReconnectStatusTests {
    private func status() throws -> EngineStatus {
        var status = try Fixtures.status("status-ready")
        status.connections = [Connection(
            id: "claude-123-456", agent: .claude, state: .active, ownerAlive: true, cwd: "/Users/x/dev/project",
            canRelease: true, canStop: true, holds: false, reconnectRequired: true,
            runningVersion: "0.8.16", installedVersion: "0.8.17")]
        return status
    }

    @Test func newFieldsDecodeAndOldOrMistypedFieldsStayHarmless() throws {
        let data = Data(#"{"connections":[{"id":"claude-1-2","reconnect_required":true,"running_version":"0.8.16","installed_version":"0.8.17"},{"id":"old"},{"id":"wrong","reconnect_required":"yes","running_version":7,"installed_version":false}]}"#.utf8)
        let connections = try JSONDecoder().decode(EngineStatus.self, from: data).connections
        #expect(connections[0].reconnectRequired)
        #expect(connections[0].runningVersion == "0.8.16")
        #expect(connections[0].installedVersion == "0.8.17")
        for connection in connections.dropFirst() {
            #expect(!connection.reconnectRequired)
            #expect(connection.runningVersion == nil)
            #expect(connection.installedVersion == nil)
        }
    }

    @Test func connectedButOldProcessIsAProblemWithManualReconnectGuidance() throws {
        let summary = StatusEvaluator.evaluate(try status(), appVersion: "0.7.0")
        #expect(summary.icon == .problem)
        #expect(summary.problem?.kind == .reconnectRequired)
        #expect(summary.headline == "재연결이 필요한 MCP 연결이 1개 있어요")
        #expect(summary.nextStep == StatusEvaluator.reconnectStep)
        #expect(summary.fix == nil, "setup and process termination cannot reconnect a client")
    }

    @Test func reconnectRequirementStaysVisibleWhileAConnectionIsQuietOrBusy() throws {
        var status = try status()
        #expect(!status.connections[0].isQuiet, "the normal quiet filter must not hide the required action")
        for busy in [false, true] {
            status.connections[0].busy = busy
            let content = PopoverContent(status: status, now: Fixtures.now, calendar: Fixtures.utc)
            let row = try #require(content.connections.groups.first?.rows.first)
            #expect(row.state.text == "재연결 필요")
            #expect(row.hint?.contains("실행 0.8.16 · 설치 0.8.17") == true)
            #expect(row.hint?.contains(StatusEvaluator.reconnectStep) == true)
            #expect(row.button.action == .releaseConnection("claude-123-456"), "a live connection is never stopped")
            #expect(StatusEvaluator.evaluate(status, appVersion: "0.7.0").problem?.kind == .reconnectRequired)
        }
    }

    @Test func mcpRegistrationReadyDoesNotConcealAnOldLiveConnection() throws {
        var status = try status()
        status.setup.claudeHooks = "ready"
        let line = try #require(CheckFixtures.content(status).line(.mcp))
        #expect(line.status == .problem)
        #expect(line.detail == "기존 MCP 연결에 재연결이 필요해요")
        #expect(line.facts?.contains("실행 0.8.16 · 설치 0.8.17") == true)
        #expect(line.steps.contains(StatusEvaluator.reconnectStep))
        #expect(line.steps.contains(StatusEvaluator.reconnectFallback))
        #expect(line.commands.isEmpty && line.button == nil)
    }

    @Test func legacyConnectionVersionIsUnknownAndHookProblemsRemainVisible() throws {
        var status = try status()
        status.connections[0].runningVersion = nil
        let old = try #require(CheckFixtures.content(status).line(.mcp))
        #expect(old.status == .problem)
        #expect(old.steps.contains("실행 판 알 수 없음 · 설치 0.8.17"))
        status.setup.claudeHooks = "disabled"
        let disabled = try #require(CheckFixtures.content(status).line(.mcp))
        #expect(disabled.status == .problem)
        #expect(disabled.facts?.contains("작업 종료 자동 처리가 꺼져") == true)
        #expect(disabled.steps.contains(StatusEvaluator.reconnectStep))
        #expect(disabled.steps.contains("Claude Code의 훅 사용 설정을 확인한 뒤 고치기를 눌러 주세요"))
    }

    @Test func oldEndedRecordDoesNotAskForReconnectAndAReconnectedQuietProcessDisappears() throws {
        var status = try status()
        status.connections[0].state = .ended
        #expect(!status.connections[0].needsReconnect)
        #expect(StatusEvaluator.evaluate(status, appVersion: "0.7.0").problem?.kind == .endedConnections)
        let ended = ConnectionRow(status.connections[0], now: Fixtures.now, calendar: Fixtures.utc)
        #expect(ended.state.text == "끝남")
        #expect(ended.hint == nil)
        status.connections[0].state = .active
        status.connections[0].reconnectRequired = false
        #expect(status.connections[0].isQuiet)
        #expect(StatusEvaluator.evaluate(status, appVersion: "0.7.0").problem == nil)
        #expect(PopoverContent(status: status, now: Fixtures.now).connections.groups.isEmpty)
        #expect(CheckFixtures.content(status).line(.mcp)?.status == .ready)
    }
}
