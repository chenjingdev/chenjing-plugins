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

/// Owns everything the menu bar item and the popover show: it reads the engine on a timer,
/// turns the answer into `summary` and `content`, and runs the buttons' actions.
///
/// The engine is only ever awaited, so the main actor stays free while a command runs. The
/// confirmations, notifications and automatic cleanup of the next task wrap `perform(_:)` and
/// observe `summary` / `content`; nothing here needs to change for them.
@MainActor
final class CUABarViewModel: ObservableObject {
    /// This many failed reads in a row replace the last good answer with a problem; a single
    /// slow answer does not make the icon flicker. Without any good answer a failure shows at once.
    static let failuresBeforeProblem = 2

    @Published private(set) var summary: StatusSummary = StatusEvaluator.loading
    /// nil until the first answer, and again while the engine cannot be read.
    @Published private(set) var content: PopoverContent?
    @Published private(set) var updatedAt: Date?
    @Published var selectedTab: PopoverTab = .connections
    @Published private(set) var inFlight: Set<CUAAction> = []
    @Published private(set) var banner: ActionBanner?
    /// Sessions whose release by session id did not work; the extension-reset guidance opens for them.
    @Published private(set) var failedSessionIDs: Set<String> = []
    /// Whether the person opened or closed the extension-reset guidance; nil leaves it to the
    /// popover (open when a leftover cannot be released one by one). Kept here because this
    /// toolchain has no `@State` (SwiftUIMacros is not in the Command Line Tools).
    @Published var guidanceOpenByUser: Bool?

    private(set) var isPopoverOpen = false

    private let engine: any EngineClient
    private let appVersion: String?
    private let systemActions: any SystemActions
    private let pasteboard: any PasteboardWriting
    private let policy: RefreshPolicy
    private let clock: @Sendable () -> Date
    private let calendar: Calendar
    private let bannerDuration: Duration
    private let sleep: @Sendable (Duration) async throws -> Void

    private var lastStatus: EngineStatus?
    private var consecutiveFailures = 0
    private var refreshTask: Task<Void, Never>?
    private var loopTask: Task<Void, Never>?
    private var sleeper: CheckedContinuation<Void, Never>?
    private var sleepTimer: Task<Void, Never>?
    private var wakeRequested = false
    private var loopGeneration = 0
    private var bannerTimer: Task<Void, Never>?

    init(
        engine: any EngineClient,
        appVersion: String?,
        systemActions: any SystemActions = UnwiredSystemActions(),
        pasteboard: any PasteboardWriting = SystemPasteboard(),
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
        self.policy = policy
        self.clock = clock
        self.calendar = calendar
        self.bannerDuration = bannerDuration
        self.sleep = sleep
    }

    var currentInterval: Duration { isPopoverOpen ? policy.open : policy.closed }

    /// The footer line: when the status was last read.
    var updatedText: String {
        updatedAt.map { "갱신 \(Format.clock($0, calendar: calendar))" } ?? "읽는 중…"
    }

    // MARK: Refresh loop

