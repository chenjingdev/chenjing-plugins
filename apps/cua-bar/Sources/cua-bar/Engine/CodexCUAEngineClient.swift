import Foundation

/// How long each command may run before the app gives up on it. `status` is polled every few
/// seconds and answers in well under a second; the rest wait for Codex or a process to quit.
struct EngineTimeouts: Equatable, Sendable {
    var status: Duration = .seconds(10)
    var release: Duration = .seconds(30)
    var stop: Duration = .seconds(45)
    var groupStop: Duration = .seconds(120)
    var restartCodex: Duration = .seconds(120)
    var diagnose: Duration = .seconds(30)
    /// Setup may be installing packages, and stopping that halfway leaves a broken environment,
    /// so it gets well over 15 minutes before anyone gives up on it.
    var setup: Duration = .seconds(20 * 60)
    var uninstall: Duration = .seconds(60)
}

/// The real engine client: runs `~/.local/bin/codex-cua` (found as the contract describes) and
/// decodes what it prints. Nothing here inspects processes, sockets or Codex itself.
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

    func releaseEnded() async throws -> ReleaseEndedResult {
        try await json(ReleaseEndedResult.self, ["release", "--ended", "--json"], timeout: timeouts.release)
    }

    func releaseSession(id: String, user: Bool) async throws -> SessionReleaseResult {
        let arguments = ["release-session", "--session", id] + (user ? ["--user"] : []) + ["--json"]
        return try await json(SessionReleaseResult.self, arguments, timeout: timeouts.release)
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

    /// Runs the installer. Before the command exists that is the plugin's own `setup.sh`.
    func runSetup() async throws {
        switch locator.locate() {
        case .ready(let command):
            _ = try await execute(command, ["setup"], timeout: timeouts.setup)
        case .installedNotSetUp(let installPath):
            // Through sh, so a plugin copy that lost its executable bit still runs.
            _ = try await execute(
                URL(fileURLWithPath: "/bin/sh"), [installPath.appendingPathComponent("setup.sh").path, "setup"],
                timeout: timeouts.setup)
        case .pluginMissing:
            throw EngineError.pluginMissing
        }
    }

    /// Runs the remover. Without the command there is nothing set up to remove.
    func uninstall() async throws {
        switch locator.locate() {
        case .ready(let command): _ = try await execute(command, ["uninstall"], timeout: timeouts.uninstall)
        case .installedNotSetUp(let installPath): throw EngineError.setupNeeded(installPath: installPath.path)
        case .pluginMissing: throw EngineError.pluginMissing
        }
    }

    // MARK: Running

    private func run(_ arguments: [String], timeout: Duration) async throws -> ProcessOutput {
        switch locator.locate() {
        case .ready(let command): try await execute(command, arguments, timeout: timeout)
        case .installedNotSetUp(let installPath): throw EngineError.setupNeeded(installPath: installPath.path)
        case .pluginMissing: throw EngineError.pluginMissing
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

    private func execute(_ command: URL, _ arguments: [String], timeout: Duration) async throws -> ProcessOutput {
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
        guard output.exitCode == 0 else {
            throw EngineError.commandFailed(exitCode: output.exitCode, message: output.errorSummary)
        }
        return output
    }
}
