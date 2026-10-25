import Foundation
import Testing
@testable import cua_bar

/// Stands in for the process runner: records what would have been run and answers from a script.
final class ScriptedRunner: ProcessRunning, @unchecked Sendable {
    struct Call: Equatable {
        var executable: String
        var arguments: [String]
        var timeout: Duration
    }

    private let lock = NSLock()
    private var recorded: [Call] = []
    private var answer: Result<ProcessOutput, any Error>

    init(stdout: String = "{}", exitCode: Int32 = 0, stderr: String = "") {
        answer = .success(ProcessOutput(exitCode: exitCode, stdout: Data(stdout.utf8), stderr: Data(stderr.utf8)))
    }

    init(failing error: any Error) { answer = .failure(error) }

    var calls: [Call] { lock.withLock { recorded } }

    func run(_ executable: URL, arguments: [String], timeout: Duration) async throws -> ProcessOutput {
        lock.withLock { recorded.append(Call(executable: executable.path, arguments: arguments, timeout: timeout)) }
        return try lock.withLock { answer }.get()
    }
}

struct EngineClientTests {
    /// A client over a throwaway home. Every test removes the home when it is done.
    private func client(_ runner: ScriptedRunner, ready: Bool = true) throws -> (client: CodexCUAEngineClient, home: TempHome) {
        let home = try TempHome()
        if ready { try home.writeCommand() }
        return (CodexCUAEngineClient(locator: CommandLocator(home: home.url), runner: runner), home)
    }

    // MARK: The command lines (contract: "Actions")

    @Test func statusAsksForJson() async throws {
        let runner = ScriptedRunner(stdout: try String(decoding: Fixtures.data("contract-example"), as: UTF8.self))
        let (client, home) = try client(runner)
        defer { home.remove() }
        let status = try await client.status()
        #expect(status.connections.count == 1)
        #expect(runner.calls == [.init(executable: home.command.path, arguments: ["status", "--json"], timeout: .seconds(10))])
    }

    @Test func releaseOneConnection() async throws {
        let runner = ScriptedRunner(stdout: #"{"ok": true, "released": true, "reason": null, "scope_count": 2}"#)
        let (client, home) = try client(runner)
        defer { home.remove() }
        let result = try await client.releaseConnection(id: "claude-1-2")
        #expect(result == ReleaseResult(ok: true, released: true, reason: nil, scopeCount: 2))
        #expect(runner.calls.map(\.arguments) == [["release", "--connection", "claude-1-2", "--json"]])
        #expect(runner.calls.first?.executable == home.command.path)
    }

    @Test func releaseEndedConnections() async throws {
        let runner = ScriptedRunner(stdout: #"{"ok": true, "results": [{"connection_id": "a", "released": true, "reason": null}, {"connection_id": "b", "released": false, "reason": "request_in_flight"}]}"#)
        let (client, home) = try client(runner)
        defer { home.remove() }
        let result = try await client.releaseEnded(ReleaseEndedLoad())
        #expect(result.ok)
        #expect(result.results == [
            EndedRelease(connectionID: "a", released: true, reason: nil),
            EndedRelease(connectionID: "b", released: false, reason: "request_in_flight"),
        ])
        #expect(runner.calls.map(\.arguments) == [["release", "--ended", "--json"]])
    }

