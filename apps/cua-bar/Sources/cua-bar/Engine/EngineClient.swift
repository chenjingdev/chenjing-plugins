import Foundation

/// The app's only way to know anything or to change anything: the engine behind `codex-cua`.
/// The real implementation runs the command; tests and previews use `FakeEngineClient`.
///
/// Every method suspends instead of blocking, so callers on the main actor stay responsive.
/// An action that ran but did not succeed returns a result with `ok == false` and a reason; a
/// thrown `EngineError` means the engine could not be asked at all.
protocol EngineClient: Sendable {
    func status() async throws -> EngineStatus
    /// `release --connection <id>`
    func releaseConnection(id: String) async throws -> ReleaseResult
    /// `release --ended`
    func releaseEnded() async throws -> ReleaseEndedResult
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
    /// `diagnose`: plain text that is safe to paste into a chat.
    func diagnose() async throws -> String
    /// `setup`: the existing installer (command, dependencies, login environment).
    func runSetup() async throws
}
