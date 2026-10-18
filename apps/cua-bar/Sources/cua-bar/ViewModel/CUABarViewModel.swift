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

    /// A targeted release that fails for one of these reasons points at the extension reset (F3 case).
    static let reasonsPointingAtTheExtension: Set<String> = ["unsupported", "cleanup_not_confirmed", "timeout"]

    /// The outcome of an action that has nothing to say.
    static let quiet = ActionOutcome(kind: .info, message: "")

    /// A button that waits for the automatic cleanup says this when the pointer rests on it.
    static let cleanupBusyHelp = "자동 정리 중이에요"
    /// A press that arrives anyway: it does not run, and nothing is queued.
    static let cleanupBusyOutcome = ActionOutcome(kind: .info, message: "자동 정리 중이에요. 끝나면 다시 눌러 주세요")
    /// The notification's 다시 켜기 while the status cannot be read.
    static let restartNeedsStatus = "상태를 읽지 못해 다시 켜지 않았어요. 잠시 뒤 다시 눌러 주세요"

    @Published private(set) var summary: StatusSummary = StatusEvaluator.loading
    /// nil until the first answer, and again while the engine cannot be read.
    @Published private(set) var content: PopoverContent?
    @Published private(set) var updatedAt: Date?
    @Published var selectedTab: PopoverTab = .connections
    @Published private(set) var inFlight: Set<CUAAction> = [] {
        didSet { publishSummary() }
    }
    @Published private(set) var banner: ActionBanner?
    /// Sessions whose release by session id failed in a way the extension reset may fix; the
    /// guidance opens for them.
    @Published private(set) var failedSessionIDs: Set<String> = []
    /// What the last release by session id said, per session, shown on that session's own row.
    @Published private(set) var sessionResults: [String: ActionOutcome] = [:]
    /// Whether the person opened or closed the extension-reset guidance; nil leaves it to the
    /// popover (open when a leftover cannot be released one by one). Kept here because this
    /// toolchain has no `@State` (SwiftUIMacros is not in the Command Line Tools).
    @Published var guidanceOpenByUser: Bool?
    /// The question waiting for an answer, if any. Only one at a time.
    @Published private(set) var pending: PendingConfirmation?
    /// Connections whose release the engine refused twice (R15): their row says so and offers
    /// 다시 하기 and 강제 종료.
    @Published private(set) var refusedReleaseIDs: Set<String> = []
    /// The automatic cleanup (F5) is running: the buttons that would touch what it releases wait.
    @Published private(set) var isCleaningUp = false
    /// cmux-cua connections whose normal stop ran out of time (R17): their row offers 강제 종료.
    @Published private(set) var stopTimedOutIDs: Set<String> = []

    /// The raw answer of the last good read, for what needs more than `content` shows.
    private(set) var lastStatus: EngineStatus?
    private(set) var isPopoverOpen = false
    /// Set by the menu bar item: shows the popover (a click on a notification).
    var openPopoverHandler: (@MainActor () -> Void)?
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
    private let registeredPluginVersion: @Sendable () -> String?

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
    private var releaseRefusals: [String: Int] = [:]
    private var cleanupPlanner = CleanupPlanner()
    /// Ended connections this run has tried to release: a finished automatic run, or a person's
    /// release that went through. The card stops them instead of releasing them again (R13).
    private var releaseTriedIDs: Set<String> = []
    private var notificationPlanner = NotificationPlanner()
    /// Work the model started on its own; each removes itself when it is done.
    private var backgroundTasks: [UUID: Task<Void, Never>] = [:]
    private var didRequestAuthorization = false

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
        // What the card says while the plugin is being set up, installed or updated.
        setupActivity: SetupActivity = SetupActivity(),
        // The plugin version Claude Code registered (nil when unknown): an old plugin that cannot
        // answer `status` is told from a broken one by comparing it with `appVersion`.
        registeredPluginVersion: @escaping @Sendable () -> String? = { nil }
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
        self.registeredPluginVersion = registeredPluginVersion
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
    /// install or update that ends in one, the card says so instead of showing a problem.
    private func publishSummary() {
        let next = SetupOverlay.apply(
            to: evaluatedSummary, setup: setupActivity.phase, flowRunning: inFlight.contains(where: SetupOverlay.runsSetup))
        if next != summary { summary = next }
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
            wake()
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
        do {
            let status = try await engine.status()
            consecutiveFailures = 0
            accept(status)
        } catch is CancellationError {
            return
        } catch let error as EngineError {
            reject(error)
        } catch {
            reject(.commandFailed(exitCode: -1, message: ""))
        }
    }

    private func accept(_ status: EngineStatus) {
        let now = clock()
        lastStatus = status
        publish(StatusEvaluator.evaluate(status, appVersion: appVersion, releaseTried: releaseTriedIDs))
        content = PopoverContent(status: status, now: now, calendar: calendar)
        updatedAt = now
        forgetWhatIsGone(in: status)
        revalidatePending()
        // Cleanup first: the notifications look at what it has tried.
        startAutomaticCleanupIfNeeded()
        postDueNotifications(now: now)
    }

    private func reject(_ error: EngineError) {
        switch error {
        case .pluginMissing, .setupNeeded, .unsupportedSchema:
            // Not a hiccup: the answer will not change by asking again.
            consecutiveFailures = 0
        default:
            consecutiveFailures += 1
            if lastStatus != nil, consecutiveFailures < Self.failuresBeforeProblem { return }
        }
        lastStatus = nil
        publish(StatusEvaluator.summary(for: error, appVersion: appVersion, registeredPluginVersion: registeredPluginVersion()))
        content = nil
        updatedAt = clock()
        failedSessionIDs = []
        sessionResults = [:]
        refusedReleaseIDs = []
        releaseRefusals = [:]
        stopTimedOutIDs = []
        revalidatePending()
    }

    /// State kept for a connection or a session goes with it.
    private func forgetWhatIsGone(in status: EngineStatus) {
        let connections = Set(status.connections.map(\.id))
        releaseRefusals = releaseRefusals.filter { connections.contains($0.key) }
        refusedReleaseIDs.formIntersection(connections)
        let sessions = Set(status.leases.items.compactMap(\.sessionID) + status.leases.maybeLeft.compactMap(\.sessionID))
        failedSessionIDs.formIntersection(sessions)
        sessionResults = sessionResults.filter { sessions.contains($0.key) }
        stopTimedOutIDs.formIntersection(status.otherTools.flatMap(\.clients).compactMap(\.id))
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
            show(Self.cleanupBusyOutcome)
            return nil
        }
        switch Confirmations.gate(for: action, content: content) {
        case .ask:
            pending = PendingConfirmation(action: action, kind: .standard)
            return nil
        case .refuse(let reason):
            show(ActionOutcome(kind: .info, message: reason))
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
            return !Confirmations.targetExists(id, in: content)
        case .stopConnection(let id, force: true) where ToolClient.isCmuxConnection(id: id):
            // Asked from the line's 강제 종료, so it goes when that button does.
            guard let row = Confirmations.cmuxRow(id, in: content) else { return true }
            return row.timedOutButtons.isEmpty || !stopTimedOutIDs.contains(id)
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

    /// True while something that touches this connection (or every connection) is running.
    func isWaiting(onConnection id: String) -> Bool {
        inFlight.contains { $0.connectionID == id || $0.isWide }
    }

    /// Runs one button's action with no question, shows its result, and reads the status again at once.
    @discardableResult
    func perform(_ action: CUAAction) async -> ActionOutcome {
        switch action {
        case .refresh:
            await refreshAfterInFlight()
            return Self.quiet
        case .showLeaseGuidance:
            showGuidance()
            return Self.quiet
        case .showLeases:
            selectedTab = .leases
            return Self.quiet
        default:
            break
        }
        // Never beside the automatic cleanup on what it is releasing. Not queued: the person presses again.
        if waitsForAutomaticCleanup(action) {
            show(Self.cleanupBusyOutcome)
            return Self.cleanupBusyOutcome
        }
        // Never two of the same at a time.
        guard !inFlight.contains(action) else {
            return ActionOutcome(kind: .info, message: "이미 하는 중이에요")
        }
        inFlight.insert(action)
        defer { inFlight.remove(action) }
        let result = await execute(action)
        let (outcome, showsBanner) = settle(action, result)
        if showsBanner { show(outcome) }
        await refreshAfterInFlight()
        return outcome
    }

    /// R15: a release the engine refuses because a tool call has not finished is asked about once
    /// more; refused again, the row says so and offers 다시 하기 and 강제 종료.
    private func settle(_ action: CUAAction, _ result: ActionResult) -> (outcome: ActionOutcome, showsBanner: Bool) {
        switch action {
        case .releaseConnection(let id), .retryRelease(let id):
            guard result.reason == "request_in_flight", result.outcome.kind == .failure else {
                releaseRefusals[id] = nil
                refusedReleaseIDs.remove(id)
                if result.outcome.kind == .success { noteReleaseTried([id]) }
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
            refusedReleaseIDs.insert(id)
            return (ActionOutcome(kind: .failure, message: ConnectionRow.refusedNote), true)
        case .stopConnection(let id, _) where ToolClient.isCmuxConnection(id: id):
            // R17: a cmux-cua row offers 강제 종료 only once a stop ran out of time; a stop that went
            // through takes the offer away.
            if result.reason == "timeout", result.outcome.kind == .failure {
                stopTimedOutIDs.insert(id)
            } else if result.outcome.kind != .failure {
                stopTimedOutIDs.remove(id)
            }
            return (result.outcome, true)
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
            case .releaseEnded:
                // The status the release started from: a read during the release may already miss what it ended.
                let before = lastStatus
                let result = try await engine.releaseEnded(ReleaseEndedLoad(status: before))
                noteReleaseTried(result)
                return ActionResult(
                    outcome: ActionMessages.releaseEnded(result, in: before),
                    reason: result.results.first { !$0.released && $0.reason != "no_trusted_scope" }?.reason ?? result.reason)
            case .releaseSession(let id, let user):
                let result = try await engine.releaseSession(id: id, user: user)
                let outcome = ActionMessages.releaseSession(result)
                recordSession(id, outcome: outcome, reason: result.reason, released: result.ok && result.released)
                return ActionResult(outcome: outcome, reason: result.reason)
            case .stopConnection(let id, let force):
                let result = try await engine.stopConnection(id: id, force: force)
                let outcome = ToolClient.isCmuxConnection(id: id)
                    ? ActionMessages.stopCmuxConnection(result, force: force) : ActionMessages.stopConnection(result, force: force)
                return ActionResult(outcome: outcome, reason: result.reason)
            case .stopGroup(let group, let force):
                let result = try await engine.stopGroup(group, force: force)
                return ActionResult(
                    outcome: ActionMessages.stopGroup(result, group: group, force: force),
                    reason: result.results.first { !$0.stopped }?.reason ?? result.reason)
            case .stopEnded:
                return try await stopEndedConnections()
            case .restartCodex:
                let result = try await engine.restartCodex()
                return ActionResult(outcome: ActionMessages.restartCodex(result), reason: result.reason)
            case .copyDiagnosis:
                pasteboard.copy(try await engine.diagnose())
                return ActionResult(outcome: ActionOutcome(kind: .success, message: "진단을 복사했어요"), reason: nil)
            case .runSetup:
                // Through the shared setup slot: one setup at a time, said on the card while it runs.
                return ActionResult(outcome: await setupActivity.run { try await self.engine.runSetup() }, reason: nil)
            case .releaseLeftover:
                return try await releaseLeftovers()
            case .openCodex:
                return ActionResult(outcome: await appOpener.openCodex(appPath: lastStatus?.codex.appPath), reason: nil)
            case .openCodexDownload:
                return ActionResult(outcome: await systemActions.openCodexDownload(), reason: nil)
            case .installPlugin:
                return ActionResult(outcome: await systemActions.installPlugin(), reason: nil)
            case .matchPluginVersion:
                return ActionResult(outcome: await systemActions.matchPluginVersion(), reason: nil)
            case .showLeaseGuidance, .showLeases, .refresh:
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

    /// The status card's 놓아주기 for leftover leases: `release-session` without `--user` for each
    /// Claude session the engine can aim at, one after another, each with its own result. Codex
    /// chat sessions are released only from their own row (that click passes `--user`).
    private func releaseLeftovers() async throws -> ActionResult {
        let targets = (lastStatus?.leases.maybeLeft ?? [])
            .filter { $0.agent == .claude && $0.releasable }
            .compactMap(\.sessionID)
        var results: [SessionReleaseResult] = []
        for id in targets {
            // One that cannot be asked does not keep the rest from being tried (as `stopEndedConnections`).
            do {
                let result = try await engine.releaseSession(id: id, user: false)
                results.append(result)
                recordSession(
                    id, outcome: ActionMessages.releaseSession(result), reason: result.reason, released: result.ok && result.released)
            } catch let error as EngineError {
                switch error {
                case .pluginMissing, .setupNeeded, .unsupportedSchema: throw error
                default:
                    results.append(SessionReleaseResult(ok: false, released: false, reason: error.reasonCode))
                    recordSession(
                        id, outcome: ActionMessages.failure(of: Self.failureLead(for: .releaseSession(id, user: false)), error: error),
                        reason: error.reasonCode, released: false)
                }
            }
        }
        let failed = results.filter { !($0.ok && $0.released) }
        // The guidance is what the person needs next, so it must be on screen.
        if failed.contains(where: { $0.reason.map(Self.reasonsPointingAtTheExtension.contains) ?? false }) { showGuidance() }
        return ActionResult(outcome: ActionMessages.releaseLeftovers(results), reason: failed.first?.reason)
    }

    /// 끝난 연결 끄기: one normal `stop --connection` per ended connection the engine may stop.
    private func stopEndedConnections() async throws -> ActionResult {
        let ids = (lastStatus?.connections ?? []).filter { $0.state == .ended && $0.canStop }.map(\.id)
        var results: [StopResult] = []
        for id in ids {
            do {
                results.append(try await engine.stopConnection(id: id, force: false))
            } catch let error as EngineError {
                switch error {
                case .pluginMissing, .setupNeeded, .unsupportedSchema: throw error
                default: results.append(StopResult(ok: false, stopped: false, released: false, reason: error.reasonCode))
                }
            }
        }
        return ActionResult(outcome: ActionMessages.stopEnded(results), reason: results.first { !$0.stopped }?.reason)
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

    /// 안내 보기: the 브라우저 점유 tab with its guidance open.
    private func showGuidance() {
        selectedTab = .leases
        guidanceOpenByUser = true
    }

    private static func failureLead(for action: CUAAction) -> String {
        switch action {
        case .releaseConnection, .retryRelease, .releaseEnded, .releaseLeftover: "놓지 못했어요"
        case .releaseSession: "풀지 못했어요"
        case .stopConnection, .stopGroup, .stopEnded: "끄지 못했어요"
        case .restartCodex: "Codex를 다시 켜지 못했어요"
        case .copyDiagnosis: "진단을 복사하지 못했어요"
        case .runSetup: "설정하지 못했어요"
        case .openCodex: "Codex를 열지 못했어요"
        case .openCodexDownload, .installPlugin, .matchPluginVersion, .showLeaseGuidance, .showLeases, .refresh: "하지 못했어요"
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
        isCleaningUp = true
        automaticCleanupTask = Task { [weak self] in
            guard let self else { return }
            _ = try? await self.engine.releaseEnded(load)
            // Tried, whatever came of it: the card now stops these instead of releasing them again.
            self.releaseTriedIDs.formUnion(endedIDs)
            self.automaticCleanupTask = nil
            self.isCleaningUp = false
            await self.refresh()
        }
    }

    /// True while the automatic cleanup runs and this action would touch what it is releasing:
    /// the release or stop of ended connections (the card's fix, 끝난 연결 놓아주기), the card's
    /// release of leftover sessions, and a Claude session's 콕 집어 풀기. Restart, setup and the
    /// rest release nothing and do not wait.
    func waitsForAutomaticCleanup(_ action: CUAAction) -> Bool {
        guard isCleaningUp else { return false }
        switch action {
        case .releaseEnded, .stopEnded, .releaseLeftover: return true
        case .releaseSession(let id, _): return isClaudeSession(id)
        default: return false
        }
    }

    /// The status card's fix waits: for its own run, or for the automatic cleanup.
    var fixIsBusy: Bool {
        guard let fix = summary.fix else { return false }
        return inFlight.contains(fix) || waitsForAutomaticCleanup(fix)
    }

    /// What a button says on hover while it waits for the automatic cleanup; nil otherwise.
    func cleanupHelp(for action: CUAAction) -> String? {
        waitsForAutomaticCleanup(action) ? Self.cleanupBusyHelp : nil
    }

    private func isClaudeSession(_ id: String) -> Bool {
        guard let leases = lastStatus?.leases else { return false }
        return leases.items.contains { $0.sessionID == id && $0.agent == .claude }
            || leases.maybeLeft.contains { $0.sessionID == id && $0.agent == .claude }
    }

    /// A person's release that went through counts as tried for the ended connections among `ids`.
    private func noteReleaseTried(_ ids: [String]) {
        releaseTriedIDs.formUnion(ids.filter { lastStatus?.connection(withID: $0)?.state == .ended })
    }

    /// 끝난 연결 놓아주기: every ended connection when the engine says all went (`ok`), else the
    /// ones it released or found nothing to release on.
    private func noteReleaseTried(_ result: ReleaseEndedResult) {
        let ended = (lastStatus?.connections ?? []).filter { $0.state == .ended }.map(\.id)
        noteReleaseTried(result.ok ? ended : result.results
            .filter { $0.released || $0.reason == "no_trusted_scope" }
            .compactMap(\.connectionID))
    }

    // MARK: Notifications (F1 case 2, R16)

    private func requestNotificationAuthorizationOnce() {
        guard !didRequestAuthorization else { return }
        didRequestAuthorization = true
        let notifier = notifier
        runInBackground { _ = await notifier.requestAuthorization() }
    }

    private func postDueNotifications(now: Date) {
        guard let status = lastStatus else { return }
        let due = notificationPlanner.due(
            status: status, appVersion: appVersion, now: now,
            cleanupTried: cleanupPlanner.tried, cleanupRunning: automaticCleanupTask != nil)
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
