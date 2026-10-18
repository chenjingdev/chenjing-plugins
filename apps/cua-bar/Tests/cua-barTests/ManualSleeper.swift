import Foundation

/// A stand-in for `Task.sleep` that passes only when the test says so, so timer-driven code
/// (the refresh loop, the result banner) is tested without a clock and without flakiness.
final class ManualSleeper: @unchecked Sendable {
    private struct Waiter {
        var id: Int
        var duration: Duration
        var continuation: CheckedContinuation<Void, any Error>
    }

    private let lock = NSLock()
    private var waiters: [Waiter] = []
    private var cancelledBeforeWaiting: Set<Int> = []
    private var nextID = 0
    private var requested: [Duration] = []
    private var cancelled = 0

    /// Pass this as the view model's `sleep`.
    var sleep: @Sendable (Duration) async throws -> Void {
        { [self] duration in try await self.sleep(for: duration) }
    }

    /// Every duration asked for so far, in order.
    var requestedDurations: [Duration] { lock.withLock { requested } }
    /// The sleeps still waiting.
    var pendingDurations: [Duration] { lock.withLock { waiters.map(\.duration) } }
    /// How many sleeps were cancelled while waiting.
    var cancelledCount: Int { lock.withLock { cancelled } }

    /// Lets every waiting sleep pass; returns how many did.
    @discardableResult
    func releaseAll() -> Int {
        let released = lock.withLock { () -> [Waiter] in
            defer { waiters = [] }
            return waiters
        }
        for waiter in released { waiter.continuation.resume() }
        return released.count
    }

    private func sleep(for duration: Duration) async throws {
        let id = lock.withLock { () -> Int in
            nextID += 1
            requested.append(duration)
            return nextID
        }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                let alreadyCancelled = lock.withLock { () -> Bool in
                    if cancelledBeforeWaiting.remove(id) != nil { return true }
                    waiters.append(Waiter(id: id, duration: duration, continuation: continuation))
                    return false
                }
                if alreadyCancelled { continuation.resume(throwing: CancellationError()) }
            }
        } onCancel: {
            let waiter = lock.withLock { () -> Waiter? in
                if let index = waiters.firstIndex(where: { $0.id == id }) {
                    cancelled += 1
                    return waiters.remove(at: index)
                }
                cancelledBeforeWaiting.insert(id)
                return nil
            }
            waiter?.continuation.resume(throwing: CancellationError())
        }
    }
}
