import Foundation
import Testing
@testable import cua_bar

struct EngineModelsTests {
    @Test func decodesTheContractExampleFieldByField() throws {
        let status = try Fixtures.status("contract-example")
        #expect(status.schemaVersion == 1)
        #expect(status.generatedAt == Date(timeIntervalSince1970: 1_792_324_800))
        #expect(status.engine.version == "0.7.0")
        #expect(status.engine.root == "/Users/chenjing/.local/share/codex-cua/engine/0.7.0")
        #expect(status.engine.launcher == "/Users/chenjing/.local/share/codex-cua/engine/current/start-mcp.sh")

        #expect(status.codex.installed == true)
        #expect(status.codex.appPath == "/Applications/ChatGPT.app")
        #expect(status.codex.appVersion == "26.1013.40934")
        #expect(status.codex.running)
        #expect(status.codex.pids == [15400])

        #expect(status.host.state == .ready)
        #expect(status.host.since == Date(timeIntervalSince1970: 1_792_324_680))
        #expect(status.host.startedBeforeSetup == false)

        #expect(status.setup.command == "ready")
        #expect(status.setup.dependencies == "ready")
        #expect(status.setup.loginEnvironment == "ready")
        #expect(status.setup.shellEnvironment == "ready")
        #expect(status.setup.shellFile == "/Users/chenjing/.zshenv")
        #expect(status.setup.wrapper == "ready")
        #expect(status.setup.relay == "active")

        let connection = try #require(status.connections.first)
        #expect(status.connections.count == 1)
        #expect(connection.id == "claude-12345-1792320000")
        #expect(connection.agent == .claude)
        #expect(connection.state == .active)
        #expect(connection.pid == 12345)
        #expect(connection.ownerPID == 11111)
        #expect(connection.ownerAlive == true)
        #expect(connection.cwd == "/Users/chenjing/dev/x")
        #expect(connection.startedAt == Date(timeIntervalSince1970: 1_792_324_740))
        #expect(connection.memoryBytes == 73_400_320)
        #expect(connection.lastCallAt == Date(timeIntervalSince1970: 1_792_324_798))
        #expect(connection.idleSeconds == 2)
        #expect(connection.sessionID == "019a1b2c-...")
        #expect(connection.busy == false)
        #expect(connection.canRelease)
        #expect(connection.canStop)

        #expect(status.leases.readable == false)
        #expect(status.leases.items.isEmpty)
        let leftover = try #require(status.leases.maybeLeft.first)
        #expect(leftover.sessionID == "019a...")
        #expect(leftover.agent == .claude)
        #expect(leftover.connectionID == "claude-222-1792310000")
        #expect(leftover.cwd == "/Users/chenjing/dev/y")
        #expect(leftover.endedAt == Date(timeIntervalSince1970: 1_792_323_600))
        #expect(leftover.releasable)

        let tool = try #require(status.otherTools.first)
        #expect(tool.name == "cmux-cua")
        #expect(tool.running)
        #expect(tool.pids == [11807, 11812])
        #expect(tool.clients == [
            ToolClient(
                id: "cmux-12892-1792310808", pid: 12221, mcpPID: 12892, agent: .claude, cwd: "/Users/chenjing/dev/z",
                startedAt: Date(timeIntervalSince1970: 1_792_284_408), canStop: true)
        ])

        #expect(status.screen.activeConnectionID == "claude-12345-1792320000")
        #expect(status.screen.lastCallAt == Date(timeIntervalSince1970: 1_792_324_798))

        let entry = try #require(status.activity.first)
        #expect(entry.at == Date(timeIntervalSince1970: 1_792_324_798))
        #expect(entry.connectionID == "claude-12345-1792320000")
        #expect(entry.agent == .claude)
        #expect(entry.tool == "js")
        #expect(entry.ok == true)
        #expect(entry.ms == 1234)
    }

    @Test func aMinimalDocumentDecodesToHarmlessDefaults() throws {
        let status = try Fixtures.status("status-minimal")
        #expect(status.schemaVersion == 1)
        #expect(status.generatedAt == nil)
        #expect(status.engine.version == nil)
        #expect(status.engine.root == nil)
        #expect(status.engine.launcher == nil)
        #expect(status.codex.installed == nil)
        #expect(status.codex.running == false)
        #expect(status.codex.pids.isEmpty)
        #expect(status.host.state == .unknown(""))
        #expect(status.setup == SetupInfo())
        #expect(status.connections.isEmpty)
        #expect(status.leases.readable == false)
        #expect(status.leases.items.isEmpty)
        #expect(status.leases.maybeLeft.isEmpty)
        #expect(status.otherTools.isEmpty)
        #expect(status.screen.activeConnectionID == nil)
        #expect(status.activity.isEmpty)
    }

    @Test func emptyObjectAndMissingSchemaVersionAreStillReadable() throws {
        let status = try JSONDecoder().decode(EngineStatus.self, from: Data("{}".utf8))
        #expect(status.schemaVersion == EngineStatus.supportedSchemaVersion)
        #expect(status == EngineStatus())
    }

    @Test func unknownKeysAreIgnoredAndKnownValuesSurvive() throws {
        let contract = try Fixtures.status("contract-example")
        let status = try Fixtures.status("status-unknown-keys")
        #expect(status.connections.first == contract.connections.first)
        #expect(status.leases.maybeLeft.first == contract.leases.maybeLeft.first)
        #expect(status.otherTools.first == contract.otherTools.first)
        #expect(status.screen == contract.screen)
        #expect(status.activity == contract.activity)
        #expect(status.codex == contract.codex)
        #expect(status.setup == contract.setup)
        // A fractional-second timestamp is still a timestamp.
        #expect(status.generatedAt == Date(timeIntervalSince1970: 1_792_324_800.25))
    }

    @Test func unknownEnumValuesAreKeptInsteadOfFailing() throws {
        let status = try Fixtures.status("status-unknown-keys")
        #expect(status.host.state == .unknown("warming-up"))
        let stranger = try #require(status.connections.last)
        #expect(stranger.id == "gemini-777-1792320100")
        #expect(stranger.agent == .other("gemini"))
        #expect(stranger.agent.label == "gemini")
        #expect(stranger.state == .unknown("hibernating"))
        #expect(stranger.canStop)
        // Everything the document did not say stays unknown, never invented.
        #expect(stranger.cwd == nil)
        #expect(stranger.canRelease == false)
        #expect(stranger.busy == false)
    }

    @Test func aHostFromBeforeTheSetupIsReadAndAnythingElseIsNot() throws {
        func host(_ value: String) throws -> HostInfo {
            let json = #"{"host": {"state": "ready", "since": null, "started_before_setup": \#(value)}}"#
            return try JSONDecoder().decode(EngineStatus.self, from: Data(json.utf8)).host
        }
        #expect(try host("true").startedBeforeSetup)
        #expect(try host("false").startedBeforeSetup == false)
        #expect(try host(#""yes""#).startedBeforeSetup == false)
        #expect(try host("null").startedBeforeSetup == false)
    }

    @Test func anActivityLineKeepsTheFolderItNames() throws {
        let json = #"{"activity": [{"at": null, "connection_id": "claude-1-2", "agent": "claude", "tool": "js", "ok": true, "ms": 3, "cwd": "/Users/x/dev/a"}, {"tool": "js", "cwd": 7}]}"#
        let activity = try JSONDecoder().decode(EngineStatus.self, from: Data(json.utf8)).activity
        #expect(activity.map(\.cwd) == ["/Users/x/dev/a", nil])
    }

    @Test func aFailedActivityLineKeepsWhyItFailed() throws {
        let json = #"{"activity": [{"tool": "js", "ok": false, "ms": 30001, "error": "timeout"}, {"tool": "js", "ok": false, "error": 7}, {"tool": "js", "ok": false}]}"#
        let activity = try JSONDecoder().decode(EngineStatus.self, from: Data(json.utf8)).activity
        #expect(activity.map(\.error) == ["timeout", nil, nil])
    }

    @Test func aFailedActivityLineKeepsWhatItsAnswerSaidAndTheSettingsSayWhetherToKeepIt() throws {
        let json = #"{"settings": {"error_text": true}, "activity": [{"tool": "js", "ok": false, "error": "error", "error_text": "TypeError: x"}, {"tool": "js", "ok": false, "error_text": 7}]}"#
        let status = try JSONDecoder().decode(EngineStatus.self, from: Data(json.utf8))
        #expect(status.settings.errorText)
        #expect(status.activity.map(\.errorText) == ["TypeError: x", nil])
        // An engine from before 0.8.4 names no settings, and anything unreadable is off.
        for settings in ["", #", "settings": null"#, #", "settings": {"error_text": "yes"}"#, #", "settings": []"#] {
            let older = try JSONDecoder().decode(EngineStatus.self, from: Data(#"{"schema_version": 1\#(settings)}"#.utf8))
            #expect(older.settings.errorText == false, "\(settings)")
        }
    }

    @Test func whyAHostWentWithoutTheRelayAndWhetherARestartBringsItAreRead() throws {
        func host(_ fields: String) throws -> HostInfo {
            let json = #"{"host": {"state": "ready", "since": null, \#(fields)}}"#
            return try JSONDecoder().decode(EngineStatus.self, from: Data(json.utf8)).host
        }
        let after = try host(#""relay_reason": "plugin_entry", "restart_adds_relay": true"#)
        #expect(after.relayReason == "plugin_entry" && after.restartAddsRelay)
        let unsaid = try host(#""relay_reason": null, "restart_adds_relay": "yes""#)
        #expect(unsaid.relayReason == nil && unsaid.restartAddsRelay == false)
    }

    @Test func aHostThatIsStartingOrStoppingIsReadAsSuch() throws {
        func state(_ raw: String) throws -> HostState {
            let json = #"{"host": {"state": "\#(raw)", "since": null}}"#
            return try JSONDecoder().decode(EngineStatus.self, from: Data(json.utf8)).host.state
        }
        #expect(try state("starting") == .starting)
        #expect(try state("stopping") == .stopping)
        #expect(try state("later") == .unknown("later"))
    }

    @Test func nullsMeanUnknownEverywhere() throws {
        let status = try Fixtures.status("status-nulls")
        #expect(status.generatedAt == nil)
        #expect(status.engine.version == nil)
        #expect(status.engine.root == nil)
        #expect(status.codex.installed == false)
        #expect(status.codex.appPath == nil)
        #expect(status.codex.appVersion == nil)
        #expect(status.codex.running == false)
        #expect(status.host.state == .missing)
        #expect(status.host.since == nil)
        #expect(status.setup == SetupInfo())

        let connection = try #require(status.connections.first)
        #expect(connection.id == "codex-9-1792300000")
        #expect(connection.agent == .codex)
        #expect(connection.pid == nil)
        #expect(connection.ownerPID == nil)
        #expect(connection.ownerAlive == nil)
        #expect(connection.cwd == nil)
        #expect(connection.startedAt == nil)
        #expect(connection.memoryBytes == nil)
        #expect(connection.lastCallAt == nil)
        #expect(connection.idleSeconds == nil)
        #expect(connection.sessionID == nil)

        #expect(status.leases.maybeLeft.isEmpty)
        let tool = try #require(status.otherTools.first)
        #expect(tool.running == false)
        #expect(tool.clients.isEmpty)
        #expect(status.screen.activeConnectionID == nil)
        #expect(status.screen.lastCallAt == nil)

        let entry = try #require(status.activity.first)
        #expect(entry.at == nil)
        #expect(entry.connectionID == nil)
        #expect(entry.tool == nil)
        #expect(entry.ok == nil)
        #expect(entry.ms == nil)
    }

    @Test func aWrongTypeInOneFieldDoesNotLoseTheRest() throws {
        let json = #"""
        {"schema_version": 1, "engine": {"version": 7, "root": ["x"], "launcher": false}, "codex": {"installed": "yes", "running": true, "pids": "none"},
         "connections": [{"id": "claude-1-1", "agent": "claude", "memory_bytes": "lots", "busy": "no", "can_stop": true}, 5, {"agent": "codex"}]}
        """#
        let status = try JSONDecoder().decode(EngineStatus.self, from: Data(json.utf8))
        #expect(status.engine.version == nil)
        #expect(status.engine.root == nil)
        #expect(status.engine.launcher == nil)
        #expect(status.codex.installed == nil)
        #expect(status.codex.running)
        #expect(status.codex.pids.isEmpty)
        // The connection without an id cannot be acted on, so it is dropped; the others stay.
        #expect(status.connections.map(\.id) == ["claude-1-1"])
        #expect(status.connections.first?.memoryBytes == nil)
        #expect(status.connections.first?.busy == false)
        #expect(status.connections.first?.canStop == true)
    }

    @Test func aDocumentThatIsNotAnObjectIsAnError() {
        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(EngineStatus.self, from: Data("[1, 2]".utf8))
        }
        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(EngineStatus.self, from: Data("not json".utf8))
        }
    }

    @Test(arguments: [
        ("2026-10-18T12:00:00Z", 1_792_324_800.0),
        ("2026-10-18T12:00:00+00:00", 1_792_324_800.0),
        ("2026-10-18T21:00:00+09:00", 1_792_324_800.0),
        ("2026-10-18T07:00:00-0500", 1_792_324_800.0),
        ("2026-10-18T12:00:00.5Z", 1_792_324_800.5),
        ("2026-10-18T12:00:00.123456+00:00", 1_792_324_800.123456),
        ("2026-10-18 12:00:00Z", 1_792_324_800.0),
        ("2026-10-18T12:00:00", 1_792_324_800.0),
    ])
    func parsesIsoTimestamps(text: String, expected: Double) throws {
        let date = try #require(ISO8601.parse(text))
        #expect(abs(date.timeIntervalSince1970 - expected) < 0.0005)
    }

    @Test(arguments: ["", "yesterday", "2026-10-18", "2026-13-01T00:00:00Z", "2026-10-18T25:00:00Z", "2026-10-18T12:00:00Zjunk", "2026-10-18T12:00:00.Z"])
    func rejectsMalformedTimestamps(text: String) {
        #expect(ISO8601.parse(text) == nil)
    }
}
