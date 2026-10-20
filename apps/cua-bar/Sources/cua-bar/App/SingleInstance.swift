import AppKit
import Foundation

/// One copy of the app at a time (R1): a second copy leaves at once, before it shows anything,
/// and without waking the first one or bringing any window forward.
enum SingleInstance {
    static let bundleIdentifier = "dev.chenjing.cua-bar"

    struct Instance: Equatable, Sendable {
        var pid: Int32
        var launchDate: Date?
        var isTerminated: Bool
    }

    /// True when another copy that is still running started before this one. Two copies opened
    /// at the same moment must not both leave, so the younger one (later launch, then higher pid)
    /// is the one that goes.
    static func shouldExit(me: Instance, others: [Instance]) -> Bool {
        others.contains { other in
            other.pid != me.pid && !other.isTerminated && started(other, before: me)
        }
    }

    private static func started(_ other: Instance, before me: Instance) -> Bool {
        let otherDate = other.launchDate ?? .distantPast
        let myDate = me.launchDate ?? .distantFuture
        if otherDate != myDate { return otherDate < myDate }
        return other.pid < me.pid
    }

    /// Everything the system lists for this bundle, this copy among them if it is registered yet.
    /// This copy is found by its process id: `NSRunningApplication.current` says -1 until the
    /// process is known to the system, which would make a lone copy look like a stranger.
    static func shouldExit(running: [Instance], myProcessIdentifier: Int32) -> Bool {
        let me = running.first { $0.pid == myProcessIdentifier }
            ?? Instance(pid: myProcessIdentifier, launchDate: nil, isTerminated: false)
        return shouldExit(me: me, others: running)
    }

    /// Asks the system who else runs this bundle. A copy run unbundled (`swift run`) is no copy of
    /// the app, so it never leaves because of the installed one. This is the first thing the app
    /// does, before it has an application object.
    static func anotherCopyIsRunning(
        bundleIdentifier: String = SingleInstance.bundleIdentifier,
        mainBundleIdentifier: String? = Bundle.main.bundleIdentifier,
        processIdentifier: Int32 = ProcessInfo.processInfo.processIdentifier
    ) -> Bool {
        guard mainBundleIdentifier == bundleIdentifier else { return false }
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).map(instance)
        return shouldExit(running: running, myProcessIdentifier: processIdentifier)
    }

    private static func instance(_ application: NSRunningApplication) -> Instance {
        Instance(pid: application.processIdentifier, launchDate: application.launchDate, isTerminated: application.isTerminated)
    }
}
