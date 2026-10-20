import AppKit

/// An app a person works in, as much as it takes to ask the system for it again. It is kept by process id and
/// bundle id and not as an `NSRunningApplication`: a recycled process id is then not taken for the old app, and a
/// test can make one up.
struct FrontApp: Equatable, Sendable {
    var pid: pid_t
    var bundleID: String?
}

/// Who is in front, and what this app may do about it, behind a seam: `WorkspaceFrontApps` in the app, a fake in
/// the tests. Nothing a test does ever changes the front app of the Mac it runs on.
@MainActor
protocol FrontAppSwitching: AnyObject {
    /// This app is the one in front.
    var thisAppIsFront: Bool { get }
    /// The app in front now when it is another app a person works in; nil when this app is in front or nobody is known.
    var otherFrontApp: FrontApp? { get }
    /// Tells `handler` each time another app a person works in comes to the front. This app's own coming to the front is
    /// not told: what is remembered is the app before it.
    func observeFrontApps(_ handler: @escaping @MainActor @Sendable (FrontApp) -> Void)
    /// `app` is still running, so it can be asked for.
    func isRunning(_ app: FrontApp) -> Bool
    /// Asks the system to put `app` in front on behalf of this app, which holds the front place. False when the system
    /// would not.
    func bringToFront(_ app: FrontApp) -> Bool
    /// This app lets go of the front place and the system hands it to the next app in line, as Cmd-H does.
    func putDownFront()
    /// Shows this app's windows again after `putDownFront` hid them. Does not make this app the front app.
    func unhideThisApp()
}

/// What happens to the front place when this app's popover closes (S21).
///
/// A click on a notification brings this app to the front (macOS does that, and the popover opens on top of it). The
/// app has no other window, so when the popover closes the person has nowhere to type: S21 saw CUA Bar stay in front
/// for 46 seconds. Then the front goes back to the app the person was working in. The menu bar icon leaves the front
/// app alone, so after that way in this app is not in front and there is nothing to give back (S33).
@MainActor
final class FrontHandoff {
    enum Outcome: Equatable {
        /// Another window of this app (the verify panel) is still open, so the front place stays.
        case otherViewOpen
        /// This app was not in front, so nothing is asked of the system.
        case notInFront
        /// The front place went back to that app.
        case returned(FrontApp)
        /// There was no app to go back to (none known, it quit, or the system would not): this app let go of the front place.
        case putDown
    }

    /// How long after handing the front place back this app looks again. The system may say yes and still not do it:
    /// `activate(from:options:)` "does not guarantee that the app will be activated at all".
    static let settleDelay: TimeInterval = 0.5

    private let apps: any FrontAppSwitching
    /// Runs the work on the main actor after the delay (a test runs it when it likes).
    private let later: @MainActor (TimeInterval, @escaping @MainActor @Sendable () -> Void) -> Void
    /// The app that was in front last, before this one: the last app a person works in that came to the front.
    private(set) var previous: FrontApp?

    init(
        apps: any FrontAppSwitching,
        later: @escaping @MainActor (TimeInterval, @escaping @MainActor @Sendable () -> Void) -> Void = FrontHandoff.afterDelay
    ) {
        self.apps = apps
        self.later = later
        // Whoever is in front as the app starts is the first app remembered (nil when it is this app, started by a click
        // on a notification: then putting the front place down leaves it to the system's next app).
        previous = apps.otherFrontApp
        apps.observeFrontApps { [weak self] app in self?.previous = app }
    }

    /// The popover has closed. `otherViewIsOpen`: another view of the same model is still shown. `stillClosed`: asked
    /// at the second look, true while nothing of this app is shown again.
    @discardableResult
    func popoverClosed(otherViewIsOpen: Bool, stillClosed: @escaping @MainActor @Sendable () -> Bool = { true }) -> Outcome {
        guard !otherViewIsOpen else { return .otherViewOpen }
        guard apps.thisAppIsFront else { return .notInFront }
        if let previous, apps.isRunning(previous), apps.bringToFront(previous) {
            later(Self.settleDelay) { [weak self] in self?.settle(stillClosed: stillClosed) }
            return .returned(previous)
        }
        apps.putDownFront()
        return .putDown
    }

