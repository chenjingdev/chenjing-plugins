import Foundation

/// Decides which notifications are due, from the status and the clock. Pure, so tests can hand it
/// any time. Two kinds only, each posted once:
/// - Codex runs without the host (`codex_without_host`): once per Codex app process (its pids).
/// - A lease the owner left behind: once per session, when the owner has been gone for more than a
///   minute (`ended_at`, or when the app first saw it if that is null) and it is still listed (R16).
///   One the automatic cleanup is about to let go of, by itself or with the ended connection that still
///   serves its session, waits until the cleanup has tried and is done. One a live connection holds is
///   none: its owner is there. When that owner goes, the minute is counted from the first look without it.
struct NotificationPlanner: Sendable {
    static let lingeringAfter: TimeInterval = 60
    /// After a post that did not go out (notifications off), try again no sooner than this.
    static let retryAfterRefusal: TimeInterval = 60

    private var delivered: Set<String> = []
    private var inFlight: Set<String> = []
    private var retryNotBefore: [String: Date] = [:]
    private var firstSeen: [String: Date] = [:]
    /// The leases a live connection held at the last look: their owner is there, nobody has left them behind.
    private var heldByLiveOwner: Set<String> = []
    /// The leases that lost such an owner since. Their minute is counted from the first look without one, whatever
    /// `ended_at` says: that is when the writer that opened them ended, which may be long before the owner went.
    private var afterOwner: Set<String> = []

    /// One key per Codex app process: the same pids are the same process.
    static func codexKey(for status: EngineStatus) -> String {
        "codex:" + status.codex.pids.sorted().map(String.init).joined(separator: ",")
    }

    /// The notifications to post now. They count as in flight until `finish` says how it went.
    ///
    /// `cleanupTried` and `cleanupRunning` come from the automatic cleanup (F5): a session it is
    /// about to release by itself is not worth a notification until it has tried and failed.
    /// `tabsReleased`: the ended connections the app may only release, whose tabs it released in this run (their 정리 is off).
    /// `facts`: what the card judges from besides the status, so that Codex without its host is told only when the card
    /// says it too (a setup problem comes first, and a restart would not fix it).
    mutating func due(
        status: EngineStatus, appVersion: String?, now: Date, cleanupTried: Set<String>, cleanupRunning: Bool,
        tabsReleased: Set<String> = [], facts: LocalFacts = LocalFacts()
    ) -> [AppNotification] {
        var result: [AppNotification] = []

        if StatusEvaluator.problem(in: status, appVersion: appVersion, facts: facts)?.kind == .codexWithoutHost {
            let key = Self.codexKey(for: status)
            if canPost(key, now: now) { result.append(.codexWithoutHost(key: key)) }
        }

        var listed: Set<String> = []
        var held: Set<String> = []
        for entry in status.leases.maybeLeft {
            guard let id = entry.sessionID ?? entry.connectionID else { continue }
            let key = "lease:" + id
            // A live connection holds the session: its owner is there, so nobody left it behind (a thread whose runtime
            // died with a scope open and runs again). Not listed, so its minute starts when the owner goes.
            if TidyPlan.ownerIsAlive(for: entry, in: status) {
                held.insert(key)
                continue
            }
            listed.insert(key)
            if heldByLiveOwner.contains(key) {
                firstSeen[key] = nil
                afterOwner.insert(key)
            }
            let seen = firstSeen[key] ?? now
            firstSeen[key] = seen
            let goneSince = afterOwner.contains(key) ? max(entry.endedAt ?? seen, seen) : (entry.endedAt ?? seen)
            guard now.timeIntervalSince(goneSince) > Self.lingeringAfter else { continue }
            if CleanupPlanner.isCandidate(entry) {
                guard let cleanupKey = CleanupPlanner.key(for: entry), cleanupTried.contains(cleanupKey), !cleanupRunning else { continue }
            } else if let covering = TidyPlan.lineToPress(for: entry, in: status, tabsReleased: tabsReleased), CleanupPlanner.isCandidate(covering) {
                // An ended connection still serves the session: the same cleanup lets go of both (S21).
                guard cleanupTried.contains(CleanupPlanner.key(for: covering)), !cleanupRunning else { continue }
            }
            // `ended_at` null on an entry of a bridge that still runs: a session from before Codex
            // restarted (contract, P4), not a connection that ended.
            let beforeRestart = entry.endedAt == nil && status.isLive(connectionID: entry.connectionID)
            if canPost(key, now: now) { result.append(.lingeringLease(key: key, entry: entry, beforeRestart: beforeRestart)) }
        }
        // An entry that is no longer listed starts over if it ever comes back.
        firstSeen = firstSeen.filter { listed.contains($0.key) }
        afterOwner.formIntersection(listed)
        heldByLiveOwner = held

        inFlight.formUnion(result.map(\.key))
        return result
    }

    mutating func finish(_ key: String, wasDelivered: Bool, now: Date) {
        inFlight.remove(key)
        if wasDelivered {
            delivered.insert(key)
        } else {
            retryNotBefore[key] = now.addingTimeInterval(Self.retryAfterRefusal)
        }
    }

    private func canPost(_ key: String, now: Date) -> Bool {
        guard !delivered.contains(key), !inFlight.contains(key) else { return false }
        return retryNotBefore[key].map { now >= $0 } ?? true
    }
}
