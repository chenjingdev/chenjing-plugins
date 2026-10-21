import Combine
import Foundation

/// How often the status is read: every 5 s, every 2 s while the popover is open (and once at
/// the moment it opens), and right after any action.
struct RefreshPolicy: Equatable, Sendable {
    var closed: Duration = .seconds(5)
    var open: Duration = .seconds(2)
}

/// The one-line result of the last action, shown under the status card for a few seconds.
struct ActionBanner: Equatable, Identifiable, Sendable {
    let id = UUID()
    let outcome: ActionOutcome
}

/// What running an action came to: the one-line outcome and the engine's reason code behind it
/// (nil when there is none). The outcome is for the person; the code is for the decisions after it.
struct ActionResult: Equatable, Sendable {
    var outcome: ActionOutcome
    var reason: String?
}

/// Owns everything the menu bar item and the popover show: it reads the engine on a timer,
/// turns the answer into `summary` and `content`, and runs the buttons' actions.
///
/// The engine is only ever awaited, so the main actor stays free while a command runs. A button
/// calls `send(_:)`, which asks first when the action needs a confirmation (one at a time,
/// inline in the popover) and otherwise runs it; `perform(_:)` runs an action with no question.
/// After every read the model also cleans up what nobody can come back to (F5) and posts the two
/// kinds of notification (F1, R16).
@MainActor
final class CUABarViewModel: ObservableObject {
    /// This many failed reads in a row replace the last good answer with a problem; a single
    /// slow answer does not make the icon flicker. Without any good answer a failure shows at once.
    static let failuresBeforeProblem = 2

    /// A release by session id that fails for one of these reasons points at the extension reset (F3 case).
    static let reasonsPointingAtTheExtension: Set<String> = ["unsupported", "cleanup_not_confirmed", "timeout"]

    /// The outcome of an action that has nothing to say.
    static let quiet = ActionOutcome(kind: .info, message: "")

    /// A button that waits for the automatic cleanup says this when the pointer rests on it.
    static let cleanupBusyHelp = "자동 정리 중이에요"
    /// A press that arrives anyway: it does not run, and nothing is queued.
    static let cleanupBusyOutcome = ActionOutcome(kind: .info, message: "자동 정리 중이에요. 끝나면 다시 눌러 주세요")
    /// The notification's 다시 켜기 while the status cannot be read.
    static let restartNeedsStatus = "상태를 읽지 못해 다시 켜지 않았어요. 잠시 뒤 다시 눌러 주세요"
    /// While a restart waits for the Codex it asked to quit (S10): the card's next step, 다시 켜기 on
    /// hover, and what is said when the same Codex outlasts the wait.
    static let quitWaitStep = "Codex가 꺼지기를 기다려요 — 종료를 물으면 '종료'를 눌러 주세요. 꺼지면 다시 켤게요"
    static let quitWaitHelp = "Codex가 꺼지기를 기다리는 중이에요"
    static let quitWaitEnded = "Codex가 10분 안에 꺼지지 않아 다시 켜기를 그만뒀어요"

    @Published private(set) var summary: StatusSummary = StatusEvaluator.loading
    /// nil until the first answer, and again while the engine cannot be read.
    @Published private(set) var content: PopoverContent?
    @Published private(set) var updatedAt: Date?
    @Published var selectedTab: PopoverTab = .connections {
        // A question asked on a line of the list is not shown on 기록: it goes with the tab, as with the popover.
        // An answer on the tab left behind is said in the banner instead.
        didSet {
            guard selectedTab != oldValue else { return }
            if pending?.action.connectionID != nil { cancelPending() }
            moveGonePlacesToTheBanner()
        }
    }
    @Published private(set) var inFlight: Set<CUAAction> = [] {
        didSet { publishSummary() }
    }
    /// The answer to a button of the status card (or to one whose place is gone), under the card.
    @Published private(set) var banner: ActionBanner?
    /// The answer to 탭 풀기, 정리, 모두 정리 or 진단 복사, told next to the button that was pressed for as
    /// long as a banner would stay. When that place is gone (the line left the list), it moves to the banner.
    @Published private(set) var placedResults: [ResultPlace: ActionOutcome] = [:]
    /// Sessions whose release by session id failed in a way the extension reset may fix; the
    /// guidance opens for them.
    @Published private(set) var failedSessionIDs: Set<String> = []
    /// What the last release by session id said, per session, shown on that session's own row.
    @Published private(set) var sessionResults: [String: ActionOutcome] = [:]
    /// Whether the person opened or closed the guidance for tabs that stay blocked; nil leaves it to
    /// the popover (open when a leftover cannot be released one by one). Kept here because this
    /// toolchain has no `@State` (SwiftUIMacros is not in the Command Line Tools).
    @Published var guidanceOpenByUser: Bool?
    /// The question waiting for an answer, if any. Only one at a time.
    @Published private(set) var pending: PendingConfirmation?
    /// Connections whose release the engine refused twice (R15): their row says so and its button,
    /// still 탭 풀기, tries again without asking. A live AI is never stopped from here.
    @Published private(set) var refusedReleaseIDs: Set<String> = []
    /// The automatic cleanup (F5) is running: the buttons that would touch what it releases wait.
    @Published private(set) var isCleaningUp = false
    /// Where this app's notifications stand: read when the app asks at its start and each time the
    /// popover opens, because the person turns them on in System Settings.
    @Published private(set) var notificationPermission: NotificationPermission = .unavailable
    /// The ended connections the automatic cleanup is releasing, while it runs.
    private var cleaningIDs: Set<String> = []
    /// Ended connections the app may only release (not stop) whose tabs it released in this run: the
    /// card and the line then say there is nothing more to do, and only for these (never a guess).
    private var tabsReleasedIDs: Set<String> = []

    /// What Claude Code has of CUA as of the last read: the MCP server, the skill, the old plugin if one is
    /// still recorded. Read from files only; the 점검 tab and the card both show from it.
    @Published private(set) var claudeSetup: ClaudeSetupState = .none

    /// The login environment as read from launchd and the agent file, while the engine calls it a conflict or stale.
    /// Only read then; the 점검 tab says what the conflict is made of from it.
    @Published private(set) var loginEnvironment: LoginEnvironmentReading?
    /// The last connection test of this run: how it ended and when. Never kept across runs.
    @Published private(set) var lastProbe: ProbeRecord?
    /// A connection test is running (from the button or right after an install): none starts beside it.
    @Published private(set) var isProbing = false

