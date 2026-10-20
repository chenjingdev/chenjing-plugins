import AppKit
import Testing
@testable import cua_bar

/// Who is in front on a Mac that is made up: it records what the app asked of the system, and nothing a test does here
/// changes the front app of the Mac the tests run on. As the system does, it tells the observers about an app that comes
/// to the front, and an app that is brought to the front takes the place.
@MainActor
final class FakeFrontApps: FrontAppSwitching {
    enum Front: Equatable {
        case nobody
        case thisApp
        case other(FrontApp)
    }

    private(set) var front: Front
    private var running: Set<pid_t>
    private var observers: [@MainActor @Sendable (FrontApp) -> Void] = []
    /// The system does not allow the request: `bringToFront` answers false.
    var refusesToBringToFront = false
    /// The system says yes and does not do it: `bringToFront` answers true and this app stays in front.
    var keepsThisAppInFront = false
    /// Every `bringToFront`, the refused ones too.
    private(set) var asked: [FrontApp] = []
    private(set) var putDowns = 0
    /// Hidden by `putDownFront` until `unhideThisApp`.
    private(set) var isHidden = false
    private(set) var unhides = 0

    init(front: Front = .nobody, running apps: [FrontApp] = []) {
        self.front = front
        running = Set(apps.map(\.pid))
        if case .other(let app) = front { running.insert(app.pid) }
    }

    var thisAppIsFront: Bool { front == .thisApp }

    var otherFrontApp: FrontApp? {
        if case .other(let app) = front { app } else { nil }
    }

    func observeFrontApps(_ handler: @escaping @MainActor @Sendable (FrontApp) -> Void) {
        observers.append(handler)
    }

    func isRunning(_ app: FrontApp) -> Bool { running.contains(app.pid) }

    func bringToFront(_ app: FrontApp) -> Bool {
        asked.append(app)
        guard !refusesToBringToFront, running.contains(app.pid) else { return false }
        if !keepsThisAppInFront { comesToFront(app) }
        return true
    }

    func putDownFront() {
        putDowns += 1
        isHidden = true
        front = .nobody
    }

    func unhideThisApp() {
        guard isHidden else { return }
        unhides += 1
        isHidden = false
    }

    // MARK: What happens on the Mac

    /// The person (or the system) puts `app` in front; it is running from then on.
    func comesToFront(_ app: FrontApp) {
        running.insert(app.pid)
        front = .other(app)
        for observer in observers { observer(app) }
    }

    /// A click on a notification: macOS makes this app the front app. The observers are not told about this app.
    func thisAppComesToFront() { front = .thisApp }

    func quits(_ app: FrontApp) { running.remove(app.pid) }
}

/// S21: a notification brought CUA Bar to the front, and closing its popover left it there for 46 seconds.
@MainActor
struct FrontHandoffTests {
    private let terminal = FrontApp(pid: 501, bundleID: "dev.example.terminal")
    private let browser = FrontApp(pid: 502, bundleID: "dev.example.browser")

    // MARK: Closing the popover that a notification opened

    @Test func closingWhileThisAppIsInFrontGivesTheFrontBackToTheAppThePersonWasIn() {
        // The person works in the terminal; a click on the notification brings this app to the front.
        let apps = FakeFrontApps(front: .other(terminal))
        let handoff = FrontHandoff(apps: apps)
        #expect(handoff.previous == terminal, "the app in front as this one starts is the first remembered")
        apps.thisAppComesToFront()

        #expect(handoff.popoverClosed(otherViewIsOpen: false) == .returned(terminal))
        #expect(apps.asked == [terminal])
        #expect(apps.front == .other(terminal), "the terminal has the front place again")
        #expect(apps.putDowns == 0, "this app did not have to let go of it")
        #expect(handoff.popoverClosed(otherViewIsOpen: false) == .notInFront, "and a second close finds nothing to give back")
        #expect(apps.asked == [terminal])
    }

    @Test func theAppToGoBackToIsTheLastOneThatWasInFrontBeforeThisApp() {
        let apps = FakeFrontApps(front: .other(terminal))
        let handoff = FrontHandoff(apps: apps)
        apps.comesToFront(browser) // the person moved on to the browser, and the notification came then
        apps.thisAppComesToFront()
        #expect(handoff.previous == browser)

        #expect(handoff.popoverClosed(otherViewIsOpen: false) == .returned(browser))
        #expect(apps.asked == [browser], "not the terminal from earlier")
    }

    @Test func anAppThatHasQuitSinceIsNotAskedForAndThisAppLetsGoOfTheFront() {
        let apps = FakeFrontApps(front: .other(terminal))
        let handoff = FrontHandoff(apps: apps)
        apps.thisAppComesToFront()
        apps.quits(terminal) // closed (Cmd-Q) while the popover was open

        #expect(handoff.popoverClosed(otherViewIsOpen: false) == .putDown)
        #expect(apps.asked.isEmpty, "a quit app is not asked for")
        #expect(apps.putDowns == 1)
    }

