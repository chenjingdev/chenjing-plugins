import Foundation

/// An engine for tests and previews: answers from values it is given and remembers what it was
/// asked. Nothing leaves the process.
final class FakeEngineClient: EngineClient, @unchecked Sendable {
    enum Call: Equatable, Sendable {
        case status
        case releaseConnection(String)
        case releaseEnded
        case releaseSession(String)
        case stopConnection(String, force: Bool)
        case stopGroup(StopGroup, force: Bool)
        case restartCodex
        case diagnose
        case runSetup
    }

    struct Script: Sendable {
        var status: Result<EngineStatus, EngineError> = .success(EngineStatus())
        var releaseConnection = ReleaseResult(ok: true, released: true, reason: nil, scopeCount: 1)
        var releaseEnded = ReleaseEndedResult(ok: true, results: [])
        var releaseSession = ReleaseResult(ok: true, released: true, reason: nil, scopeCount: 1)
        var stopConnection = StopResult(ok: true, stopped: true, released: true, reason: nil)
        var stopGroup = GroupStopResult(ok: true, stopped: 0, failed: 0, results: [])
        var restartCodex = RestartResult(ok: true, reason: nil)
        var diagnosis = "CUA diagnosis (fake)\n"
        /// When set, every action (not `status`) throws this instead of answering.
        var actionError: EngineError?
        /// Per-session answers for `releaseSession`, before falling back to `releaseSession`.
        var releaseSessionByID: [String: ReleaseResult] = [:]
        /// How long each call takes, to exercise slow engines.
        var delay: Duration = .zero
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
        return script.releaseConnection
    }

    func releaseEnded() async throws -> ReleaseEndedResult {
        try await begin(.releaseEnded, isAction: true).releaseEnded
    }

    func releaseSession(id: String) async throws -> ReleaseResult {
        let script = try await begin(.releaseSession(id), isAction: true)
        return script.releaseSessionByID[id] ?? script.releaseSession
    }

    func stopConnection(id: String, force: Bool) async throws -> StopResult {
        try await begin(.stopConnection(id, force: force), isAction: true).stopConnection
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

    /// Records the call, waits the scripted delay, and hands back the script as it is now.
    private func begin(_ call: Call, isAction: Bool = false) async throws -> Script {
        let script = lock.withLock { () -> Script in
            recorded.append(call)
            return self.script
        }
        if script.delay > .zero { try await Task.sleep(for: script.delay) }
        if isAction, let error = script.actionError { throw error }
        return script
    }
}
