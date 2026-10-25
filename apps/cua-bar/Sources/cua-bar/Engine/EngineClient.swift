import Foundation

/// How much `release --ended` has to get through, as the latest status lists it: the engine asks
/// every ended connection in turn, then releases the Claude sessions left behind. Only the
/// command's time limit depends on it.
struct ReleaseEndedLoad: Equatable, Sendable {
    var endedConnections = 0
    /// Releasable Claude `maybe_left` sessions.
    var claudeSessions = 0
}

extension ReleaseEndedLoad {
    /// Counted from a status; without one (nothing read yet) there is nothing to count.
    init(status: EngineStatus?) {
        self.init(
            endedConnections: status?.connections.filter { $0.state == .ended }.count ?? 0,
            claudeSessions: status?.leases.maybeLeft.filter { CleanupPlanner.isCandidate($0) }.count ?? 0)
    }
}

/// The app's only way to know anything or to change anything: the engine behind `codex-cua`.
/// The real implementation runs the command; tests and previews use `FakeEngineClient`.
///
/// Every method suspends instead of blocking, so callers on the main actor stay responsive.
/// An action that ran but did not succeed returns a result with `ok == false` and a reason; a
/// thrown `EngineError` means the engine could not be asked at all.
protocol EngineClient: Sendable {
    func status() async throws -> EngineStatus
    /// `release --connection <id>`. `earlierSessions` is how many sessions the latest status lists as left by this
    /// connection under an earlier Codex host (the `maybe_left` entries that name it): the command releases those by
    /// id after the bridge's own release, and its time limit grows with them.
    func releaseConnection(id: String, earlierSessions: Int) async throws -> ReleaseResult
    /// `release --ended`. `load` is what the latest status says it will have to do: the command's
    /// time limit grows with it.
    func releaseEnded(_ load: ReleaseEndedLoad) async throws -> ReleaseEndedResult
    /// `release-session --session <id> [--user]`. `user` is true when a person pressed a button:
    /// a Codex thread's session is released only then (`needs_user` otherwise), so automatic
    /// cleanup passes false.
    func releaseSession(id: String, user: Bool) async throws -> SessionReleaseResult
    /// `stop --connection <id> [--force]`
    func stopConnection(id: String, force: Bool) async throws -> StopResult
    /// `stop --group all|claude|codex [--force]`
    func stopGroup(_ group: StopGroup, force: Bool) async throws -> GroupStopResult
    /// `restart-codex`: a normal quit (never a force quit), then Codex is opened again.
    func restartCodex() async throws -> RestartResult
    /// `settings --error-text on|off`: whether a failed call's line keeps what its answer said, from the next failure on.
    func setErrorText(_ keep: Bool) async throws -> SettingsResult
    /// `diagnose`: plain text that is safe to paste into a chat.
    func diagnose() async throws -> String
    /// `doctor --probe --json --timeout <seconds>`: one `cua.getState()` on a thread of its own against a Codex
    /// host that is ready; how that ended. A host that is not ready ends it at once (`hostUnavailable`) and the
    /// engine starts nothing for it. Throws only when the command could not be run or read.
    func probe(seconds: Int) async throws -> ProbeOutcome
    /// `uninstall`: the existing remover. It also removes the login environment, and it refuses
    /// while a Codex host is running (the command then exits non-zero and nothing is removed).
    /// Throws `engineMissing` when there is no engine: nothing was set up to undo.
    func uninstall() async throws
}

extension EngineClient {
    /// A release with no session left under an earlier host.
    func releaseConnection(id: String) async throws -> ReleaseResult {
        try await releaseConnection(id: id, earlierSessions: 0)
    }
}
