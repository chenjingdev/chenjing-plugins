import Foundation

/// Decides which notifications are due, from the status and the clock. Pure, so tests can hand it
/// any time. Two kinds only, each posted once:
/// - Codex runs without the host (`codex_without_host`): once per Codex app process (its pids).
/// - A lease the owner left behind: once per session, when the owner has been gone for more than a
///   minute (`ended_at`, or when the app first saw it if that is null) and it is still listed (R16).
struct NotificationPlanner: Sendable {
    static let lingeringAfter: TimeInterval = 60
    /// After a post that did not go out (notifications off), try again no sooner than this.
    static let retryAfterRefusal: TimeInterval = 60

    private var delivered: Set<String> = []
    private var inFlight: Set<String> = []
    private var retryNotBefore: [String: Date] = [:]
    private var firstSeen: [String: Date] = [:]

    /// One key per Codex app process: the same pids are the same process.
    static func codexKey(for status: EngineStatus) -> String {
        "codex:" + status.codex.pids.sorted().map(String.init).joined(separator: ",")
    }

    /// The notifications to post now. They count as in flight until `finish` says how it went.
    ///
    /// `cleanupTried` and `cleanupRunning` come from the automatic cleanup (F5): a session it is
    /// about to release by itself is not worth a notification until it has tried and failed.
    mutating func due(
        status: EngineStatus, appVersion: String?, now: Date, cleanupTried: Set<String>, cleanupRunning: Bool
    ) -> [AppNotification] {
        var result: [AppNotification] = []

        if StatusEvaluator.problem(in: status, appVersion: appVersion)?.kind == .codexWithoutHost {
            let key = Self.codexKey(for: status)
            if canPost(key, now: now) { result.append(.codexWithoutHost(key: key)) }
        }

        var listed: Set<String> = []
        for entry in status.leases.maybeLeft {
            guard let id = entry.sessionID ?? entry.connectionID else { continue }
            let key = "lease:" + id
            listed.insert(key)
            let seen = firstSeen[key] ?? now
            firstSeen[key] = seen
            let goneSince = entry.endedAt ?? seen
            guard now.timeIntervalSince(goneSince) > Self.lingeringAfter else { continue }
            if CleanupPlanner.isCandidate(entry) {
                guard let cleanupKey = CleanupPlanner.key(for: entry), cleanupTried.contains(cleanupKey), !cleanupRunning else { continue }
            }
            if canPost(key, now: now) { result.append(.lingeringLease(key: key, entry: entry)) }
        }
        // An entry that is no longer listed starts over if it ever comes back.
        firstSeen = firstSeen.filter { listed.contains($0.key) }

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
