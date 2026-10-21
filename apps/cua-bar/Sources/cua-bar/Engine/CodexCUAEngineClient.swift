import Foundation

/// How long each command may run before the app gives up on it. `status` is polled every few
/// seconds and answers in well under a second; the rest wait for Codex, a process or the browser.
/// Each limit covers the engine's own worst case (P4), so the app never kills an engine that would
/// still have finished: a killed engine skips its own clean-up.
struct EngineTimeouts: Equatable, Sendable {
    var status: Duration = .seconds(10)
    /// `release --connection`: 2 s to connect, then up to 53 s for the reply (ten open scopes), and the same
    /// once more when the answer was that the end of a turn could not be confirmed.
    var release: Duration = .seconds(120)
    /// `stop`, normal or forced: the release first (twice at worst), 8 s of grace, 3 s more after a kill.
    var stop: Duration = .seconds(130)
    /// `release-session`: host boot 17 s, the browser call 45 s, ending the turn 10 s, closing 8 s.
    var releaseSession: Duration = .seconds(100)
    /// `release --ended` asks each ended connection in turn (twice at worst: 2 s to connect and 13 s for the reply,
    /// each time), then releases the Claude sessions left behind: this much, plus the two below for each of them
    /// in the latest status (`releaseEnded(for:)`).
    var releaseEndedBase: Duration = .seconds(60)
    var releaseEndedPerConnection: Duration = .seconds(35)
    var releaseEndedPerSession: Duration = .seconds(90)
    var groupStop: Duration = .seconds(180)
    var restartCodex: Duration = .seconds(120)
    var diagnose: Duration = .seconds(30)
    /// `doctor --probe --timeout <n>`: the engine ends its own test after `n` seconds and then cleans up for up to
    /// about 6 s more, so the app waits that long and 10 s over.
    var probeMargin: Duration = .seconds(10)
    /// Setup may be installing packages, and stopping that halfway leaves a broken environment,
    /// so it gets well over 15 minutes before anyone gives up on it.
    var setup: Duration = .seconds(20 * 60)
    var uninstall: Duration = .seconds(60)
}

/// The real engine client: runs `~/.local/bin/codex-cua` (found as the contract describes) and
/// decodes what it prints. Nothing here inspects processes, sockets or Codex itself. Putting the engine
/// in place is not its business: the app does that with the engine in its bundle (`LiveSystemActions`).
struct CodexCUAEngineClient: EngineClient {
    var locator: CommandLocator
    var runner: any ProcessRunning
    var timeouts: EngineTimeouts

    init(
        locator: CommandLocator = CommandLocator(),
        runner: any ProcessRunning = SystemProcessRunner(),
        timeouts: EngineTimeouts = EngineTimeouts()
    ) {
        self.locator = locator
        self.runner = runner
        self.timeouts = timeouts
    }

    func status() async throws -> EngineStatus {
        let status = try await json(EngineStatus.self, ["status", "--json"], timeout: timeouts.status)
        // A breaking change bumps schema_version; do not guess at a shape this app has not seen.
        if status.schemaVersion > EngineStatus.supportedSchemaVersion {
            throw EngineError.unsupportedSchema(status.schemaVersion)
        }
        return status
    }

    func releaseConnection(id: String) async throws -> ReleaseResult {
        try await json(ReleaseResult.self, ["release", "--connection", id, "--json"], timeout: timeouts.release)
    }

    func releaseEnded(_ load: ReleaseEndedLoad) async throws -> ReleaseEndedResult {
        try await json(ReleaseEndedResult.self, ["release", "--ended", "--json"], timeout: timeouts.releaseEnded(for: load))
    }

    func releaseSession(id: String, user: Bool) async throws -> SessionReleaseResult {
        let arguments = ["release-session", "--session", id] + (user ? ["--user"] : []) + ["--json"]
        return try await json(SessionReleaseResult.self, arguments, timeout: timeouts.releaseSession)
    }

