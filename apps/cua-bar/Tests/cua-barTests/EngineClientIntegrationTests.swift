import Foundation
import Testing
@testable import cua_bar

/// The real client, locator and process runner, talking to a stand-in `codex-cua` shell script
/// in a throwaway home. It prints the contract fixtures and logs the arguments it was started
/// with, so the whole path (find the command, start it, read its answer) runs for real without
/// ever touching the user's actual command.
struct EngineClientIntegrationTests {
    private struct Rig {
        var home: TempHome
        var argumentsLog: URL
        var client: CodexCUAEngineClient

        var loggedCommands: [String] {
            ((try? String(contentsOf: argumentsLog, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
        }
    }

    /// `body` is the shell code of the fake command; `$@` are its arguments.
    private func rig(timeouts: EngineTimeouts = EngineTimeouts(), body: String) throws -> Rig {
        let home = try TempHome()
        let log = home.url.appendingPathComponent("arguments.log")
        try home.writeCommand("""
        #!/bin/sh
        # codex-cua authored command v1
        echo "$@" >> '\(log.path)'
        \(body)
        """)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: home.command.path)
        let client = CodexCUAEngineClient(locator: CommandLocator(home: home.url), timeouts: timeouts)
        return Rig(home: home, argumentsLog: log, client: client)
    }

    private func fixturePath(_ name: String) throws -> String {
        try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")).path
    }

    @Test func readsTheStatusTheCommandPrints() async throws {
        let rig = try rig(body: "cat '\(try fixturePath("contract-example"))'")
        defer { rig.home.remove() }
        let status = try await rig.client.status()
        #expect(status == (try Fixtures.status("contract-example")))
        #expect(rig.loggedCommands == ["status --json"])
    }

    @Test func passesEveryActionsArgumentsThroughToTheCommand() async throws {
        let rig = try rig(body: """
        case "$1" in
          diagnose) echo "CUA diagnosis"; echo "host: ready" ;;
          release-session) echo '{"ok": true, "released": true, "reason": null, "tab_count": 2}' ;;
          restart-codex) echo '{"ok": true, "reason": null}' ;;
          stop) echo '{"ok": true, "stopped": true, "released": true, "reason": null}' ;;
          *) echo '{"ok": true, "released": true, "reason": null, "scope_count": 1, "results": []}' ;;
        esac
        """)
        defer { rig.home.remove() }
        let client = rig.client
        _ = try await client.releaseConnection(id: "claude-1-1")
        _ = try await client.releaseEnded()
        let session = try await client.releaseSession(id: "019a-1", user: true)
        _ = try await client.stopConnection(id: "codex-2-2", force: true)
        _ = try await client.stopGroup(.claude, force: false)
        _ = try await client.restartCodex()
        let diagnosis = try await client.diagnose()
        #expect(session == SessionReleaseResult(ok: true, released: true, reason: nil, tabCount: 2))
        #expect(diagnosis == "CUA diagnosis\nhost: ready\n")
        #expect(rig.loggedCommands == [
            "release --connection claude-1-1 --json",
            "release --ended --json",
            "release-session --session 019a-1 --user --json",
            "stop --connection codex-2-2 --force --json",
            "stop --group claude --json",
            "restart-codex --json",
            "diagnose",
        ])
    }

    @Test func aCommandThatExitsNonZeroIsReportedWithItsFirstErrorLine() async throws {
        let rig = try rig(body: "echo 'Traceback (most recent call last):' >&2; echo boom >&2; exit 3")
        defer { rig.home.remove() }
        await #expect(throws: EngineError.commandFailed(exitCode: 3, message: "Traceback (most recent call last):")) {
            try await rig.client.status()
        }
    }

    @Test func aCommandThatPrintsGarbageIsAnInvalidOutputError() async throws {
        let rig = try rig(body: "echo 'not json at all'")
        defer { rig.home.remove() }
        await #expect(throws: EngineError.invalidOutput("EngineStatus")) { try await rig.client.status() }
    }

    @Test func aCommandThatNeverAnswersTimesOutAndIsStopped() async throws {
        let pidFile = FileManager.default.temporaryDirectory.appendingPathComponent("cua-bar-hang-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: pidFile) }
        let rig = try rig(timeouts: EngineTimeouts(status: .milliseconds(600)), body: "echo $$ > '\(pidFile.path)'; exec /bin/sleep 30")
        defer { rig.home.remove() }
        let started = Date()
        await #expect(throws: EngineError.timeout) { try await rig.client.status() }
        #expect(Date().timeIntervalSince(started) < 12)
        let pid = try #require((try? String(contentsOf: pidFile, encoding: .utf8)).flatMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) })
        let deadline = Date().addingTimeInterval(15)
        while kill(pid, 0) == 0, Date() < deadline { try await Task.sleep(for: .milliseconds(50)) }
        #expect(kill(pid, 0) != 0, "the hung command was left running")
    }

    @Test func aCommandThatIsNotExecutableIsALaunchFailure() async throws {
        let home = try TempHome()
        defer { home.remove() }
        try home.writeCommand() // a script with the marker, but mode 0644
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: home.command.path)
        let client = CodexCUAEngineClient(locator: CommandLocator(home: home.url))
        do {
            _ = try await client.status()
            Issue.record("expected a launch failure")
        } catch let error as EngineError {
            guard case .launchFailed = error else {
                Issue.record("expected launchFailed, got \(error)")
                return
            }
        }
    }

    @Test func theStatusCommandIsFoundAgainAfterTheCommandAppears() async throws {
        let home = try TempHome()
        defer { home.remove() }
        let client = CodexCUAEngineClient(locator: CommandLocator(home: home.url))
        await #expect(throws: EngineError.pluginMissing) { try await client.status() }
        let log = home.url.appendingPathComponent("arguments.log")
        try home.writeCommand("""
        #!/bin/sh
        # codex-cua authored command v1
        echo "$@" >> '\(log.path)'
        echo '{"schema_version": 1}'
        """)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: home.command.path)
        let status = try await client.status()
        #expect(status == EngineStatus())
    }
}
