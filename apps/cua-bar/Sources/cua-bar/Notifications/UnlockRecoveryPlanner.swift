import Foundation

/// F8: when a CUA call failed because the computer-use service's automatic unlock could not unlock the Mac (the line's
/// `unlock_failed`), the app asks the engine's `unlock-reset`. The engine decides everything: whether the Mac is still
/// locked, whether this failure came after its last restart, whether a call runs, and it restarts the service at most
/// five times in one lock. The app only asks once after each new such failure, and tells the person once when the
/// restarts of a lock did not help. Pure, so tests can hand it any status and time.
struct UnlockRecoveryPlanner: Sendable {
    /// A failure older than this is history: an app that starts later does not ask about it.
    static let fresh: TimeInterval = 10 * 60
    static let failure = "unlock_failed"

    /// The newest failure already asked about.
    private var asked: Date?
    /// The person was told that this lock's restarts did not help, and no answer since says the lock is over.
    private var toldLimit = false

    /// True when the engine should be asked now: there is a recent failure newer than the last one asked about. It
    /// counts as asked from here on.
    mutating func due(in status: EngineStatus, now: Date) -> Bool {
        let newest = status.activity.filter { $0.ok == false && $0.error == Self.failure }.compactMap(\.at).max()
        guard let newest, now.timeIntervalSince(newest) <= Self.fresh, newest > (asked ?? .distantPast) else { return false }
        asked = newest
        return true
    }

    /// True when this answer is the one to tell the person about: the limit, the first time in a lock. A restart, a Mac
    /// that is not locked and a service that needs nothing mean a new lock may come; waiting, busy and unreadable say
    /// nothing about the lock.
    mutating func tells(_ result: UnlockResetResult) -> Bool {
        if result.reason == "limit" {
            defer { toldLimit = true }
            return !toldLimit
        }
        if result.ok || ["not_locked", "not_needed"].contains(result.reason) { toldLimit = false }
        return false
    }
}