    @Test func withNoAppKnownThisAppLetsGoOfTheFront() {
        // The click on the notification started this app: it was in front from the first moment.
        let apps = FakeFrontApps(front: .thisApp)
        let handoff = FrontHandoff(apps: apps)
        #expect(handoff.previous == nil)

        #expect(handoff.popoverClosed(otherViewIsOpen: false) == .putDown)
        #expect(apps.asked.isEmpty)
        #expect(apps.putDowns == 1)
    }

    @Test func aRequestTheSystemRefusesEndsWithThisAppLettingGoOfTheFront() {
        let apps = FakeFrontApps(front: .other(terminal))
        let handoff = FrontHandoff(apps: apps)
        apps.thisAppComesToFront()
        apps.refusesToBringToFront = true

        #expect(handoff.popoverClosed(otherViewIsOpen: false) == .putDown)
        #expect(apps.asked == [terminal], "it was asked first")
        #expect(apps.putDowns == 1)
    }

    // MARK: The second look after a handover

    /// Holds what `FrontHandoff` asks to run later, so a test runs it when it likes.
    @MainActor private final class Later {
        private(set) var delays: [TimeInterval] = []
        private var works: [@MainActor @Sendable () -> Void] = []

        func schedule(_ delay: TimeInterval, _ work: @escaping @MainActor @Sendable () -> Void) {
            delays.append(delay)
            works.append(work)
        }

        func runAll() {
            let due = works
            works = []
            for work in due { work() }
        }
    }

    @Test func aHandoverTheSystemSaysYesToButDoesNotCarryOutEndsWithThisAppLettingGoOfTheFront() {
        let apps = FakeFrontApps(front: .other(terminal))
        let later = Later()
        let handoff = FrontHandoff(apps: apps, later: later.schedule)
        apps.thisAppComesToFront()
        apps.keepsThisAppInFront = true

        #expect(handoff.popoverClosed(otherViewIsOpen: false) == .returned(terminal))
        #expect(later.delays == [FrontHandoff.settleDelay], "it looks again a moment later")
        #expect(apps.putDowns == 0, "not before the second look")
        later.runAll()
        #expect(apps.putDowns == 1, "still in front with nothing shown: this app lets go of the front place")
    }

    @Test func theSecondLookLeavesAHandoverThatWorkedAlone() {
        let apps = FakeFrontApps(front: .other(terminal))
        let later = Later()
        let handoff = FrontHandoff(apps: apps, later: later.schedule)
        apps.thisAppComesToFront()

        #expect(handoff.popoverClosed(otherViewIsOpen: false) == .returned(terminal))
        later.runAll()
        #expect(apps.putDowns == 0)
        #expect(apps.front == .other(terminal))
    }

    @Test func theSecondLookLeavesThisAppAloneWhenItShowsSomethingAgain() {
        let apps = FakeFrontApps(front: .other(terminal))
        let later = Later()
        let handoff = FrontHandoff(apps: apps, later: later.schedule)
        apps.thisAppComesToFront()
        apps.keepsThisAppInFront = true

        #expect(handoff.popoverClosed(otherViewIsOpen: false, stillClosed: { false }) == .returned(terminal))
        later.runAll()
        #expect(apps.putDowns == 0, "the person opened the popover again in the meantime")
    }

    @Test func noSecondLookIsNeededWhenThereWasNothingToHandOver() {
        let apps = FakeFrontApps(front: .other(terminal))
        let later = Later()
        let handoff = FrontHandoff(apps: apps, later: later.schedule)

        #expect(handoff.popoverClosed(otherViewIsOpen: false) == .notInFront)
        apps.thisAppComesToFront()
        apps.refusesToBringToFront = true
        #expect(handoff.popoverClosed(otherViewIsOpen: false) == .putDown)
        #expect(later.delays.isEmpty)
    }

    // MARK: Closing a popover that did not take the front

    @Test func closingWhenThisAppIsNotInFrontAsksNothingOfTheSystem() {
        // The menu bar icon opens the popover and the terminal stays in front (S33).
        let apps = FakeFrontApps(front: .other(terminal), running: [browser])
        let handoff = FrontHandoff(apps: apps)

        #expect(handoff.popoverClosed(otherViewIsOpen: false) == .notInFront)
        #expect(apps.asked.isEmpty)
        #expect(apps.putDowns == 0)
        #expect(apps.front == .other(terminal))
    }

    @Test func closingBecauseThePersonClickedAnotherAppLeavesThatApp() {
        let apps = FakeFrontApps(front: .other(terminal))
        let handoff = FrontHandoff(apps: apps)
        apps.thisAppComesToFront()
        apps.comesToFront(browser) // the click in the browser's window closes the popover

        #expect(handoff.popoverClosed(otherViewIsOpen: false) == .notInFront)
        #expect(apps.asked.isEmpty)
        #expect(apps.front == .other(browser), "the person's own choice stays")
    }

