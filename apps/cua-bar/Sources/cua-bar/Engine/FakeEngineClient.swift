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
        case unlockReset
        case setErrorText(Bool)
        case diagnose
        case probe(seconds: Int)
        case uninstall
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
        /// Answers to successive `stopConnection` calls, whichever connection and force, first one
        /// first (an error is thrown); before the per-connection answers. A normal stop that times
        /// out, then the forced one that works, is two entries.
        var stopConnectionQueue: [Result<StopResult, EngineError>] = []
        var stopGroup = GroupStopResult(ok: true, stopped: 0, failed: 0, results: [])
        var restartCodex = RestartResult(ok: true, reason: nil)
        /// Answers to successive `unlockReset` calls, first one first; when it runs dry the service needed nothing.
        var unlockResetQueue: [UnlockResetResult] = []
        /// nil: the switch is set as asked, and the status says so from then on.
        var settings: SettingsResult?
        var diagnosis = "CUA diagnosis (fake)\n"
        /// What the connection test answers (or throws).
        var probe: Result<ProbeOutcome, EngineError> = .success(.checked)
        /// While shut, `probe` calls wait here after being recorded.
        var probeGate: AsyncGate?
        /// When set, every action (not `status`) throws this instead of answering.
        var actionError: EngineError?
        /// Per-session answers for `releaseSession`, before falling back to `releaseSession`.
        var releaseSessionByID: [String: SessionReleaseResult] = [:]
        /// Sessions whose `releaseSession` throws this instead of answering.
        var releaseSessionErrorByID: [String: EngineError] = [:]
        /// While shut, `status` calls wait here after being recorded.
        var statusGate: AsyncGate?
        /// While shut, action calls wait here after being recorded.
        var actionGate: AsyncGate?
        /// What `uninstall` throws; nil means it worked. (Unlike other actions, only `uninstall` is affected.)
        var uninstallError: EngineError?
        /// Runs when `uninstall` is called, so a test can put it in order with other events.
        var onUninstall: (@Sendable () -> Void)?
    }

    private let lock = NSLock()
    private var script: Script
    private var recorded: [Call] = []
    private var recordedLoads: [ReleaseEndedLoad] = []
    private var recordedEarlierSessions: [Int] = []

    init(status: EngineStatus = EngineStatus()) {
        script = Script(status: .success(status))
    }

    var calls: [Call] { lock.withLock { recorded } }

    /// What each `releaseEnded` call was told it would have to do, in order.
    var releaseEndedLoads: [ReleaseEndedLoad] { lock.withLock { recordedLoads } }
    /// What each `releaseConnection` was told about sessions left under an earlier host, in order.
    var earlierSessionCounts: [Int] { lock.withLock { recordedEarlierSessions } }

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

    func releaseConnection(id: String, earlierSessions: Int) async throws -> ReleaseResult {
        lock.withLock { recordedEarlierSessions.append(earlierSessions) }
        let script = try await begin(.releaseConnection(id), isAction: true)
        return lock.withLock {
            self.script.releaseConnectionQueue.isEmpty ? script.releaseConnection : self.script.releaseConnectionQueue.removeFirst()
        }
    }

    func releaseEnded(_ load: ReleaseEndedLoad) async throws -> ReleaseEndedResult {
        lock.withLock { recordedLoads.append(load) }
        return try await begin(.releaseEnded, isAction: true).releaseEnded
    }

    func releaseSession(id: String, user: Bool) async throws -> SessionReleaseResult {
        let script = try await begin(.releaseSession(id, user: user), isAction: true)
        if let error = script.releaseSessionErrorByID[id] { throw error }
        return script.releaseSessionByID[id] ?? script.releaseSession
    }

    func stopConnection(id: String, force: Bool) async throws -> StopResult {
        let script = try await begin(.stopConnection(id, force: force), isAction: true)
        let queued = lock.withLock { self.script.stopConnectionQueue.isEmpty ? nil : self.script.stopConnectionQueue.removeFirst() }
        if let queued { return try queued.get() }
        return script.stopConnectionByID[id] ?? script.stopConnection
    }

    func stopGroup(_ group: StopGroup, force: Bool) async throws -> GroupStopResult {
        try await begin(.stopGroup(group, force: force), isAction: true).stopGroup
    }

    func restartCodex() async throws -> RestartResult {
        try await begin(.restartCodex, isAction: true).restartCodex
    }

    func unlockReset() async throws -> UnlockResetResult {
        _ = try await begin(.unlockReset, isAction: true)
        return lock.withLock {
            script.unlockResetQueue.isEmpty
                ? UnlockResetResult(ok: false, reason: "not_needed", restarts: 0, limit: 5)
                : script.unlockResetQueue.removeFirst()
        }
    }

    func setErrorText(_ keep: Bool) async throws -> SettingsResult {
        if let answer = try await begin(.setErrorText(keep), isAction: true).settings { return answer }
        lock.withLock {
            if case .success(var status) = script.status {
                status.settings.errorText = keep
                script.status = .success(status)
            }
        }
        return SettingsResult(ok: true, reason: nil, errorText: keep)
    }

    func diagnose() async throws -> String {
        try await begin(.diagnose, isAction: true).diagnosis
    }

    func probe(seconds: Int) async throws -> ProbeOutcome {
        let script = try await begin(.probe(seconds: seconds))
        await script.probeGate?.wait()
        return try script.probe.get()
    }

    func uninstall() async throws {
        let script = try await begin(.uninstall, isAction: true)
        script.onUninstall?()
        if let error = script.uninstallError { throw error }
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
