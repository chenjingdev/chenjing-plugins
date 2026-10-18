import Foundation
import Testing
@testable import cua_bar

/// These run real (harmless) commands from /bin: the runner's job is processes, so a fake would
/// prove nothing. The real `codex-cua` is never run here.
struct ProcessRunnerTests {
    private let runner = SystemProcessRunner()
    private let sh = URL(fileURLWithPath: "/bin/sh")

    private func isAlive(_ pid: Int32) -> Bool { kill(pid, 0) == 0 }

    private func waitUntilGone(_ pid: Int32, seconds: Double = 6) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while isAlive(pid), Date() < deadline { try? await Task.sleep(for: .milliseconds(50)) }
        return !isAlive(pid)
    }

    /// A shell that writes its own pid to a file and then becomes `sleep`.
    private func sleeper(pidFile: URL) -> [String] {
        ["-c", "echo $$ > '\(pidFile.path)'; exec /bin/sleep 30"]
    }

    private func pid(in file: URL) -> Int32? {
        (try? String(contentsOf: file, encoding: .utf8)).flatMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }

    private func scratchFile() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("cua-bar-pid-\(UUID().uuidString)")
    }

    @Test func capturesOutputErrorAndExitCode() async throws {
        let output = try await runner.run(sh, arguments: ["-c", "echo hello; echo oops 1>&2; exit 3"], timeout: .seconds(10))
        #expect(output.exitCode == 3)
        #expect(String(decoding: output.stdout, as: UTF8.self) == "hello\n")
        #expect(String(decoding: output.stderr, as: UTF8.self) == "oops\n")
        #expect(output.errorSummary == "oops")
    }

    @Test func passesArgumentsLiterally() async throws {
        let output = try await runner.run(sh, arguments: ["-c", "printf '%s|' \"$@\"", "sh", "a b", "$HOME", "--json"], timeout: .seconds(10))
        #expect(String(decoding: output.stdout, as: UTF8.self) == "a b|$HOME|--json|")
    }

    @Test func largeOutputDoesNotStallTheCommand() async throws {
        let output = try await runner.run(sh, arguments: ["-c", "/usr/bin/head -c 3000000 /dev/zero | /usr/bin/tr '\\0' x"], timeout: .seconds(30))
        #expect(output.exitCode == 0)
        #expect(output.stdout.count == 3_000_000)
    }

    @Test func standardInputIsClosed() async throws {
        let output = try await runner.run(URL(fileURLWithPath: "/bin/cat"), arguments: [], timeout: .seconds(10))
        #expect(output.exitCode == 0)
        #expect(output.stdout.isEmpty)
    }

    @Test func aCommandThatCannotStartIsALaunchFailure() async {
        await #expect(throws: ProcessRunError.self) {
            try await runner.run(URL(fileURLWithPath: "/nonexistent/codex-cua"), arguments: [], timeout: .seconds(10))
        }
    }

    @Test func aTimeoutStopsTheCommandAndSaysSo() async throws {
        let pidFile = scratchFile()
        defer { try? FileManager.default.removeItem(at: pidFile) }
        let started = Date()
        await #expect(throws: ProcessRunError.timedOut) {
            try await runner.run(sh, arguments: sleeper(pidFile: pidFile), timeout: .milliseconds(500))
        }
        #expect(Date().timeIntervalSince(started) < 8)
        let pid = try #require(pid(in: pidFile))
        #expect(await waitUntilGone(pid))
    }

    @Test func cancellingTheTaskStopsTheCommand() async throws {
        let pidFile = scratchFile()
        defer { try? FileManager.default.removeItem(at: pidFile) }
        let task = Task { try await runner.run(sh, arguments: sleeper(pidFile: pidFile), timeout: .seconds(60)) }
        // Wait until the shell has actually started.
        for _ in 0..<100 where pid(in: pidFile) == nil { try await Task.sleep(for: .milliseconds(50)) }
        let pid = try #require(pid(in: pidFile))
        task.cancel()
        await #expect(throws: CancellationError.self) { try await task.value }
        #expect(await waitUntilGone(pid))
    }

    @Test func aChildLeftRunningDoesNotKeepTheAnswerWaiting() async throws {
        // restart-codex leaves Codex running with the command's output descriptors; a pipe
        // reader would wait for it. The runner must return when the command itself exits.
        let started = Date()
        let output = try await runner.run(sh, arguments: ["-c", "/bin/sleep 3 & echo done"], timeout: .seconds(30))
        #expect(String(decoding: output.stdout, as: UTF8.self) == "done\n")
        #expect(Date().timeIntervalSince(started) < 2.5)
    }

    @MainActor @Test func theMainActorKeepsRunningWhileACommandRuns() async throws {
        var ticks = 0
        let ticker = Task { @MainActor in
            while !Task.isCancelled {
                ticks += 1
                try? await Task.sleep(for: .milliseconds(10))
            }
        }
        _ = try await runner.run(sh, arguments: ["-c", "/bin/sleep 0.6"], timeout: .seconds(10))
        ticker.cancel()
        // A blocked main thread would have managed only a tick or two in 600 ms.
        #expect(ticks >= 15)
    }

    @Test func theEnvironmentHasTheUsualToolFolders() {
        let environment = SystemProcessRunner.defaultEnvironment()
        let paths = (environment["PATH"] ?? "").split(separator: ":").map(String.init)
        #expect(paths.contains("/usr/bin"))
        #expect(paths.contains("/opt/homebrew/bin"))
        #expect(paths.contains("/usr/local/bin"))
    }
}
