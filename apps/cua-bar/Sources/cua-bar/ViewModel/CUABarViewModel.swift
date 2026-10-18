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

    @Published private(set) var summary: StatusSummary = StatusEvaluator.loading
    /// nil until the first answer, and again while the engine cannot be read.
    @Published private(set) var content: PopoverContent?
    @Published private(set) var updatedAt: Date?
    @Published var selectedTab: PopoverTab = .connections
    @Published private(set) var inFlight: Set<CUAAction> = []
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
    private var notificationPlanner = NotificationPlanner()
    private var backgroundTasks: [Task<Void, Never>] = []
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
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
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
        summary = StatusEvaluator.evaluate(status, appVersion: appVersion)
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
        summary = StatusEvaluator.summary(for: error)
        content = nil
        updatedAt = clock()
        failedSessionIDs = []
        sessionResults = [:]
        refusedReleaseIDs = []
        releaseRefusals = [:]
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

    /// The question an action asks before it runs, or nil when the click is its own consent.
    func confirmation(for action: CUAAction) -> PendingConfirmation? {
        Confirmations.prompt(for: action, content: content) == nil ? nil : PendingConfirmation(action: action, kind: .standard)
    }

    /// What a button calls: asks first when the action needs it, otherwise runs it. A new press
    /// replaces a question that is still waiting. Returns what it started (nil when it asked).
    @discardableResult
    func send(_ action: CUAAction) -> Task<Void, Never>? {
        if let question = confirmation(for: action) {
            pending = question
            return nil
        }
        pending = nil
        return Task { _ = await perform(action) }
    }

    /// The person said yes: run what was asked.
    @discardableResult
    func confirmPending() async -> ActionOutcome? {
        guard let question = pending else { return nil }
        pending = nil
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
        // Starting over later is a new first try.
        if question.kind == .retryRelease, case .retryRelease(let id) = question.action { releaseRefusals[id] = nil }
    }

    /// A question about something that is gone, or that no longer needs one, is withdrawn.
    private func revalidatePending() {
        guard let question = pending, question.kind == .standard else { return }
        if Confirmations.prompt(for: question.action, content: content) == nil { pending = nil }
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
        default:
            break
        }
        // Never two of the same at a time, and never beside the automatic `release --ended`.
        guard !inFlight.contains(action), !(action == .releaseEnded && automaticCleanupTask != nil) else {
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
                return (result.outcome, true)
            }
            releaseRefusals[id, default: 0] += 1
            if case .releaseConnection = action {
                // The question is the message; no banner on top of it.
                pending = PendingConfirmation(action: .retryRelease(id), kind: .retryRelease)
                return (result.outcome, false)
            }
            refusedReleaseIDs.insert(id)
            return (ActionOutcome(kind: .failure, message: ConnectionRow.refusedNote), true)
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
                let result = try await engine.releaseEnded()
                return ActionResult(
                    outcome: ActionMessages.releaseEnded(result),
                    reason: result.results.first { !$0.released }?.reason ?? result.reason)
            case .releaseSession(let id, let user):
                let result = try await engine.releaseSession(id: id, user: user)
                let outcome = ActionMessages.releaseSession(result)
                recordSession(id, outcome: outcome, reason: result.reason, released: result.ok && result.released)
                return ActionResult(outcome: outcome, reason: result.reason)
            case .stopConnection(let id, let force):
                let result = try await engine.stopConnection(id: id, force: force)
                return ActionResult(outcome: ActionMessages.stopConnection(result, force: force), reason: result.reason)
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
                try await engine.runSetup()
                return ActionResult(outcome: ActionOutcome(kind: .success, message: "연결 설정을 다시 맞췄어요"), reason: nil)
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
            case .showLeaseGuidance, .refresh:
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
            let result = try await engine.releaseSession(id: id, user: false)
            results.append(result)
            recordSession(
                id, outcome: ActionMessages.releaseSession(result), reason: result.reason, released: result.ok && result.released)
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
        case .openCodexDownload, .installPlugin, .matchPluginVersion, .showLeaseGuidance, .refresh: "하지 못했어요"
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
        automaticCleanupTask = Task { [weak self] in
            guard let self else { return }
            _ = try? await self.engine.releaseEnded()
            self.automaticCleanupTask = nil
            await self.refresh()
        }
    }

    // MARK: Notifications (F1 case 2, R16)

    private func requestNotificationAuthorizationOnce() {
        guard !didRequestAuthorization else { return }
        didRequestAuthorization = true
        let notifier = notifier
        backgroundTasks.append(Task { _ = await notifier.requestAuthorization() })
    }

    private func postDueNotifications(now: Date) {
        guard let status = lastStatus else { return }
        let due = notificationPlanner.due(
            status: status, appVersion: appVersion, now: now,
            cleanupTried: cleanupPlanner.tried, cleanupRunning: automaticCleanupTask != nil)
        for notification in due {
            backgroundTasks.append(Task { [weak self, notifier] in
                let delivered = await notifier.post(notification)
                guard let self else { return }
                self.notificationPlanner.finish(notification.key, wasDelivered: delivered, now: self.clock())
            })
        }
    }

    /// A click on a notification.
    func handle(_ response: NotificationResponse) {
        switch response {
        case .openPopover(let tab):
            if let tab { selectedTab = tab }
            openPopoverHandler?()
        case .restartCodex(let key):
            // The notification is the question, so there is no second one. But it may be old: only
            // restart the Codex process it was about, and only while it still has no host.
            guard
                let status = lastStatus,
                StatusEvaluator.problem(in: status, appVersion: appVersion)?.kind == .codexWithoutHost,
                NotificationPlanner.codexKey(for: status) == key
            else {
                show(ActionOutcome(kind: .info, message: "Codex는 이미 다시 켜졌거나 연결돼서 그대로 뒀어요"))
                return
            }
            backgroundTasks.append(Task { _ = await self.perform(.restartCodex) })
        }
    }

    /// Waits for the work the model started on its own (automatic cleanup, notifications, the read
    /// that follows them). For tests.
    func waitForBackgroundWork() async {
        while true {
            let cleanup = automaticCleanupTask
            let reading = refreshTask
            let tasks = backgroundTasks
            backgroundTasks = []
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