    @Test func anotherViewOfThisAppThatIsStillOpenKeepsTheFront() {
        // The verify panel is shown: closing the popover does not close the model's view, nor give the front back.
        let apps = FakeFrontApps(front: .other(terminal))
        let handoff = FrontHandoff(apps: apps)
        apps.thisAppComesToFront()

        #expect(handoff.popoverClosed(otherViewIsOpen: true) == .otherViewOpen)
        #expect(apps.asked.isEmpty)
        #expect(apps.putDowns == 0)
        #expect(apps.front == .thisApp)
    }

    // MARK: A hidden app shows nothing

    @Test func afterLettingGoOfTheFrontTheNextWindowIsShownWithoutTakingTheFrontAgain() {
        let apps = FakeFrontApps(front: .thisApp)
        let handoff = FrontHandoff(apps: apps)
        handoff.popoverClosed(otherViewIsOpen: false)
        #expect(apps.isHidden, "the way this app lets go of the front place hides it")

        handoff.prepareToShowWindow()
        #expect(!apps.isHidden)
        #expect(apps.unhides == 1)
        #expect(!apps.thisAppIsFront, "showing the popover again does not make this app the front app")
    }

    @Test func showingAWindowOfAnAppThatIsNotHiddenChangesNothing() {
        let apps = FakeFrontApps(front: .other(terminal))
        let handoff = FrontHandoff(apps: apps)
        handoff.prepareToShowWindow()
        #expect(apps.unhides == 0)
        #expect(apps.front == .other(terminal))
        #expect(apps.asked.isEmpty)
    }
}

/// The real system behind the seam, read only: nothing here asks the Mac to change its front app.
@MainActor
struct WorkspaceFrontAppsTests {
    @MainActor private final class Heard { var apps: [FrontApp] = [] }

    /// Some other app a person works in that runs on this Mac (a login session always has Finder).
    private static var someOtherApp: NSRunningApplication? {
        NSWorkspace.shared.runningApplications.first {
            $0.activationPolicy == .regular && !$0.isTerminated && $0.processIdentifier != ProcessInfo.processInfo.processIdentifier
        }
    }

    private static func activation(of app: NSRunningApplication?) -> Notification {
        Notification(
            name: NSWorkspace.didActivateApplicationNotification, object: nil,
            userInfo: app.map { [NSWorkspace.applicationUserInfoKey: $0] })
    }

    @Test func anActivationOfAnotherAppIsTheAppItNamesAndOneOfThisAppIsNone() throws {
        let other = try #require(Self.someOtherApp, "a login session with an app in it")
        #expect(
            WorkspaceFrontApps.frontApp(from: Self.activation(of: other))
                == FrontApp(pid: other.processIdentifier, bundleID: other.bundleIdentifier))
        #expect(WorkspaceFrontApps.frontApp(from: Self.activation(of: .current)) == nil, "this app is not remembered as the app before it")
        #expect(WorkspaceFrontApps.frontApp(from: Self.activation(of: nil)) == nil, "a note without an app")
    }

    @Test func anAppWithoutADockIconIsNotSomewherePersonWorked() throws {
        let helper = try #require(
            NSWorkspace.shared.runningApplications.first {
                $0.activationPolicy != .regular && !$0.isTerminated && $0.processIdentifier != ProcessInfo.processInfo.processIdentifier
            },
            "a login session has helpers without a Dock icon")
        #expect(WorkspaceFrontApps.frontApp(from: Self.activation(of: helper)) == nil)
    }

    @Test func aRunningAppIsFoundAgainByItsProcessAndBundleIdAndNoOtherIsTakenForIt() throws {
        let other = try #require(Self.someOtherApp)
        let app = try #require(WorkspaceFrontApps.frontApp(for: other))
        let live = WorkspaceFrontApps()
        #expect(live.isRunning(app))
        #expect(!live.isRunning(FrontApp(pid: app.pid, bundleID: "dev.example.somebody-else")), "the process id was given to another app")
        #expect(!live.isRunning(FrontApp(pid: 999_999, bundleID: app.bundleID)), "no such process")
    }

    @Test func theWorkspacesActivationNoteReachesTheObserverForAnotherAppOnly() async throws {
        let other = try #require(Self.someOtherApp)
        let center = NotificationCenter()
        let live = WorkspaceFrontApps(center: center)
        let heard = Heard()
        live.observeFrontApps { heard.apps.append($0) }

        center.post(Self.activation(of: .current))
        center.post(Self.activation(of: other))
        for _ in 0..<200 where heard.apps.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        // Let a wrong second note, if any, arrive too.
        try await Task.sleep(for: .milliseconds(50))
        #expect(heard.apps == [FrontApp(pid: other.processIdentifier, bundleID: other.bundleIdentifier)])
    }
}
