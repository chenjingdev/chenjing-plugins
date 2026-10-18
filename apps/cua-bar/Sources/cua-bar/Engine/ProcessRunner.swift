import Foundation

struct ProcessOutput: Equatable, Sendable {
    var exitCode: Int32
    var stdout: Data
    var stderr: Data

    /// First non-empty line of stderr, shortened, for error messages.
    var errorSummary: String {
        let text = String(decoding: stderr, as: UTF8.self)
        let line = text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
        return line.count > 160 ? String(line.prefix(160)) + "…" : line
    }
}

enum ProcessRunError: Error, Equatable, Sendable {
    case launchFailed(String)
    case timedOut
}

/// Runs one command to the end without blocking the caller's thread.
protocol ProcessRunning: Sendable {
    func run(_ executable: URL, arguments: [String], timeout: Duration) async throws -> ProcessOutput
}

/// Runs a real process. Output goes to files in a private temporary folder instead of pipes:
/// nothing has to read while the command runs, and a child it leaves running (Codex, started by
/// `restart-codex`) cannot keep the answer from arriving by holding a pipe open.
///
/// On timeout the process gets SIGTERM and, two seconds later, SIGKILL. Cancelling the task does
/// the same and throws `CancellationError`.
struct SystemProcessRunner: ProcessRunning {
    /// Output beyond this is cut off; the engine's answers are a few kilobytes.
    static let outputLimit = 16 * 1024 * 1024

    var environment: [String: String]

    init(environment: [String: String] = SystemProcessRunner.defaultEnvironment()) {
        self.environment = environment
    }

    /// A Dock- or login-launched app has a bare PATH; add the usual tool folders after it.
    static func defaultEnvironment() -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        var paths = (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
        for extra in ["/opt/homebrew/bin", "/usr/local/bin"] where !paths.contains(extra) { paths.append(extra) }
        environment["PATH"] = paths.joined(separator: ":")
        return environment
    }

    func run(_ executable: URL, arguments: [String], timeout: Duration) async throws -> ProcessOutput {
        try Task.checkCancellation()
        let scratch: ScratchFiles
        do { scratch = try ScratchFiles() } catch { throw ProcessRunError.launchFailed(error.localizedDescription) }
        defer { scratch.remove() }

        let job = ProcessJob(
            executable: executable, arguments: arguments, environment: environment,
            standardOutput: scratch.outputHandle, standardError: scratch.errorHandle)
        let outcome = await withTaskCancellationHandler {
            await job.run(timeout: timeout)
        } onCancel: {
            job.cancel()
        }
        scratch.closeHandles()

        switch outcome {
        case .launchFailed(let message):
            throw ProcessRunError.launchFailed(message)
        case .exited(let code):
            if job.wasCancelled { throw CancellationError() }
            if job.didTimeOut { throw ProcessRunError.timedOut }
            return ProcessOutput(exitCode: code, stdout: scratch.readOutput(limit: Self.outputLimit), stderr: scratch.readError(limit: Self.outputLimit))
        }
    }
}

private final class ScratchFiles: @unchecked Sendable {
    private let directory: URL
    let outputHandle: FileHandle
    let errorHandle: FileHandle
    private var closed = false

    init() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("cua-bar-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let output = directory.appendingPathComponent("out")
        let error = directory.appendingPathComponent("err")
        FileManager.default.createFile(atPath: output.path, contents: nil, attributes: [.posixPermissions: 0o600])
        FileManager.default.createFile(atPath: error.path, contents: nil, attributes: [.posixPermissions: 0o600])
        outputHandle = try FileHandle(forWritingTo: output)
        errorHandle = try FileHandle(forWritingTo: error)
    }

    func closeHandles() {
        guard !closed else { return }
        closed = true
        try? outputHandle.close()
        try? errorHandle.close()
    }

    func readOutput(limit: Int) -> Data { read("out", limit: limit) }
    func readError(limit: Int) -> Data { read("err", limit: limit) }

    private func read(_ name: String, limit: Int) -> Data {
        guard let handle = try? FileHandle(forReadingFrom: directory.appendingPathComponent(name)) else { return Data() }
        defer { try? handle.close() }
        return (try? handle.read(upToCount: limit)) ?? Data()
    }

    func remove() {
        closeHandles()
        try? FileManager.default.removeItem(at: directory)
    }
}

private final class ProcessJob: @unchecked Sendable {
    enum Outcome: Sendable {
        case exited(Int32)
        case launchFailed(String)
    }

    private let process = Process()
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Outcome, Never>?
    private var launched = false
    private var exited = false
    private var timedOut = false
    private var cancelled = false
    private var watchdog: DispatchWorkItem?

    init(executable: URL, arguments: [String], environment: [String: String], standardOutput: FileHandle, standardError: FileHandle) {
        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = standardOutput
        process.standardError = standardError
    }

    var wasCancelled: Bool { lock.withLock { cancelled } }
    var didTimeOut: Bool { lock.withLock { timedOut } }

    func run(timeout: Duration) async -> Outcome {
        let outcome = await withCheckedContinuation { (continuation: CheckedContinuation<Outcome, Never>) in
            lock.withLock { self.continuation = continuation }
            process.terminationHandler = { [self] process in finish(.exited(process.terminationStatus)) }
            do {
                try process.run()
            } catch {
                finish(.launchFailed(error.localizedDescription))
                return
            }
            let cancelledEarly = lock.withLock { () -> Bool in
                launched = true
                return cancelled
            }
            scheduleWatchdog(timeout)
            if cancelledEarly { terminate() }
        }
        process.terminationHandler = nil
        return outcome
    }

    func cancel() {
        lock.withLock { cancelled = true }
        terminate()
    }

    private func finish(_ outcome: Outcome) {
        let pending = lock.withLock { () -> CheckedContinuation<Outcome, Never>? in
            guard let continuation else { return nil }
            self.continuation = nil
            exited = true
            watchdog?.cancel()
            watchdog = nil
            return continuation
        }
        pending?.resume(returning: outcome)
    }

    private func scheduleWatchdog(_ timeout: Duration) {
        let components = timeout.components
        let seconds = Double(components.seconds) + Double(components.attoseconds) / 1e18
        let item = DispatchWorkItem { [weak self] in self?.timeoutFired() }
        lock.withLock { watchdog = item }
        DispatchQueue.global().asyncAfter(deadline: .now() + seconds, execute: item)
    }

    private func timeoutFired() {
        let live = lock.withLock { () -> Bool in
            guard launched, !exited else { return false }
            timedOut = true
            return true
        }
        if live { terminate() }
    }

    /// SIGTERM now, SIGKILL if it is still there two seconds later.
    private func terminate() {
        guard lock.withLock({ launched && !exited }) else { return }
        process.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [self] in
            if lock.withLock({ launched && !exited }) { kill(process.processIdentifier, SIGKILL) }
        }
    }
}