    /// The raw answer of the last good read, for what needs more than `content` shows.
    private(set) var lastStatus: EngineStatus?
    /// Why the last read gave no answer, while it gives none (the 점검 tab says what is wrong with the engine).
    private(set) var lastError: EngineError?
    private(set) var isPopoverOpen = false
    /// Set by the menu bar item: shows the popover (a click on a notification).
    var openPopoverHandler: (@MainActor () -> Void)?
    /// Runs in the background after each read, given what the read answered (nil: it failed). The install does
    /// what it put off for lack of Codex, Claude Code or an answer. Set once by the app; it must return at once
    /// when there is nothing to do.
    var afterRead: (@MainActor (EngineStatus?) async -> Void)?
    /// The automatic cleanup that is running, if any. Never two at a time.
    private(set) var automaticCleanupTask: Task<Void, Never>?

    private let engine: any EngineClient
    private let appVersion: String?
    private let systemActions: any SystemActions
    private let pasteboard: any PasteboardWriting
    private let appOpener: any AppOpening
    private let notifier: any Notifier
    private let policy: RefreshPolicy
    private let clock: @Sendable () -> Date
    private let calendar: Calendar
    private let bannerDuration: Duration
    private let sleep: @Sendable (Duration) async throws -> Void
    private let setupActivity: SetupActivity
    private let claudeInspector: (@Sendable (String?) -> ClaudeSetupState)?
    private let codexInstalled: @Sendable () -> Bool
    private let loginItemReading: (@MainActor () -> LoginItemReading?)?
    private let loginEnvironmentReader: (@Sendable () async -> LoginEnvironmentReading)?
    private let appLauncherValue: String

    /// What the evaluator said about the last answer, before setup's own state is put over it.
    private var evaluatedSummary: StatusSummary = StatusEvaluator.loading
    private var consecutiveFailures = 0
    private var refreshTask: Task<Void, Never>?
    private var loopTask: Task<Void, Never>?
    private var sleeper: CheckedContinuation<Void, Never>?
    private var sleepTimer: Task<Void, Never>?
    private var wakeRequested = false
    private var loopGeneration = 0
    private var bannerTimer: Task<Void, Never>?
    private var placedTimers: [ResultPlace: Task<Void, Never>] = [:]
    private var releaseRefusals: [String: Int] = [:]
    private var cleanupPlanner = CleanupPlanner()
    private var notificationPlanner = NotificationPlanner()
    /// Work the model started on its own; each removes itself when it is done.
    private var backgroundTasks: [UUID: Task<Void, Never>] = [:]
    private var didRequestAuthorization = false

    /// A restart whose quit Codex took but had not finished when the engine stopped waiting
    /// (`quit_pending`): which Codex it was, and until when the app waits for it to end.
    private struct PendingRelaunch {
        var pids: Set<Int>
        var appPath: String?
        var until: Date
        /// The first read without that Codex; it is opened on a later one, when its host has closed too.
        var goneSince: Date?
    }
    private var pendingRelaunch: PendingRelaunch? {
        // The card says it waits for exactly as long as it does.
        didSet { if (oldValue == nil) != (pendingRelaunch == nil) { publishSummary() } }
    }
    static let relaunchWait: TimeInterval = 10 * 60
    static let relaunchAfterGone: TimeInterval = 3

    init(
        engine: any EngineClient,
        appVersion: String?,
        systemActions: any SystemActions = UnwiredSystemActions(),
        pasteboard: any PasteboardWriting = SystemPasteboard(),
        appOpener: any AppOpening = WorkspaceAppOpener(),
        notifier: any Notifier = SystemNotifier.makeDefault(),
        policy: RefreshPolicy = RefreshPolicy(),
        clock: @escaping @Sendable () -> Date = { Date() },
        calendar: Calendar = .current,
        bannerDuration: Duration = .seconds(6),
        // Waiting is injected so tests can pass time without waiting for it.
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        // What the card says while the install runs.
        setupActivity: SetupActivity = SetupActivity(),
        // What Claude Code has of CUA, read from its files on every read of the status (given the launcher the
        // engine reported, which the MCP command is compared with). nil: not looked at, nothing is said about it.
        claudeInspector: (@Sendable (String?) -> ClaudeSetupState)? = nil,
        // Whether the Codex app is on this Mac, by the app's own look: only asked when the engine cannot
        // answer, because the install does nothing without Codex and the card must not offer it then.
        codexInstalled: @escaping @Sendable () -> Bool = { true },
        // What became of the app's own login item, for the 점검 tab and the copied diagnosis.
        loginItemReading: (@MainActor () -> LoginItemReading?)? = nil,
        // Reads launchd's `CODEX_CLI_PATH` and the agent file; asked only while the login environment is a conflict or stale.
        loginEnvironmentReader: (@Sendable () async -> LoginEnvironmentReading)? = nil,
        // The value the app's setup puts into `CODEX_CLI_PATH`; another value in launchd is somebody else's.
        appLauncherValue: String = ""
    ) {
        self.engine = engine
        self.appVersion = appVersion
        self.systemActions = systemActions
        self.pasteboard = pasteboard
        self.appOpener = appOpener
        self.notifier = notifier
        self.policy = policy
        self.clock = clock
        self.calendar = calendar
        self.bannerDuration = bannerDuration
        self.sleep = sleep
        self.setupActivity = setupActivity
        self.claudeInspector = claudeInspector
        self.codexInstalled = codexInstalled
        self.loginItemReading = loginItemReading
        self.loginEnvironmentReader = loginEnvironmentReader
        self.appLauncherValue = appLauncherValue
        setupActivity.onChange = { [weak self] in self?.publishSummary() }
        notifier.setResponseHandler { [weak self] response in self?.handle(response) }
    }

    var currentInterval: Duration { isPopoverOpen ? policy.open : policy.closed }

    /// The footer line: when the status was last read.
    var updatedText: String {
        updatedAt.map { "갱신 \(Format.clock($0, calendar: calendar))" } ?? "읽는 중…"
    }

    /// What the 기록 tab shows. Without a status it still has 진단 복사, because that is when it is needed.
    var activityContent: ActivityContent {
        content?.activity ?? ActivityContent.placeholder(isLoading: summary.isPlaceholder)
    }

    // MARK: Summary

    private func publish(_ evaluated: StatusSummary) {
        evaluatedSummary = evaluated
        // A failed setup is only remembered while the card still shows a setup problem.
        if evaluated.problem?.kind != .setupIncomplete { setupActivity.forgetFailure() }
        publishSummary()
    }

