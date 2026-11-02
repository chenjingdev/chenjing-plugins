import Foundation
import Testing
@testable import cua_bar

@MainActor
struct ReconnectActionTests {
    private let id = "claude-123-456"

    private func status() throws -> EngineStatus {
        var status = try Fixtures.status("status-ready")
        status.connections = [Connection(
            id: id, agent: .claude, state: .active, ownerAlive: true,
            canRelease: true, canStop: true, holds: false, reconnectRequired: true,
            runningVersion: "0.8.13", installedVersion: "0.8.18")]
        return status
    }

    @Test func cardCopiesTheExactForceReconnectCommandWithoutRunningAnEngineAction() async throws {
        let rig = await Rig(try status())
        await rig.model.send(.copyReconnectCommand)?.value
        #expect(rig.pasteboard.copied == ["/mcp reconnect cuabar"])
        #expect(rig.actionCalls.isEmpty)
        #expect(rig.model.banner?.outcome.message.contains("복사했어요") == true)
        #expect(rig.model.summary.problem?.kind == .reconnectRequired, "copying is not a reconnection")
    }

    @Test func staleRowDisconnectsOnlyItsOwnMCPWithoutForceOrCodexRestart() async throws {
        let rig = await Rig(try status())
        let row = try #require(rig.model.content?.connections.row(withID: id))
        #expect(row.button.action == .disconnectMCP(id))
        #expect(row.button.help.contains("작업도 끊길 수 있어요"))
        await rig.model.send(row.button.action)?.value
        #expect(rig.actionCalls == [.disconnectMCP(id)])
        let result = rig.model.placedResults[.connection(id)]
        #expect(result?.kind == .success)
        #expect(result?.message.contains("끊었어요") == true)
        #expect(result?.message.contains("실행해 주세요") == true)
    }

    @Test func aBusyCurrentUnverifiedOrNonClaudeConnectionCannotBeDisconnected() async throws {
        for mutation in 0..<4 {
            var value = try status()
            switch mutation {
            case 0: value.connections[0].busy = true
            case 1: value.connections[0].reconnectRequired = false
            case 2: value.connections[0].canStop = false
            default: value.connections[0].agent = .codex
            }
            let rig = await Rig(value)
            _ = await rig.model.perform(.disconnectMCP(id))
            #expect(rig.actionCalls.isEmpty)
        }
    }

    @Test func aGoneTargetNeverRunsAndTimeoutNeverEscalatesToForce() async throws {
        let rig = await Rig(try status())
        #expect(rig.model.send(.disconnectMCP("claude-999-999")) == nil)
        #expect(rig.actionCalls.isEmpty)
        rig.engine.configure { $0.disconnectMCP = StopResult(ok: false, stopped: false, released: false, reason: "timeout") }
        let outcome = await rig.model.perform(.disconnectMCP(id))
        #expect(outcome.kind == .warning)
        #expect(rig.actionCalls == [.disconnectMCP(id)])
        #expect(!outcome.message.contains("다시 연결했어요"))
    }
}