    /// The second look after a handover the system said yes to: this app still in front with nothing of its own shown
    /// means the handover did not happen, and this app lets go of the front place as when there is no app to go back to.
    private func settle(stillClosed: @MainActor () -> Bool) {
        guard stillClosed(), apps.thisAppIsFront else { return }
        apps.putDownFront()
    }

    static func afterDelay(_ delay: TimeInterval, _ work: @escaping @MainActor @Sendable () -> Void) {
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(delay))
            work()
        }
    }

    /// Before this app shows a window of its own. Putting the front place down hides the app, and a hidden app shows
    /// nothing; the person's next click on the icon must still open the popover, without taking the front.
    func prepareToShowWindow() {
        apps.unhideThisApp()
    }
}

/// The real thing: `NSWorkspace` for who is in front, `NSApplication` for this app's own part.
@MainActor
final class WorkspaceFrontApps: FrontAppSwitching {
    private let workspace: NSWorkspace
    private let center: NotificationCenter
    /// Kept for as long as the app lives, like the controller that owns this.
    private var observation: (any NSObjectProtocol)?

    /// `center`: where activations are posted (the workspace's own; a private one in tests).
    init(workspace: NSWorkspace = .shared, center: NotificationCenter? = nil) {
        self.workspace = workspace
        self.center = center ?? workspace.notificationCenter
    }

    /// Both views of "in front" must say so: AppKit's own, which this app's activation events set, and the system's.
    /// Handing the front back on one stale reading would take it from the app a person has just clicked. The system's
    /// is compared by process id: `NSRunningApplication.current` is not reliable early in a process's life.
    var thisAppIsFront: Bool {
        NSApplication.shared.isActive
            && workspace.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier
    }

    var otherFrontApp: FrontApp? {
        workspace.frontmostApplication.flatMap { Self.frontApp(for: $0) }
    }

    func observeFrontApps(_ handler: @escaping @MainActor @Sendable (FrontApp) -> Void) {
        observation = center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
            guard let app = Self.frontApp(from: note) else { return }
            MainActor.assumeIsolated { handler(app) }
        }
    }

    func isRunning(_ app: FrontApp) -> Bool {
        Self.running(app) != nil
    }

    func bringToFront(_ app: FrontApp) -> Bool {
        guard let running = Self.running(app) else { return false }
        // This app holds the front place, so it passes it on: it yields first, then asks for the other app on its own
        // behalf (macOS 14's cooperative activation). `[]` raises the app's main and key windows, not all of them.
        NSApplication.shared.yieldActivation(to: running)
        let this = NSRunningApplication(processIdentifier: ProcessInfo.processInfo.processIdentifier) ?? .current
        return running.activate(from: this, options: [])
    }

    func putDownFront() {
        NSApplication.shared.hide(nil)
    }

    func unhideThisApp() {
        NSApplication.shared.showAgainIfHidden()
    }

    // MARK: Reading the system

    /// The app an activation notification is about, when it is another app a person works in.
    nonisolated static func frontApp(from notification: Notification) -> FrontApp? {
        (notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication).flatMap { frontApp(for: $0) }
    }

    /// Not this app, and only an app with a Dock icon: background helpers, Spotlight and the like are not somewhere a
    /// person was working, and the system would not give the front place back to a background-only one.
    nonisolated static func frontApp(for running: NSRunningApplication) -> FrontApp? {
        guard
            running.processIdentifier != ProcessInfo.processInfo.processIdentifier,
            running.activationPolicy == .regular,
            !running.isTerminated
        else { return nil }
        return FrontApp(pid: running.processIdentifier, bundleID: running.bundleIdentifier)
    }

    /// The running app `app` stands for. Not one that quit, and not another app that was given its process id since.
    nonisolated static func running(_ app: FrontApp) -> NSRunningApplication? {
        guard
            let running = NSRunningApplication(processIdentifier: app.pid),
            !running.isTerminated,
            running.bundleIdentifier == app.bundleID
        else { return nil }
        return running
    }
}

extension NSApplication {
    /// Shows this app's windows again after `hide`, without making it the front app.
    func showAgainIfHidden() {
        if isHidden { unhideWithoutActivation() }
    }
}