    /// `summary` is the evaluator's card with setup's state over it: while a setup runs, or an
    /// install or update that ends in one, the card says so instead of showing a problem. While a
    /// restart waits for Codex to finish quitting, the next step says so: the banner is gone in
    /// seconds, and Codex may be asking whether to quit (S10).
    private func publishSummary() {
        var next = SetupOverlay.apply(
            to: evaluatedSummary, setup: setupActivity.phase, flowRunning: inFlight.contains(where: SetupOverlay.runsSetup))
        if pendingRelaunch != nil { next.nextStep = Self.quitWaitStep }
        if next != summary { summary = next }
    }

    // MARK: 점검

    /// The 점검 tab: judged from what the model already read (the engine's status, Claude Code's files, the login
    /// item), so opening it runs nothing.
    var checkContent: CheckContent {
        CheckContent(CheckInput(
            status: lastStatus, error: lastError, appVersion: appVersion, claude: claudeSetup,
            developerToolsNeeded: setupActivity.developerToolsNeeded, card: evaluatedSummary.problem,
            loginItem: loginItemReading?(), login: loginEnvironment, fixTried: setupActivity.finishedRuns > 0,
            probe: lastProbe, probing: isProbing, now: clock(), calendar: calendar, appLauncherValue: appLauncherValue))
    }

    /// The connection test waits this long for the host; the app gives the command ten seconds more.
    static let probeSeconds = 15
    /// What a press on 연결 시험 says when there is no Codex host to test.
    static let probeNeedsHost = "Codex가 꺼져 있어 시험하지 않았어요 — Claude 대화를 열면 켜져요"
    static let probeBusy = "이미 시험하는 중이에요"

    /// One connection test, only against a host that is ready. Nothing is started for it: a Codex that is off, or
    /// still starting, is not tested (nil). A test already running is not joined or repeated (nil). `hostState` is the
    /// state the caller just looked at.
    private func runProbe(hostState: HostState?) async -> ProbeOutcome? {
        guard hostState == .ready, !isProbing else { return nil }
        isProbing = true
        defer { isProbing = false }
        let outcome: ProbeOutcome
        do {
            outcome = try await engine.probe(seconds: Self.probeSeconds)
        } catch EngineError.timeout {
            outcome = .timeout
        } catch {
            outcome = .couldNotRun
        }
        lastProbe = ProbeRecord(outcome: outcome, at: clock())
        return outcome
    }

    /// After an install that changed something: one connection test, when the host is ready. The status is asked again
    /// first, because the install may have changed it. What the install says comes after this (`ProbeMessages`). nil: no test
    /// was run.
    func probeAfterInstall() async -> ProbeOutcome? {
        guard !isProbing, let status = try? await engine.status() else { return nil }
        return await runProbe(hostState: status.host.state)
    }

    /// The button's answer, in one line.
    private func probeAnswer(_ outcome: ProbeOutcome?) -> ActionOutcome {
        guard let outcome else {
            return ActionOutcome(kind: .info, message: isProbing ? Self.probeBusy : Self.probeNeedsHost)
        }
        switch outcome {
        case .checked: return ActionOutcome(kind: .success, message: outcome.summary)
        case .hostUnavailable: return ActionOutcome(kind: .info, message: outcome.summary)
        case .approvalRequired, .cleanupUnconfirmed: return ActionOutcome(kind: .warning, message: outcome.summary)
        default: return ActionOutcome(kind: .failure, message: outcome.summary)
        }
    }

    // MARK: Refresh loop

