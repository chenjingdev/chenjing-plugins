import Foundation

/// F5: what the app releases by itself. An ended connection the engine can release, and a Claude
/// session it can aim at: both are things nobody can come back to. Each is tried once per app run,
/// then the lingering-lease notification and the person's click take over.
struct CleanupPlanner: Equatable, Sendable {
    private(set) var tried: Set<String> = []
    /// Codex answered `browser_blocked`: it refuses the browser to the conversations the engine makes (since Codex
    /// 26.1023), for every session alike. No session (`lease:`) is tried again until the app is started again. The
    /// ended connections are: the engine releases those through their own writers and never reaches the browser.
    private(set) var browserBlocked = false

    static func key(for connection: Connection) -> String { "connection:" + connection.id }

    static func key(for lease: LeftoverLease) -> String? {
        (lease.sessionID ?? lease.connectionID).map { "lease:" + $0 }
    }

    static func isCandidate(_ connection: Connection) -> Bool {
        connection.state == .ended && connection.canRelease
    }

    /// Codex chat sessions are never released by themselves: a Codex chat can be resumed after a
    /// restart, so only a click may release it.
    static func isCandidate(_ lease: LeftoverLease) -> Bool {
        lease.agent == .claude && lease.releasable
    }

    /// What is worth trying now: candidates in this status that were not tried yet.
    func untried(in status: EngineStatus) -> [String] {
        let connections = status.connections.filter { Self.isCandidate($0) }.map { Self.key(for: $0) }
        let blocked = browserBlocked || status.leases.releaseBlocked
        let leases = blocked ? [] : status.leases.maybeLeft.filter { Self.isCandidate($0) }.compactMap { Self.key(for: $0) }
        return (connections + leases).filter { !tried.contains($0) }
    }

    mutating func markTried(_ keys: [String]) {
        tried.formUnion(keys)
    }

    /// `browser_blocked` came back from a release: no more automatic release of sessions in this run of the app.
    mutating func markBrowserBlocked() {
        browserBlocked = true
    }
}