    func start() {
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
        if open { wake() }
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
            reject(.commandFailed(exitCode: -1, message: error.localizedDescription))
        }
    }

    private func accept(_ status: EngineStatus) {
        let now = clock()
        lastStatus = status
        summary = StatusEvaluator.evaluate(status, appVersion: appVersion)
        content = PopoverContent(status: status, now: now, calendar: calendar)
        updatedAt = now
        let known = Set(status.leases.items.compactMap(\.sessionID) + status.leases.maybeLeft.compactMap(\.sessionID))
        failedSessionIDs.formIntersection(known)
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

    // MARK: Actions

    /// True while something that touches this connection (or every connection) is running.
    func isWaiting(onConnection id: String) -> Bool {
        inFlight.contains { $0.connectionID == id || $0.isWide }
    }

    /// Runs one button's action, shows its result, and reads the status again at once.
    @discardableResult
    func perform(_ action: CUAAction) async -> ActionOutcome {
        if action == .refresh {
            await refreshAfterInFlight()
            return ActionOutcome(kind: .info, message: "")
        }
        guard !inFlight.contains(action) else {
            return ActionOutcome(kind: .info, message: "이미 하는 중이에요")
        }
        inFlight.insert(action)
        defer { inFlight.remove(action) }
        let outcome = await execute(action)
        show(outcome)
        await refreshAfterInFlight()
        return outcome
    }

    /// For buttons: starts the action without making the caller wait for it.
    func send(_ action: CUAAction) {
        Task { await perform(action) }
    }

    private func execute(_ action: CUAAction) async -> ActionOutcome {
        do {
            switch action {
            case .releaseConnection(let id):
                return ActionMessages.releaseConnection(try await engine.releaseConnection(id: id))
            case .releaseEnded:
                return ActionMessages.releaseEnded(try await engine.releaseEnded())
            case .releaseSession(let id, let user):
                let result = try await engine.releaseSession(id: id, user: user)
                noteSessionRelease(id, result)
                return ActionMessages.releaseSession(result)
            case .stopConnection(let id, let force):
                return ActionMessages.stopConnection(try await engine.stopConnection(id: id, force: force), force: force)
            case .stopGroup(let group, let force):
                return ActionMessages.stopGroup(try await engine.stopGroup(group, force: force), group: group, force: force)
            case .restartCodex:
                return ActionMessages.restartCodex(try await engine.restartCodex())
            case .copyDiagnosis:
                pasteboard.copy(try await engine.diagnose())
                return ActionOutcome(kind: .success, message: "진단을 복사했어요")
            case .runSetup:
                try await engine.runSetup()
                return ActionOutcome(kind: .success, message: "연결 설정을 다시 맞췄어요")
            case .releaseLeftover:
                return try await releaseLeftovers()
            case .openCodexDownload:
                return await systemActions.openCodexDownload()
            case .installPlugin:
                return await systemActions.installPlugin()
            case .matchPluginVersion:
                return await systemActions.matchPluginVersion()
            case .refresh:
                return ActionOutcome(kind: .info, message: "")
            }
        } catch let error as EngineError {
            return ActionMessages.failure(of: Self.failureLead(for: action), error: error)
        } catch {
            return ActionOutcome(kind: .failure, message: "\(Self.failureLead(for: action)) — \(error.localizedDescription)")
        }
    }

    /// `release-session` for every leftover lease the engine can aim at.
    private func releaseLeftovers() async throws -> ActionOutcome {
        let targets = (lastStatus?.leases.maybeLeft ?? []).compactMap { $0.releasable ? $0.sessionID : nil }
        guard !targets.isEmpty else {
            return ActionOutcome(kind: .info, message: "하나씩 풀 수 있는 점유가 없어요")
        }
        var released = 0
        var tabs = 0
        var firstReason: String?
        for id in targets {
            // The card's button is a person's click, so Codex thread sessions may be released too.
            let result = try await engine.releaseSession(id: id, user: true)
            noteSessionRelease(id, result)
            if result.ok, result.released {
                released += 1
                tabs += result.tabCount ?? 0
            } else if firstReason == nil {
                firstReason = result.reason
            }
        }
        return ActionMessages.releaseLeftovers(attempted: targets.count, released: released, tabs: tabs, firstReason: firstReason)
    }

    private func noteSessionRelease(_ id: String, _ result: SessionReleaseResult) {
        if result.ok, result.released {
            failedSessionIDs.remove(id)
        } else if failedSessionIDs.insert(id).inserted {
            // A new failure opens the extension-reset guidance again, even if it was closed before.
            guidanceOpenByUser = nil
        }
    }

    private static func failureLead(for action: CUAAction) -> String {
        switch action {
        case .releaseConnection, .releaseEnded, .releaseLeftover: "놓지 못했어요"
        case .releaseSession: "풀지 못했어요"
        case .stopConnection, .stopGroup: "끄지 못했어요"
        case .restartCodex: "Codex를 다시 켜지 못했어요"
        case .copyDiagnosis: "진단을 복사하지 못했어요"
        case .runSetup: "설정하지 못했어요"
        case .openCodexDownload, .installPlugin, .matchPluginVersion, .refresh: "하지 못했어요"
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