    func start() {
        requestNotificationAuthorizationOnce()
        guard loopTask == nil else { return }
        wakeRequested = false
        loopGeneration += 1
        let generation = loopGeneration
        loopTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.loopGeneration == generation else { return }
                await self.refresh()
                await self.sleepUntilNextRefresh(generation: generation)
            }
        }
    }

    func stop() {
        loopTask?.cancel()
        loopTask = nil
        loopGeneration += 1
        wakeRequested = false
        resumeSleeper()
    }

    func setPopoverOpen(_ open: Bool) {
        guard isPopoverOpen != open else { return }
        isPopoverOpen = open
        if open {
            // The card sends the person to the top of the list, so the popover opens on it.
            selectedTab = .connections
            wake()
            readNotificationPermission()
        } else {
            // A question belongs to the moment it was asked: closing the popover withdraws it.
            cancelPending()
        }
    }

    /// Reads the engine now. A read already in flight is joined instead of started twice.
    func refresh() async {
        if let running = refreshTask {
            await running.value
            return
        }
        // The task clears `refreshTask` itself, before anyone waiting on it resumes, so a caller
        // that comes right after it finished starts a new read instead of joining a finished one.
        let task = Task {
            await self.fetch()
            self.refreshTask = nil
        }
        refreshTask = task
        await task.value
    }

    /// For after an action: waits for a read that started earlier (it may predate the action)
    /// and then reads once more.
    private func refreshAfterInFlight() async {
        if let running = refreshTask { await running.value }
        await refresh()
    }

    private func fetch() async {
        var answered: EngineStatus?
        do {
            let status = try await engine.status()
            consecutiveFailures = 0
            let claude = await readClaude(launcher: status.engine.launcher)
            accept(status, claude: claude, login: await readLoginEnvironment(for: status))
            answered = status
        } catch is CancellationError {
            return
        } catch let error as EngineError {
            claudeSetup = await readClaude(launcher: nil)
            reject(error)
        } catch {
            claudeSetup = await readClaude(launcher: nil)
            reject(.commandFailed(exitCode: -1, message: ""))
        }
        if let afterRead { runInBackground { await afterRead(answered) } }
    }

    /// Claude Code's files are read off the main actor: `~/.claude.json` can be large. A `claude` the last install
    /// could not start is said with it.
    private func readClaude(launcher: String?) async -> ClaudeSetupState {
        guard let inspector = claudeInspector else { return .none }
        var state = await Task.detached(priority: .utility) { inspector(launcher) }.value
        state.claudeCodeUnusable = state.claudeCodeFound && setupActivity.claudeCodeUnusable
        return state
    }

    /// Asked only while the engine calls the login environment a conflict or stale: it runs `launchctl getenv`, and
    /// the tab needs the answer only then. Read off the main actor.
    private func readLoginEnvironment(for status: EngineStatus) async -> LoginEnvironmentReading? {
        guard let reader = loginEnvironmentReader, ["conflict", "stale"].contains(status.setup.loginEnvironment) else { return nil }
        return await Task.detached(priority: .utility) { await reader() }.value
    }

    private func accept(_ status: EngineStatus, claude: ClaudeSetupState, login: LoginEnvironmentReading? = nil) {
        let now = clock()
        lastStatus = status
        lastError = nil
        loginEnvironment = login
        claudeSetup = claude
        publish(StatusEvaluator.evaluate(
            status, appVersion: appVersion, tabsReleased: tabsReleasedIDs,
            facts: LocalFacts(claude: claude, developerToolsNeeded: setupActivity.developerToolsNeeded)))
        content = PopoverContent(status: status, now: now, calendar: calendar, tabsReleased: tabsReleasedIDs)
        updatedAt = now
        forgetWhatIsGone(in: status)
        moveGonePlacesToTheBanner()
        revalidatePending()
        // Cleanup first: the notifications look at what it has tried.
        startAutomaticCleanupIfNeeded()
        postDueNotifications(now: now)
        relaunchIfQuit(status, now: now)
    }

    /// Opens Codex again, in the background, once the Codex a restart asked to quit is gone (S10).
    /// It is the end of the person's restart, so R1 holds. A Codex someone opened meanwhile, or the
    /// same one still there after the wait, ends it without opening anything.
    private func relaunchIfQuit(_ status: EngineStatus, now: Date) {
        guard var relaunch = pendingRelaunch else { return }
        if now >= relaunch.until || (status.codex.running && Set(status.codex.pids) != relaunch.pids) {
            pendingRelaunch = nil
            // Without a word the card would just stop waiting.
            if status.codex.running, Set(status.codex.pids) == relaunch.pids {
                show(ActionOutcome(kind: .info, message: Self.quitWaitEnded))
            }
            return
        }
        guard !status.codex.running else { return }
        guard let gone = relaunch.goneSince else {
            relaunch.goneSince = now
            pendingRelaunch = relaunch
            return
        }
        guard now.timeIntervalSince(gone) >= Self.relaunchAfterGone, status.host.state != .ready else { return }
        pendingRelaunch = nil
        let appPath = relaunch.appPath ?? status.codex.appPath
        runInBackground { [weak self] in
            guard let self else { return }
            let opened = await self.appOpener.openCodex(appPath: appPath, inBackground: true)
            self.show(opened.kind == .success
                ? ActionOutcome(kind: .success, message: ActionMessages.restarted) : ActionMessages.relaunchFailed)
            await self.refreshAfterInFlight()
        }
    }

    private func reject(_ error: EngineError) {
        switch error {
        case .engineMissing, .setupNeeded, .unsupportedSchema:
            // Not a hiccup: the answer will not change by asking again.
            consecutiveFailures = 0
        default:
            consecutiveFailures += 1
            if lastStatus != nil, consecutiveFailures < Self.failuresBeforeProblem { return }
        }
        lastStatus = nil
        lastError = error
        loginEnvironment = nil
        publish(StatusEvaluator.summary(
            for: error,
            facts: LocalFacts(
                claude: claudeSetup, developerToolsNeeded: setupActivity.developerToolsNeeded,
                codexMissing: error.needsEngineInstall && !codexInstalled())))
        content = nil
        updatedAt = clock()
        failedSessionIDs = []
        sessionResults = [:]
        refusedReleaseIDs = []
        releaseRefusals = [:]
        moveGonePlacesToTheBanner()
        revalidatePending()
    }

    /// State kept for a connection or a session goes with it.
    private func forgetWhatIsGone(in status: EngineStatus) {
        let connections = Set(status.connections.map(\.id))
        releaseRefusals = releaseRefusals.filter { connections.contains($0.key) }
        refusedReleaseIDs.formIntersection(connections)
        tabsReleasedIDs.formIntersection(connections)
        let sessions = Set(status.leases.items.compactMap(\.sessionID) + status.leases.maybeLeft.compactMap(\.sessionID))
        failedSessionIDs.formIntersection(sessions)
        sessionResults = sessionResults.filter { sessions.contains($0.key) }
    }

    private func sleepUntilNextRefresh(generation: Int) async {
        // A loop that was stopped (and maybe replaced) must not touch the shared wait state.
        guard generation == loopGeneration, !Task.isCancelled else { return }
        if wakeRequested {
            wakeRequested = false
            return
        }
        let interval = currentInterval
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                sleeper = continuation
                sleepTimer = Task { [weak self, sleep] in
                    do { try await sleep(interval) } catch { return }
                    self?.resumeSleeper()
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.resumeSleeper() }
        }
    }

    /// Ends the wait before the next read; if the loop is busy reading, the next wait is skipped.
    private func wake() {
        if sleeper != nil { resumeSleeper() } else { wakeRequested = true }
    }

    private func resumeSleeper() {
        sleepTimer?.cancel()
        sleepTimer = nil
        let continuation = sleeper
        sleeper = nil
        continuation?.resume()
    }

    // MARK: Confirmations (R15, R17, F1)

    /// What a pending question says; derived from the latest status so its count stays true.
    var confirmationPrompt: ConfirmationPrompt? {
        guard let pending else { return nil }
        switch pending.kind {
        case .retryRelease: return Confirmations.retryPrompt
        case .standard: return Confirmations.prompt(for: pending.action, content: content)
        }
    }

    /// The question under the status card: only one that comes from a button of the card (다시 켜기).
    /// A question about a line of the list is asked on that line (`confirmationPrompt(forConnection:)`).
    var cardConfirmationPrompt: ConfirmationPrompt? {
        pending?.action.connectionID == nil ? confirmationPrompt : nil
    }

    /// The question asked on this connection's line, right under it; nil when it is about another.
    func confirmationPrompt(forConnection id: String) -> ConfirmationPrompt? {
        pending?.action.connectionID == id ? confirmationPrompt : nil
    }

    /// The question an action asks before it runs, or nil when the click is its own consent (or
    /// when it cannot run now: see `send`).
    func confirmation(for action: CUAAction) -> PendingConfirmation? {
        guard case .ask = Confirmations.gate(for: action, content: content) else { return nil }
        return PendingConfirmation(action: action, kind: .standard)
    }

    /// What a button calls: asks first when the action needs it, otherwise runs it. A new press
    /// replaces a question that is still waiting. An action that has to ask but cannot (no status
    /// to count from, its target gone) and one that would run beside the automatic cleanup do not
    /// run; a banner says why. Returns what it started (nil when it asked or did not run).
    @discardableResult
    func send(_ action: CUAAction) -> Task<Void, Never>? {
        pending = nil
        if waitsForAutomaticCleanup(action) {
            tell(Self.cleanupBusyOutcome, about: action)
            return nil
        }
        switch Confirmations.gate(for: action, content: content) {
        case .ask:
            pending = PendingConfirmation(action: action, kind: .standard)
            return nil
        case .refuse(let reason):
            tell(ActionOutcome(kind: .info, message: reason), about: action)
            return nil
        case .run:
            return Task { _ = await perform(action) }
        }
    }

    /// The person said yes: run what was asked, unless the question went stale meanwhile (then it
    /// is withdrawn, never answered).
    @discardableResult
    func confirmPending() async -> ActionOutcome? {
        guard let question = pending else { return nil }
        pending = nil
        if isStale(question) {
            forgetRefusal(of: question)
            return nil
        }
        return await perform(question.action)
    }

    /// For the button.
    @discardableResult
    func confirm() -> Task<ActionOutcome?, Never> {
        Task { await confirmPending() }
    }

    /// The person said no (or the popover closed): nothing runs.
    func cancelPending() {
        guard let question = pending else { return }
        pending = nil
        forgetRefusal(of: question)
    }

    /// Starting over after a withdrawn retry question is a new first try.
    private func forgetRefusal(of question: PendingConfirmation) {
        if question.kind == .retryRelease, case .retryRelease(let id) = question.action { releaseRefusals[id] = nil }
    }

    /// A question about something that is gone, or that no longer needs one, is withdrawn.
    private func revalidatePending() {
        guard let question = pending, isStale(question) else { return }
        pending = nil
        forgetRefusal(of: question)
    }

    /// Stale: the status cannot be read, the question's target left it, or the action would no
    /// longer ask (its count fell to zero, the connection ended, Codex has its host again).
    private func isStale(_ question: PendingConfirmation) -> Bool {
        guard let content, let status = lastStatus else { return true }
        switch question.action {
        case .retryRelease(let id):
            // Asked again under a live line only: one that ended meanwhile has its own 정리.
            return !content.connections.groups.contains { $0.rows.contains { $0.id == id } }
        case .restartCodex:
            // The restart is the fix for Codex running without its host; with that over it would only cut work off.
            return !codexRunsWithoutHost(in: status)
        default:
            return Confirmations.prompt(for: question.action, content: content) == nil
        }
    }

    private func codexRunsWithoutHost(in status: EngineStatus) -> Bool {
        StatusEvaluator.problem(in: status, appVersion: appVersion)?.kind == .codexWithoutHost
    }

    // MARK: Actions

    /// True while something that touches this connection's line is running: an action on it, 모두 정리
    /// when it is an ended one, a restart or a setup, or the automatic cleanup when it is one of the
    /// ended connections being released. A line the last status does not have (a cmux-cua connection
    /// nobody owns) waits for anything wide.
    func isWaiting(onConnection id: String) -> Bool {
        if isCleaningUp && cleaningIDs.contains(id) { return true }
        guard let connection = lastStatus?.connection(withID: id) else {
            return inFlight.contains { $0.connectionID == id || $0.isWide }
        }
        return inFlight.contains { $0.touches(connection) }
    }

    /// 모두 정리 waits for itself, for a restart or a setup, and for the automatic cleanup. A single
    /// 정리 or 탭 풀기 on one line does not hold it back: only that line waits.
    var tidyAllIsWaiting: Bool {
        inFlight.contains { $0.isWide } || waitsForAutomaticCleanup(.tidyAll)
    }

    /// The same for a lease line: its own 탭 풀기, 모두 정리 when it is one of the sessions that
    /// releases, a restart or a setup, or the automatic cleanup when it is a Claude session.
    func isWaiting(onSession id: String) -> Bool {
        let tidiedByAll = TidyPlan.items(in: lastStatus, tabsReleased: tabsReleasedIDs).contains(.session(id))
        let running = inFlight.contains { action in
            switch action {
            case .releaseSession(let session, _): session == id
            case .tidyAll: tidiedByAll
            case .restartCodex, .runSetup: true
            default: false
            }
        }
        return running || waitsForAutomaticCleanup(.releaseSession(id, user: true))
    }

    /// What a row's buttons say on hover while the automatic cleanup releases its connection.
    func cleanupHelp(onConnection id: String) -> String? {
        isCleaningUp && cleaningIDs.contains(id) ? Self.cleanupBusyHelp : nil
    }

    /// Runs one button's action with no question, shows its result, and reads the status again at once.
    @discardableResult
    func perform(_ action: CUAAction) async -> ActionOutcome {
        switch action {
        case .refresh:
            await refreshAfterInFlight()
            return Self.quiet
        default:
            break
        }
        // Never beside the automatic cleanup on what it is releasing. Not queued: the person presses again.
        if waitsForAutomaticCleanup(action) {
            tell(Self.cleanupBusyOutcome, about: action)
            return Self.cleanupBusyOutcome
        }
        // Never two of the same at a time.
        guard !inFlight.contains(action) else {
            return ActionOutcome(kind: .info, message: "이미 하는 중이에요")
        }
        inFlight.insert(action)
        defer { inFlight.remove(action) }
        let result = await execute(action)
        let (outcome, tellsIt) = settle(action, result)
        if tellsIt { tell(outcome, about: action) }
        await refreshAfterInFlight()
        return outcome
    }

    /// R15: a release the engine refuses because a tool call has not finished is asked about once
    /// more; refused again, the row says so and its 탭 풀기 stays (a live AI is not stopped).
    private func settle(_ action: CUAAction, _ result: ActionResult) -> (outcome: ActionOutcome, tellsIt: Bool) {
        switch action {
        case .releaseConnection(let id), .retryRelease(let id):
            guard result.reason == "request_in_flight", result.outcome.kind == .failure else {
                releaseRefusals[id] = nil
                refusedReleaseIDs.remove(id)
                return (result.outcome, true)
            }
            releaseRefusals[id, default: 0] += 1
            // A question in a closed popover would only be stale by the time it opens: the row
            // state says it instead.
            if case .releaseConnection = action, isPopoverOpen {
                // The question is the message; no banner on top of it.
                pending = PendingConfirmation(action: .retryRelease(id), kind: .retryRelease)
                return (result.outcome, false)
            }
            // The line says it by itself from now on (`ConnectionRow.refusedNote`), so it is not told twice.
            refusedReleaseIDs.insert(id)
            return (ActionOutcome(kind: .failure, message: ConnectionRow.refusedNote), false)
        default:
            return (result.outcome, true)
        }
    }

    private func execute(_ action: CUAAction) async -> ActionResult {
        do {
            switch action {
            case .releaseConnection(let id), .retryRelease(let id):
                let result = try await engine.releaseConnection(id: id)
                return ActionResult(outcome: ActionMessages.releaseConnection(result), reason: result.reason)
            case .releaseSession(let id, let user):
                let result = try await engine.releaseSession(id: id, user: user)
                let outcome = ActionMessages.releaseSession(result)
                recordSession(id, outcome: outcome, reason: result.reason, released: result.ok && result.released)
                return ActionResult(outcome: outcome, reason: result.reason)
            case .tidy(let id):
                return try await tidyConnection(id)
            case .tidyAll:
                return try await tidyEverything()
            case .restartCodex:
                let codex = lastStatus?.codex
                let result = try await engine.restartCodex()
                if result.reason == "quit_pending", let codex {
                    pendingRelaunch = PendingRelaunch(
                        pids: Set(codex.pids), appPath: codex.appPath, until: clock().addingTimeInterval(Self.relaunchWait))
                }
                return ActionResult(outcome: ActionMessages.restartCodex(result), reason: result.reason)
            case .copyDiagnosis:
                let text = try await engine.diagnose()
                notificationPermission = await notifier.permission()
                let separator = text.isEmpty || text.hasSuffix("\n") ? "" : "\n"
                let check = checkContent.diagnosisLines.joined(separator: "\n")
                pasteboard.copy(text + separator + check + "\n" + notificationPermission.diagnosisLine + "\n")
                return ActionResult(outcome: ActionOutcome(kind: .success, message: "진단을 복사했어요"), reason: nil)
            case .runSetup:
                // Through the shared setup slot (inside the action): one install at a time, said on the card while it runs.
                return ActionResult(outcome: await systemActions.setUp(), reason: nil)
            case .installDeveloperTools:
                return ActionResult(outcome: await systemActions.installDeveloperTools(), reason: nil)
            case .openCodex:
                return ActionResult(outcome: await appOpener.openCodex(appPath: lastStatus?.codex.appPath), reason: nil)
            case .openCodexDownload:
                return ActionResult(outcome: await systemActions.openCodexDownload(), reason: nil)
            case .runProbe:
                if isProbing { return ActionResult(outcome: ActionOutcome(kind: .info, message: Self.probeBusy), reason: nil) }
                let outcome = await runProbe(hostState: lastStatus?.host.state)
                return ActionResult(outcome: probeAnswer(outcome), reason: nil)
            case .copyCommand(let command, _):
                pasteboard.copy(command)
                return ActionResult(outcome: ActionOutcome(kind: .success, message: "명령을 복사했어요"), reason: nil)
            case .refresh:
                return ActionResult(outcome: Self.quiet, reason: nil)
            }
        } catch let error as EngineError {
            let outcome = ActionMessages.failure(of: Self.failureLead(for: action), error: error)
            if case .releaseSession(let id, _) = action {
                recordSession(id, outcome: outcome, reason: error.reasonCode, released: false)
            }
            return ActionResult(outcome: outcome, reason: error.reasonCode)
        } catch {
            // Nothing the system says about the failure is shown: one fixed line.
            let outcome = ActionOutcome(kind: .failure, message: "\(Self.failureLead(for: action)) — \(ActionMessages.unknownReason)")
            return ActionResult(outcome: outcome, reason: nil)
        }
    }

    /// 정리: one ended connection, or one cmux-cua connection nobody owns. It asks nothing, because no
    /// live AI is cut off. A stop that ran out of time (the engine's `timeout`, or the app's own time
    /// limit on the command) is repeated at once with `--force`. An ended connection the app may not
    /// stop has its tabs released and nothing more.
    private func tidyConnection(_ id: String) async throws -> ActionResult {
        guard let way = tidyWay(for: id) else {
            // Gone from the status, or neither released nor stopped by the app: nothing to run.
            let listed = lastStatus?.connection(withID: id) != nil
                || lastStatus?.otherTools.flatMap(\.clients).contains { $0.id == id } == true
            let outcome = ActionOutcome(kind: .info, message: listed ? ActionMessages.cannotTidy : Confirmations.targetGone)
            return ActionResult(outcome: outcome, reason: nil)
        }
        let step = try await tidy(id, way)
        return ActionResult(outcome: ActionMessages.tidy(step), reason: step.reason)
    }

    private func tidyWay(for id: String) -> TidyPlan.Way? {
        if let connection = lastStatus?.connection(withID: id) { return TidyPlan.way(for: connection) }
        let client = lastStatus?.otherTools.flatMap(\.clients).first { $0.id == id }
        return client.flatMap(TidyPlan.way(for:))
    }

    private func tidy(_ id: String, _ way: TidyPlan.Way) async throws -> TidyStep {
        switch way {
        case .releaseOnly:
            let step = TidyStep(release: try await engine.releaseConnection(id: id))
            // Only what the engine confirmed: the card says "탭은 풀었어요" for these and for nothing it does not know.
            if step.kind == .tabsOnly { tabsReleasedIDs.insert(id) }
            return step
        case .stop:
            var result: StopResult
            do {
                result = try await engine.stopConnection(id: id, force: false)
            } catch EngineError.timeout {
                result = StopResult(ok: false, stopped: false, released: false, reason: "timeout")
            }
            let timedOut = !result.stopped && result.reason == "timeout"
            if timedOut { result = try await engine.stopConnection(id: id, force: true) }
            return TidyStep(stop: result, forced: timedOut, releasesTabs: !ToolClient.isCmuxConnection(id: id))
        }
    }

    /// 모두 정리: what `TidyPlan.items` lists, one after another, each with its own result: the ended
    /// connections as 정리 does them, the leftover sessions of Claude conversations by
    /// `release-session` without `--user`, and the cmux-cua connections nobody owns. A Codex chat's
    /// lease is not here: its own row releases it. One that fails does not keep the rest from being tried.
    private func tidyEverything() async throws -> ActionResult {
        var steps: [TidyStep] = []
        var asksForTheExtension = false
        for item in TidyPlan.items(in: lastStatus, tabsReleased: tabsReleasedIDs) {
            // A line whose own 정리 or 탭 풀기 is running is not asked the same again.
            if isRunningOnItsOwn(item) { continue }
            do {
                switch item {
                case .connection(let id, let way):
                    steps.append(try await tidy(id, way))
                case .session(let id):
                    let result = try await engine.releaseSession(id: id, user: false)
                    steps.append(TidyStep(session: result))
                    recordSession(
                        id, outcome: ActionMessages.releaseSession(result), reason: result.reason, released: result.ok && result.released)
                    if let reason = result.reason, !(result.ok && result.released), Self.reasonsPointingAtTheExtension.contains(reason) {
                        asksForTheExtension = true
                    }
                }
            } catch let error as EngineError {
                switch error {
                case .engineMissing, .setupNeeded, .unsupportedSchema: throw error
                default:
                    steps.append(.failed(error.reasonCode))
                    if case .session(let id) = item {
                        recordSession(
                            id, outcome: ActionMessages.failure(of: Self.failureLead(for: .releaseSession(id, user: false)), error: error),
                            reason: error.reasonCode, released: false)
                        asksForTheExtension = asksForTheExtension || error.reasonCode.map(Self.reasonsPointingAtTheExtension.contains) == true
                    }
                }
            }
        }
        // The guidance is what the person needs next, so it must be on screen.
        if asksForTheExtension { showGuidance() }
        return ActionResult(outcome: ActionMessages.tidyAll(steps), reason: steps.first { !$0.isDone }?.reason)
    }

    /// Whether the line of this item has its own button's action in flight (it started before 모두 정리
    /// reached it, or while it was busy with the lines before).
    private func isRunningOnItsOwn(_ item: TidyPlan.Item) -> Bool {
        inFlight.contains { action in
            switch (action, item) {
            case (.tidy(let id), .connection(let target, _)): id == target
            case (.releaseSession(let id, _), .session(let target)): id == target
            default: false
            }
        }
    }

    /// What a release by session id said, kept for that session's row; a failure that points at the
    /// extension reset opens the guidance for it, again if the person had closed it.
    private func recordSession(_ id: String, outcome: ActionOutcome, reason: String?, released: Bool) {
        sessionResults[id] = outcome
        if released {
            failedSessionIDs.remove(id)
        } else if let reason, Self.reasonsPointingAtTheExtension.contains(reason) {
            if failedSessionIDs.insert(id).inserted { guidanceOpenByUser = nil }
        } else {
            failedSessionIDs.remove(id)
        }
    }

    /// The guidance at the bottom of the list, open.
    private func showGuidance() {
        selectedTab = .connections
        guidanceOpenByUser = true
    }

    private static func failureLead(for action: CUAAction) -> String {
        switch action {
        case .releaseConnection, .retryRelease, .releaseSession: "탭을 풀지 못했어요"
        case .tidy, .tidyAll: "정리하지 못했어요"
        case .restartCodex: "Codex를 다시 켜지 못했어요"
        case .copyDiagnosis: "진단을 복사하지 못했어요"
        case .runSetup: "설정하지 못했어요"
        case .openCodex: "Codex를 열지 못했어요"
        case .runProbe: "연결 시험을 하지 못했어요"
        case .copyCommand: "복사하지 못했어요"
        case .openCodexDownload, .installDeveloperTools, .refresh: "하지 못했어요"
        }
    }

    // MARK: Automatic cleanup (F5)

    /// After a read: when the status shows an ended connection the engine can release, or a Claude
    /// session it can aim at, and that was not tried yet, run `release --ended` once. It never
    /// passes `--user`, never stops or signals anything, shows nothing (the next status says what
    /// happened), and tries each connection or session once per app run.
    private func startAutomaticCleanupIfNeeded() {
        guard automaticCleanupTask == nil, inFlight.isEmpty, let status = lastStatus else { return }
        let keys = cleanupPlanner.untried(in: status)
        guard !keys.isEmpty else { return }
        cleanupPlanner.markTried(keys)
        // Its time limit grows with what this status says it has to get through.
        let load = ReleaseEndedLoad(status: status)
        let endedIDs = status.connections.filter { CleanupPlanner.isCandidate($0) }.map(\.id)
        cleaningIDs = Set(endedIDs)
        isCleaningUp = true
        automaticCleanupTask = Task { [weak self] in
            guard let self else { return }
            _ = try? await self.engine.releaseEnded(load)
            self.automaticCleanupTask = nil
            self.cleaningIDs = []
            self.isCleaningUp = false
            await self.refresh()
        }
    }

    /// True while the automatic cleanup runs and this action would touch what it is releasing:
    /// 모두 정리, a row's 정리 or 탭 풀기 of one connection the cleanup releases, and a Claude
    /// session's 탭 풀기. Restart, setup and the rest release nothing the cleanup does and do not wait.
    func waitsForAutomaticCleanup(_ action: CUAAction) -> Bool {
        guard isCleaningUp else { return false }
        switch action {
        case .tidyAll: return true
        case .releaseConnection(let id), .retryRelease(let id), .tidy(let id): return cleaningIDs.contains(id)
        case .releaseSession(let id, _): return isClaudeSession(id)
        default: return false
        }
    }

    /// The status card's fix waits: for its own run, or (다시 켜기) for the Codex the last restart
    /// asked to quit. The card has a fix only for a problem of the whole app, which the automatic
    /// cleanup never touches.
    var fixIsBusy: Bool {
        guard let fix = summary.fix else { return false }
        return inFlight.contains(fix) || waitsForQuit(fix)
    }

    /// Nothing is in the way of the app replacing itself with a newer version (F4, R8): the popover (and the verify
    /// panel) is closed, no tidy-up, setup or other button's action runs, and no restart is waiting for Codex to quit.
    /// So an update never takes the window from someone looking at it and never cuts off what the app was asked to do.
    var isQuietForUpdate: Bool {
        !isPopoverOpen && inFlight.isEmpty && !isCleaningUp && automaticCleanupTask == nil
            && pendingRelaunch == nil && !setupActivity.isRunning && !isProbing
    }

    /// What the status card's fix says on hover while it waits; nil otherwise.
    var fixHelp: String? {
        guard let fix = summary.fix, waitsForQuit(fix) else { return nil }
        return Self.quitWaitHelp
    }

    private func waitsForQuit(_ action: CUAAction) -> Bool { action == .restartCodex && pendingRelaunch != nil }

    /// What a button says on hover while it waits for the automatic cleanup; nil otherwise.
    func cleanupHelp(for action: CUAAction) -> String? {
        waitsForAutomaticCleanup(action) ? Self.cleanupBusyHelp : nil
    }

    private func isClaudeSession(_ id: String) -> Bool {
        guard let leases = lastStatus?.leases else { return false }
        return leases.items.contains { $0.sessionID == id && $0.agent == .claude }
            || leases.maybeLeft.contains { $0.sessionID == id && $0.agent == .claude }
    }

    // MARK: Notifications (F1 case 2, R16)

    /// The question waits for the person's answer, so the setting is read before it and again after.
    private func requestNotificationAuthorizationOnce() {
        guard !didRequestAuthorization else { return }
        didRequestAuthorization = true
        let notifier = notifier
        runInBackground { [weak self] in
            self?.notificationPermission = await notifier.permission()
            _ = await notifier.requestAuthorization()
            self?.notificationPermission = await notifier.permission()
        }
    }

    private func readNotificationPermission() {
        let notifier = notifier
        runInBackground { [weak self] in
            self?.notificationPermission = await notifier.permission()
        }
    }

    /// 알림 켜기. While nobody has answered, the system's question is asked again: someone is at the
    /// screen now, and System Settings do not list the app before an answer. True when System
    /// Settings should open: the setting is off, or the question still went unanswered.
    func turnOnNotifications() async -> Bool {
        guard notificationPermission == .notDecided else { return true }
        _ = await notifier.requestAuthorization()
        notificationPermission = await notifier.permission()
        return notificationPermission == .notDecided
    }

    private func postDueNotifications(now: Date) {
        guard let status = lastStatus else { return }
        let due = notificationPlanner.due(
            status: status, appVersion: appVersion, now: now,
            cleanupTried: cleanupPlanner.tried, cleanupRunning: automaticCleanupTask != nil, tabsReleased: tabsReleasedIDs)
        for notification in due {
            runInBackground { [weak self, notifier] in
                let delivered = await notifier.post(notification)
                guard let self else { return }
                self.notificationPlanner.finish(notification.key, wasDelivered: delivered, now: self.clock())
            }
        }
    }

    /// A click on a notification.
    func handle(_ response: NotificationResponse) {
        switch response {
        case .openPopover(let tab):
            if let tab { selectedTab = tab }
            openPopoverHandler?()
        case .restartCodex(let key):
            // The person just clicked: what comes of it shows in the popover.
            openPopoverHandler?()
            // The notification is the question, so there is no second one. But it may be old: only
            // restart the Codex process it was about, and only while it still has no host.
            guard let status = lastStatus else {
                show(ActionOutcome(kind: .info, message: Self.restartNeedsStatus))
                return
            }
            guard codexRunsWithoutHost(in: status), NotificationPlanner.codexKey(for: status) == key else {
                show(ActionOutcome(kind: .info, message: "Codex는 이미 다시 켜졌거나 연결돼서 그대로 뒀어요"))
                return
            }
            runInBackground { [weak self] in _ = await self?.perform(.restartCodex) }
        }
    }

    /// Starts work the model does on its own. It is dropped from `backgroundTasks` once it is done.
    private func runInBackground(_ work: @escaping @MainActor () async -> Void) {
        let id = UUID()
        // The task cannot start before this method returns (both on the main actor), so it is
        // always in the table before it removes itself.
        backgroundTasks[id] = Task { [weak self] in
            await work()
            self?.backgroundTasks[id] = nil
        }
    }

    /// How many of the model's own background tasks are still running. For tests.
    var backgroundTaskCount: Int { backgroundTasks.count }

    /// Waits for the work the model started on its own (automatic cleanup, notifications, the read
    /// that follows them). For tests.
    func waitForBackgroundWork() async {
        while true {
            let cleanup = automaticCleanupTask
            let reading = refreshTask
            let tasks = Array(backgroundTasks.values)
            if cleanup == nil, reading == nil, tasks.isEmpty { return }
            await cleanup?.value
            await reading?.value
            for task in tasks { await task.value }
        }
    }

    // MARK: Telling the answer

    /// Tells the answer to `action` where its button is: on its line, under the head of 손볼 것, or at the
    /// bottom of 기록. Where that place is not on screen (the line is gone, its tab is not the one shown,
    /// or nothing was read), it is the banner under the card, which is where the card's own buttons answer too.
    private func tell(_ outcome: ActionOutcome, about action: CUAAction) {
        guard !outcome.message.isEmpty else { return }
        guard let place = action.resultPlace, isOnScreen(place) else {
            show(outcome)
            return
        }
        placedResults[place] = outcome
        placedTimers[place]?.cancel()
        placedTimers[place] = Task { [weak self, sleep, duration = bannerDuration] in
            do { try await sleep(duration) } catch { return }
            self?.forgetPlaced(place)
        }
    }

    private func isOnScreen(_ place: ResultPlace) -> Bool {
        switch place {
        case .connection(let id): selectedTab == .connections && Confirmations.targetExists(id, in: content)
        case .session(let id):
            selectedTab == .connections && content?.connections.tidy?.rows.contains { $0.leaseRow?.sessionID == id } == true
        case .tidyAll: selectedTab == .connections && content?.connections.tidy != nil
        case .diagnosis: selectedTab == .activity
        case .check: selectedTab == .check
        }
    }

    private func forgetPlaced(_ place: ResultPlace) {
        placedTimers[place]?.cancel()
        placedTimers[place] = nil
        placedResults[place] = nil
    }

    /// A line that left the list takes its answer with it, so the answer is said under the card instead:
    /// a 정리 that worked is the common way for its line to go. So does a tab that is no longer shown.
    private func moveGonePlacesToTheBanner() {
        for (place, outcome) in placedResults where !isOnScreen(place) {
            forgetPlaced(place)
            show(outcome)
        }
    }

    // MARK: Banner

    private func show(_ outcome: ActionOutcome) {
        guard !outcome.message.isEmpty else { return }
        let banner = ActionBanner(outcome: outcome)
        self.banner = banner
        bannerTimer?.cancel()
        bannerTimer = Task { [weak self, sleep, duration = bannerDuration] in
            do { try await sleep(duration) } catch { return }
            self?.clearBanner(banner.id)
        }
    }

    private func clearBanner(_ id: UUID) {
        if banner?.id == id { banner = nil }
    }

    func dismissBanner() {
        bannerTimer?.cancel()
        bannerTimer = nil
        banner = nil
    }
}