    @Test func releaseOneSession() async throws {
        let runner = ScriptedRunner(stdout: #"{"ok": true, "released": false, "reason": "unsupported"}"#)
        let (client, home) = try client(runner)
        defer { home.remove() }
        let result = try await client.releaseSession(id: "019a-1", user: false)
        #expect(result == SessionReleaseResult(ok: true, released: false, reason: "unsupported", tabCount: nil))
        #expect(runner.calls.map(\.arguments) == [["release-session", "--session", "019a-1", "--json"]])
    }

    @Test func aPersonsClickReleasesWithTheUserFlagAndReadsTheTabCount() async throws {
        let runner = ScriptedRunner(stdout: #"{"ok": true, "released": true, "reason": null, "tab_count": 3}"#)
        let (client, home) = try client(runner)
        defer { home.remove() }
        let result = try await client.releaseSession(id: "019a-2", user: true)
        #expect(result == SessionReleaseResult(ok: true, released: true, reason: nil, tabCount: 3))
        #expect(runner.calls.map(\.arguments) == [["release-session", "--session", "019a-2", "--user", "--json"]])
    }

    @Test func stopOneConnectionNormallyAndByForce() async throws {
        let runner = ScriptedRunner(stdout: #"{"ok": true, "stopped": true, "released": true, "reason": null}"#)
        let (client, home) = try client(runner)
        defer { home.remove() }
        let result = try await client.stopConnection(id: "codex-9-9", force: false)
        #expect(result == StopResult(ok: true, stopped: true, released: true, reason: nil))
        _ = try await client.stopConnection(id: "codex-9-9", force: true)
        #expect(runner.calls.map(\.arguments) == [
            ["stop", "--connection", "codex-9-9", "--json"],
            ["stop", "--connection", "codex-9-9", "--force", "--json"],
        ])
    }

    @Test(arguments: StopGroup.allCases, [false, true])
    func stopAGroup(group: StopGroup, force: Bool) async throws {
        let runner = ScriptedRunner(stdout: #"{"ok": true, "stopped": 2, "failed": 1, "results": [{"connection_id": "a", "stopped": true, "released": true, "reason": null}]}"#)
        let (client, home) = try client(runner)
        defer { home.remove() }
        let result = try await client.stopGroup(group, force: force)
        #expect(result.stopped == 2)
        #expect(result.failed == 1)
        #expect(result.results.count == 1)
        let expected = ["stop", "--group", group.rawValue] + (force ? ["--force"] : []) + ["--json"]
        #expect(runner.calls.map(\.arguments) == [expected])
    }

    @Test func restartCodex() async throws {
        let runner = ScriptedRunner(stdout: #"{"ok": false, "reason": "quit_cancelled"}"#)
        let (client, home) = try client(runner)
        defer { home.remove() }
        let result = try await client.restartCodex()
        #expect(result == RestartResult(ok: false, reason: "quit_cancelled"))
        #expect(runner.calls.map(\.arguments) == [["restart-codex", "--json"]])
    }

    @Test(arguments: [true, false])
    func setErrorText(keep: Bool) async throws {
        let runner = ScriptedRunner(stdout: #"{"ok": true, "reason": null, "error_text": \#(keep)}"#)
        let (client, home) = try client(runner)
        defer { home.remove() }
        #expect(try await client.setErrorText(keep) == SettingsResult(ok: true, reason: nil, errorText: keep))
        #expect(runner.calls.map(\.arguments) == [["settings", "--error-text", keep ? "on" : "off", "--json"]])
    }

    @Test func diagnoseReturnsThePlainText() async throws {
        let runner = ScriptedRunner(stdout: "CUA diagnosis\nhost: ready\n")
        let (client, home) = try client(runner)
        defer { home.remove() }
        #expect(try await client.diagnose() == "CUA diagnosis\nhost: ready\n")
        #expect(runner.calls.map(\.arguments) == [["diagnose"]])
    }

    @Test func uninstallRunsTheRemoverWithItsOwnTimeout() async throws {
        let home = try TempHome()
        defer { home.remove() }
        try home.writeCommand()
        let runner = ScriptedRunner(stdout: "")
        let client = CodexCUAEngineClient(locator: CommandLocator(home: home.url), runner: runner)
        try await client.uninstall()
        #expect(runner.calls == [.init(executable: home.command.path, arguments: ["uninstall"], timeout: EngineTimeouts().uninstall)])
        #expect(EngineTimeouts().uninstall <= .seconds(120))
    }

    @Test func aRemoverThatExitsNonZeroIsACommandFailure() async throws {
        let home = try TempHome()
        defer { home.remove() }
        try home.writeCommand()
        let client = CodexCUAEngineClient(
            locator: CommandLocator(home: home.url), runner: ScriptedRunner(stdout: "", exitCode: 1, stderr: "codex-cua could not complete.\n"))
        await #expect(throws: EngineError.commandFailed(exitCode: 1, message: "codex-cua could not complete.")) { try await client.uninstall() }
    }

    @Test func uninstallWithoutAnEngineHasNothingToRun() async throws {
        let home = try TempHome()
        defer { home.remove() }
        let runner = ScriptedRunner()
        let client = CodexCUAEngineClient(locator: CommandLocator(home: home.url), runner: runner)
        await #expect(throws: EngineError.engineMissing) { try await client.uninstall() }
        #expect(runner.calls.isEmpty)
    }

    @Test(arguments: [false, true])
    func withoutItsCommandTheBoundEnginesOwnRemoverRuns(foreignCommand: Bool) async throws {
        // An earlier setup may have left the login environment and the relay behind (R3).
        let home = try TempHome()
        defer { home.remove() }
        if foreignCommand { try home.writeCommand("#!/bin/sh\necho someone else's command\n") }
        let install = try home.installEngine()
        let runner = ScriptedRunner(stdout: "")
        let client = CodexCUAEngineClient(locator: CommandLocator(home: home.url), runner: runner)
        try await client.uninstall()
        #expect(runner.calls == [.init(executable: "/bin/sh", arguments: [install.appendingPathComponent("setup.sh").path, "uninstall"], timeout: EngineTimeouts().uninstall)])
    }

    @Test func thatRemoverFailingOrRunningOutOfTimeIsAFailure() async throws {
        let home = try TempHome()
        defer { home.remove() }
        try home.installEngine()
        let failing = CodexCUAEngineClient(
            locator: CommandLocator(home: home.url), runner: ScriptedRunner(stdout: "", exitCode: 1, stderr: "codex-cua could not complete.\n"))
        await #expect(throws: EngineError.commandFailed(exitCode: 1, message: "codex-cua could not complete.")) { try await failing.uninstall() }
        let stuck = CodexCUAEngineClient(locator: CommandLocator(home: home.url), runner: ScriptedRunner(failing: ProcessRunError.timedOut))
        await #expect(throws: EngineError.timeout) { try await stuck.uninstall() }
    }

    @Test func everyCommandHasATimeout() async throws {
        let timeouts = EngineTimeouts()
        let runner = ScriptedRunner(stdout: "{}")
        let (client, home) = try client(runner)
        defer { home.remove() }
        _ = try await client.releaseConnection(id: "a")
        _ = try await client.stopConnection(id: "a", force: true)
        _ = try await client.stopGroup(.all, force: false)
        _ = try await client.restartCodex()
        _ = try await client.diagnose()
        #expect(runner.calls.map(\.timeout) == [timeouts.release, timeouts.stop, timeouts.groupStop, timeouts.restartCodex, timeouts.diagnose])
        // Status is polled, so it must give up fast; nothing may wait forever.
        #expect(timeouts.status <= .seconds(15))
        // Setup may be installing packages; stopping it halfway breaks the environment, so it gets 15 minutes at least.
        #expect(timeouts.setup >= .seconds(15 * 60))
        #expect(timeouts.setup <= .seconds(60 * 60))
    }

    /// A limit shorter than the engine's own worst case (P4) kills an engine that would still
    /// have finished, before its clean-up.
    @Test func eachLimitCoversTheEnginesWorstCase() async throws {
        let runner = ScriptedRunner(stdout: "{}")
        let (client, home) = try client(runner)
        defer { home.remove() }
        _ = try await client.releaseConnection(id: "a")
        _ = try await client.stopConnection(id: "a", force: false)
        _ = try await client.stopConnection(id: "a", force: true)
        _ = try await client.releaseSession(id: "019a-1", user: false)
        _ = try await client.releaseEnded(ReleaseEndedLoad())
        _ = try await client.releaseEnded(ReleaseEndedLoad(endedConnections: 2, claudeSessions: 3))
        _ = try await client.restartCodex()
        #expect(runner.calls.map(\.timeout) == [
            .seconds(120), .seconds(130), .seconds(130), .seconds(100),
            .seconds(60), .seconds(60 + 2 * 35 + 3 * 90),
            .seconds(120),
        ])
        // The release step of a connection is asked twice at worst (an answer that could not confirm is asked once more):
        // 2 s to connect and 53 s for the reply (ten open scopes) each time, and a stop adds its 8 s of grace and 3 s after a kill.
        #expect(EngineTimeouts().release >= .seconds(2 * (2 + 53)))
        // Then the sessions its bridge left under an earlier host, by id: boot 17 s, 55 s each, closing 8 s, and the
        // runtime's end. Two of them used to outlast the 120 s, and a killed engine leaves its release thread behind.
        _ = try await client.releaseConnection(id: "a", earlierSessions: 2)
        #expect(runner.calls.last?.timeout == .seconds(120 + 2 * 90))
        #expect(EngineTimeouts().releaseEndedPerSession >= .seconds(17 + 55 + 8))
        #expect(EngineTimeouts().stop >= .seconds(2 * (2 + 53) + 8 + 3 + 3))
        #expect(EngineTimeouts().groupStop >= EngineTimeouts().stop)
        #expect(EngineTimeouts().releaseEndedPerConnection >= .seconds(2 * (2 + 13)))
        // restart-codex at worst: 10 s, 30 s for the quit, 15 s, 15 s, 20 s for the reopen (P4).
        #expect(EngineTimeouts().restartCodex >= .seconds(10 + 30 + 15 + 15 + 20))
    }

    @Test func theLoadOfReleaseEndedIsCountedFromTheStatus() throws {
        // One ended connection; a releasable Claude leftover and a Codex one (Codex chats are not released by it).
        let status = try Fixtures.status("status-problem")
        #expect(ReleaseEndedLoad(status: status) == ReleaseEndedLoad(endedConnections: 1, claudeSessions: 1))
        #expect(ReleaseEndedLoad(status: nil) == ReleaseEndedLoad())
    }

    // MARK: Failures

    @Test func aMissingEngineNeverRunsAnything() async throws {
        let runner = ScriptedRunner()
        let (client, home) = try client(runner, ready: false)
        defer { home.remove() }
        await #expect(throws: EngineError.engineMissing) { try await client.status() }
        await #expect(throws: EngineError.engineMissing) { try await client.releaseEnded(ReleaseEndedLoad()) }
        #expect(runner.calls.isEmpty)
    }

    @Test func anEngineCopyThatIsNotSetUpIsReportedWithItsFolder() async throws {
        let runner = ScriptedRunner()
        let (client, home) = try client(runner, ready: false)
        defer { home.remove() }
        let install = try home.installEngine()
        await #expect(throws: EngineError.setupNeeded(installPath: install.path)) { try await client.status() }
        #expect(runner.calls.isEmpty)
    }

    @Test func aNonZeroExitMeansTheCommandCouldNotRun() async throws {
        let runner = ScriptedRunner(stdout: "", exitCode: 3, stderr: "\nTraceback\n  boom\n")
        let (client, home) = try client(runner)
        defer { home.remove() }
        await #expect(throws: EngineError.commandFailed(exitCode: 3, message: "Traceback")) { try await client.status() }
    }

    @Test func garbageOnStdoutIsAnInvalidOutputError() async throws {
        let runner = ScriptedRunner(stdout: "Traceback (most recent call last)")
        let (client, home) = try client(runner)
        defer { home.remove() }
        await #expect(throws: EngineError.invalidOutput("EngineStatus")) { try await client.status() }
    }

    @Test func aTimedOutCommandIsATimeout() async throws {
        let (client, home) = try client(ScriptedRunner(failing: ProcessRunError.timedOut))
        defer { home.remove() }
        await #expect(throws: EngineError.timeout) { try await client.status() }
    }

    @Test func aCommandThatCannotStartIsALaunchFailure() async throws {
        let (client, home) = try client(ScriptedRunner(failing: ProcessRunError.launchFailed("nope")))
        defer { home.remove() }
        await #expect(throws: EngineError.launchFailed("nope")) { try await client.releaseEnded(ReleaseEndedLoad()) }
    }

    @Test func aNewerSchemaIsRefusedInsteadOfGuessed() async throws {
        let runner = ScriptedRunner(stdout: #"{"schema_version": 2, "connections": [{"id": "x"}]}"#)
        let (client, home) = try client(runner)
        defer { home.remove() }
        await #expect(throws: EngineError.unsupportedSchema(2)) { try await client.status() }
    }

    @Test func anActionThatRanButFailedIsAResultNotAnError() async throws {
        let runner = ScriptedRunner(stdout: #"{"ok": false, "released": false, "reason": "request_in_flight", "scope_count": 0}"#)
        let (client, home) = try client(runner)
        defer { home.remove() }
        let result = try await client.releaseConnection(id: "a")
        #expect(result.ok == false)
        #expect(result.reason == "request_in_flight")
    }

    @Test func resultsWithUnknownKeysOrMissingFieldsStillDecode() throws {
        let release = try JSONDecoder().decode(ReleaseResult.self, from: Data(#"{"ok": true, "future": 1}"#.utf8))
        #expect(release == ReleaseResult(ok: true, released: false, reason: nil, scopeCount: nil))
        let session = try JSONDecoder().decode(SessionReleaseResult.self, from: Data(#"{"ok": true, "tab_count": 2.0, "future": 1}"#.utf8))
        #expect(session == SessionReleaseResult(ok: true, released: false, reason: nil, tabCount: 2))
        let group = try JSONDecoder().decode(GroupStopResult.self, from: Data(#"{"stopped": 1.0}"#.utf8))
        #expect(group == GroupStopResult(ok: false, stopped: 1, failed: 0, results: []))
    }
}
