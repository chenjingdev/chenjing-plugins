import Foundation

/// A door that stays shut until `open()`, then stays open. Holds a fake engine call in flight
/// for exactly as long as a test wants, with no clock involved.
final class AsyncGate: @unchecked Sendable {
    private let lock = NSLock()
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let passThrough = lock.withLock { () -> Bool in
                if isOpen { return true }
                waiters.append(continuation)
                return false
            }
            if passThrough { continuation.resume() }
        }
    }

    func open() {
        let pending = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            isOpen = true
            defer { waiters = [] }
            return waiters
        }
        for continuation in pending { continuation.resume() }
    }
}

/// An engine for tests and previews: answers from values it is given and remembers what it was
/// asked. Nothing leaves the process.
final class FakeEngineClient: EngineClient, @unchecked Sendable {
    enum Call: Equatable, Sendable {
        case status
        case releaseConnection(String)
        case releaseEnded
        case releaseSession(String, user: Bool)
        case stopConnection(String, force: Bool)
        case stopGroup(StopGroup, force: Bool)
        case restartCodex
        case diagnose
        case runSetup
    }

    struct Script: Sendable {
        var status: Result<EngineStatus, EngineError> = .success(EngineStatus())
        var releaseConnection = ReleaseResult(ok: true, released: true, reason: nil, scopeCount: 1)
        /// Answers to successive `releaseConnection` calls, first one first; when it runs dry the
        /// plain `releaseConnection` answers.
        var releaseConnectionQueue: [ReleaseResult] = []
        var releaseEnded = ReleaseEndedResult(ok: true, results: [])
        var releaseSession = SessionReleaseResult(ok: true, released: true, reason: nil, tabCount: 1)
        var stopConnection = StopResult(ok: true, stopped: true, released: true, reason: nil)
        /// Per-connection answers for `stopConnection`, before falling back to `stopConnection`.
        var stopConnectionByID: [String: StopResult] = [:]
        var stopGroup = GroupStopResult(ok: true, stopped: 0, failed: 0, results: [])
        var restartCodex = RestartResult(ok: true, reason: nil)
        var diagnosis = "CUA diagnosis (fake)\n"
        /// When set, every action (not `status`) throws this instead of answering.
        var actionError: EngineError?
        /// Per-session answers for `releaseSession`, before falling back to `releaseSession`.
        var releaseSessionByID: [String: SessionReleaseResult] = [:]
        /// While shut, `status` calls wait here after being recorded.
        var statusGate: AsyncGate?
        /// While shut, action calls wait here after being recorded.
        var actionGate: AsyncGate?
    }

    private let lock = NSLock()
    private var script: Script
    private var recorded: [Call] = []

    init(status: EngineStatus = EngineStatus()) {
        script = Script(status: .success(status))
    }

    var calls: [Call] { lock.withLock { recorded } }

    var statusCallCount: Int { calls.filter { $0 == .status }.count }

    func configure(_ change: (inout Script) -> Void) {
        lock.withLock { change(&script) }
    }

    func setStatus(_ status: EngineStatus) { configure { $0.status = .success(status) } }

    func setStatusError(_ error: EngineError) { configure { $0.status = .failure(error) } }

    // MARK: EngineClient

    func status() async throws -> EngineStatus {
        let script = try await begin(.status)
        return try script.status.get()
    }

    func releaseConnection(id: String) async throws -> ReleaseResult {
        let script = try await begin(.releaseConnection(id), isAction: true)
        return lock.withLock {
            self.script.releaseConnectionQueue.isEmpty ? script.releaseConnection : self.script.releaseConnectionQueue.removeFirst()
        }
    }

    func releaseEnded() async throws -> ReleaseEndedResult {
        try await begin(.releaseEnded, isAction: true).releaseEnded
    }

    func releaseSession(id: String, user: Bool) async throws -> SessionReleaseResult {
        let script = try await begin(.releaseSession(id, user: user), isAction: true)
        return script.releaseSessionByID[id] ?? script.releaseSession
    }

    func stopConnection(id: String, force: Bool) async throws -> StopResult {
        let script = try await begin(.stopConnection(id, force: force), isAction: true)
        return script.stopConnectionByID[id] ?? script.stopConnection
    }

    func stopGroup(_ group: StopGroup, force: Bool) async throws -> GroupStopResult {
        try await begin(.stopGroup(group, force: force), isAction: true).stopGroup
    }

    func restartCodex() async throws -> RestartResult {
        try await begin(.restartCodex, isAction: true).restartCodex
    }

    func diagnose() async throws -> String {
        try await begin(.diagnose, isAction: true).diagnosis
    }

    func runSetup() async throws {
        _ = try await begin(.runSetup, isAction: true)
    }

    /// Records the call, waits at the gate if one is shut, and hands back the script as it is now.
    private func begin(_ call: Call, isAction: Bool = false) async throws -> Script {
        let script = lock.withLock { () -> Script in
            recorded.append(call)
            return self.script
        }
        await (isAction ? script.actionGate : script.statusGate)?.wait()
        if isAction, let error = script.actionError { throw error }
        return script
    }
}
