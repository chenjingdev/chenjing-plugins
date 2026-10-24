import Foundation
@testable import cua_bar

/// A notification center that never leaves the process: records what it was asked to post and
/// who asked for permission. `allowed: false` is a person who said no.
final class FakeNotifier: Notifier, @unchecked Sendable {
    private let lock = NSLock()
    private var allowed: Bool
    /// Set while nobody has answered: what asking turns the setting into. `.notDecided` is a
    /// question the system does not show, as while the screen is locked.
    private var answer: NotificationPermission?
    private var recordedDelivered: [AppNotification] = []
    private var recordedAttempts = 0
    private var recordedAuthorizationRequests = 0
    private var handler: (@MainActor @Sendable (NotificationResponse) -> Void)?

    init(allowed: Bool = true) { self.allowed = allowed }

    var delivered: [AppNotification] { lock.withLock { recordedDelivered } }
    /// Every `post`, delivered or not.
    var attempts: Int { lock.withLock { recordedAttempts } }
    var authorizationRequests: Int { lock.withLock { recordedAuthorizationRequests } }

    func setAllowed(_ value: Bool) { lock.withLock { allowed = value } }

    /// Nobody has answered yet; the next question turns the setting into `answer`.
    func setUndecided(answer: NotificationPermission) { lock.withLock { self.answer = answer } }

    func requestAuthorization() async -> Bool {
        lock.withLock {
            recordedAuthorizationRequests += 1
            if let answer, answer != .notDecided {
                allowed = answer == .allowed
                self.answer = nil
            }
            return answer == nil && allowed
        }
    }

    func permission() async -> NotificationPermission {
        lock.withLock { answer != nil ? .notDecided : allowed ? .allowed : .off }
    }

    func post(_ notification: AppNotification) async -> Bool {
        lock.withLock {
            recordedAttempts += 1
            guard answer == nil, allowed else { return false }
            recordedDelivered.append(notification)
            return true
        }
    }

    func setResponseHandler(_ handler: @escaping @MainActor @Sendable (NotificationResponse) -> Void) {
        lock.withLock { self.handler = handler }
    }

    /// The person clicked something in a notification.
    @MainActor func tap(_ response: NotificationResponse) {
        let handler = lock.withLock { self.handler }
        handler?(response)
    }
}

/// "Opens" Codex by writing down the path it was asked to open; nothing is launched.
final class FakeAppOpener: AppOpening, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String?] = []
    private var backgrounds: [Bool] = []
    var succeeds = true

    var openedPaths: [String?] { lock.withLock { recorded } }
    /// Whether each open was asked for in the background.
    var openedInBackground: [Bool] { lock.withLock { backgrounds } }

    func openCodex(appPath: String?, inBackground: Bool) async -> ActionOutcome {
        lock.withLock {
            recorded.append(appPath)
            backgrounds.append(inBackground)
        }
        return succeeds
            ? ActionOutcome(kind: .success, message: "Codex를 열었어요")
            : ActionOutcome(kind: .failure, message: "Codex를 열지 못했어요")
    }
}

/// Lets whatever else is ready to run, run, until `condition` holds. Bounded, so a regression fails
/// the test instead of hanging the suite.
@MainActor
func yieldUntil(_ condition: () -> Bool, limit: Int = 500_000) async -> Bool {
    var spins = 0
    while !condition(), spins < limit {
        await Task.yield()
        spins += 1
    }
    return condition()
}

/// A clock a test moves by hand.
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date

    init(_ start: Date = Fixtures.now) { current = start }

    var now: Date { lock.withLock { current } }

    func advance(_ seconds: TimeInterval) { lock.withLock { current = current.addingTimeInterval(seconds) } }
}

/// A view model wired to fakes only: the fake engine, notifier, opener and pasteboard, a clock and
/// a sleeper the test controls. Nothing here reaches the real engine, notification center or any app.
@MainActor
struct Rig {
    let model: CUABarViewModel
    let engine: FakeEngineClient
    let notifier: FakeNotifier
    let opener: FakeAppOpener
    let pasteboard: RecordingPasteboard
    let clock: TestClock
    let sleeper: ManualSleeper
    /// How many engine calls had been made when the rig went quiet.
    private let baseline: Int

    /// `refresh` reads the status once and waits for what that started (automatic cleanup,
    /// notifications), so a test starts from a quiet model and `actionCalls` shows only what the
    /// test itself caused. Pass `refresh: false` to watch that first read happen.
    init(
        _ status: EngineStatus, engine: FakeEngineClient? = nil, notifier: FakeNotifier = FakeNotifier(),
        clock: TestClock = TestClock(), refresh: Bool = true, claude: ClaudeBox? = nil
    ) async {
        let engine = engine ?? FakeEngineClient(status: status)
        let opener = FakeAppOpener()
        let pasteboard = RecordingPasteboard()
        let sleeper = ManualSleeper()
        var inspector: (@Sendable (String?) -> ClaudeSetupState)?
        if let claude { inspector = { _ in claude.state } }
        let model = CUABarViewModel(
            engine: engine, appVersion: "0.7.0", pasteboard: pasteboard, appOpener: opener, notifier: notifier,
            clock: { clock.now }, calendar: Fixtures.utc, sleep: sleeper.sleep, claudeInspector: inspector)
        if refresh {
            await model.refresh()
            await model.waitForBackgroundWork()
        }
        self.model = model
        self.engine = engine
        self.notifier = notifier
        self.opener = opener
        self.pasteboard = pasteboard
        self.clock = clock
        self.sleeper = sleeper
        baseline = refresh ? engine.calls.count : 0
    }

    /// Every engine call since the rig went quiet, except reading the status, in order.
    var actionCalls: [FakeEngineClient.Call] { engine.calls.dropFirst(baseline).filter { $0 != .status } }
}

/// What Claude Code has of CUA, as a test changes it between reads.
final class ClaudeBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: ClaudeSetupState

    init(_ value: ClaudeSetupState = .none) { self.value = value }

    var state: ClaudeSetupState {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }
}