    func stopConnection(id: String, force: Bool) async throws -> StopResult {
        let arguments = ["stop", "--connection", id] + (force ? ["--force"] : []) + ["--json"]
        return try await json(StopResult.self, arguments, timeout: timeouts.stop)
    }

    func stopGroup(_ group: StopGroup, force: Bool) async throws -> GroupStopResult {
        let arguments = ["stop", "--group", group.rawValue] + (force ? ["--force"] : []) + ["--json"]
        return try await json(GroupStopResult.self, arguments, timeout: timeouts.groupStop)
    }

    func restartCodex() async throws -> RestartResult {
        try await json(RestartResult.self, ["restart-codex", "--json"], timeout: timeouts.restartCodex)
    }

    func diagnose() async throws -> String {
        let output = try await run(["diagnose"], timeout: timeouts.diagnose)
        return String(decoding: output.stdout, as: UTF8.self)
    }

    /// The command prints its report and exits 1 when the test did not pass, so both 0 and 1 are read; any other
    /// exit code is a command that could not run.
    func probe(seconds: Int) async throws -> ProbeOutcome {
        let output = try await run(
            ["doctor", "--probe", "--json", "--timeout", String(seconds)], timeout: .seconds(seconds) + timeouts.probeMargin,
            accepting: [0, 1])
        guard let outcome = ProbeParsing.outcome(in: output.stdout) else {
            throw EngineError.invalidOutput("doctor --probe")
        }
        return outcome
    }

    /// Runs the remover. When `codex-cua` is missing or not ours, the bound engine copy's own `setup.sh
    /// uninstall` still undoes what an earlier setup left (login environment, relay). With no engine at
    /// all there is nothing to undo: `engineMissing`.
    func uninstall() async throws {
        switch locator.locate() {
        case .ready(let command):
            _ = try await execute(command, ["uninstall"], timeout: timeouts.uninstall)
        case .installedNotSetUp(let installPath):
            _ = try await execute(Self.shell, [installPath.appendingPathComponent("setup.sh").path, "uninstall"], timeout: timeouts.uninstall)
        case .engineMissing:
            throw EngineError.engineMissing
        }
    }

    /// The engine's scripts run through sh, so a copy that lost its executable bit still runs.
    private static let shell = URL(fileURLWithPath: "/bin/sh")

    // MARK: Running

    private func run(_ arguments: [String], timeout: Duration, accepting codes: Set<Int32> = [0]) async throws -> ProcessOutput {
        switch locator.locate() {
        case .ready(let command): try await execute(command, arguments, timeout: timeout, accepting: codes)
        case .installedNotSetUp(let installPath): throw EngineError.setupNeeded(installPath: installPath.path)
        case .engineMissing: throw EngineError.engineMissing
        }
    }

    private func json<T: Decodable>(_ type: T.Type, _ arguments: [String], timeout: Duration) async throws -> T {
        let output = try await run(arguments, timeout: timeout)
        do {
            return try JSONDecoder().decode(T.self, from: output.stdout)
        } catch {
            throw EngineError.invalidOutput(String(describing: type))
        }
    }

    private func execute(
        _ command: URL, _ arguments: [String], timeout: Duration, accepting codes: Set<Int32> = [0]
    ) async throws -> ProcessOutput {
        let output: ProcessOutput
        do {
            output = try await runner.run(command, arguments: arguments, timeout: timeout)
        } catch let error as ProcessRunError {
            switch error {
            case .timedOut: throw EngineError.timeout
            case .launchFailed(let message): throw EngineError.launchFailed(message)
            }
        }
        // The contract: exit 0 even when the action failed, so anything else means it could not run.
        guard codes.contains(output.exitCode) else {
            throw EngineError.commandFailed(exitCode: output.exitCode, message: output.errorSummary)
        }
        return output
    }
}

extension EngineTimeouts {
    /// `release --ended` for what the latest status lists: the base, plus each ended connection and
    /// each releasable Claude session.
    func releaseEnded(for load: ReleaseEndedLoad) -> Duration {
        releaseEndedBase + releaseEndedPerConnection * load.endedConnections + releaseEndedPerSession * load.claudeSessions
    }
}
