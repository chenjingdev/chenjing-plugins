import Foundation

/// The fixed lines of the remove action. None carries text a command printed.
enum RemovalMessages {
    /// Asked once, inline, before anything is touched (R3).
    static let question = "연결 설정과 중계기를 되돌려요. Codex는 다음에 켤 때부터 연결 없이 원래대로 켜져요."
    static let working = "되돌리는 중…"
    static let trashHint = "이 앱 파일은 이제 휴지통으로 옮겨도 돼요. Claude 플러그인은 그대로 남아 있어요."
    static let done = "연결 설정과 중계기를 되돌렸어요. " + trashHint
    static let nothingToUndo = "되돌릴 연결 설정이 없었어요. " + trashHint
    /// The remover refuses while a Codex host runs. Codex is never quit from here.
    static let hostRunning = "Codex를 정상 종료한 뒤 다시 해 주세요"
    static let failed = "제거하지 못했어요 — 연결 설정은 그대로 남아 있을 수 있어요"
    /// A setup (or an install or update) writes the same files; they do not run at the same time.
    static let setupRunning = "연결을 설정하는 중이라 지금은 못 해요. 끝난 뒤에 다시 해 주세요"
    static let loginItemStays = " 로그인 항목은 시스템 설정 > 일반 > 로그인 항목에서 직접 꺼 주세요."
}

/// The footer's 제거 (R3): asks once, runs `codex-cua uninstall`, takes the login item away, shows
/// the result and quits. If the remover refuses because a Codex host is running, it says so and
/// changes nothing else; it never quits Codex. The Claude plugin and the app file stay.
@MainActor
final class RemovalFlow: ObservableObject {
    enum Phase: Equatable {
        case idle
        /// The question is on screen with its two buttons.
        case confirming
        case working
        /// Undone; the text is the result, and the app quits in a moment.
        case finished(String)
        /// Not done, nothing else changed, the app stays. The text says why.
        case refused(String)
    }

    @Published private(set) var phase: Phase = .idle

    private let engine: any EngineClient
    private let loginItem: LoginItemRegistrar
    private let quit: @MainActor () -> Void
    private let sleep: @Sendable (Duration) async throws -> Void
    private let readingTime: Duration
    private let isSetupRunning: @MainActor () -> Bool
    private let onRemoved: @MainActor () -> Void

    init(
        engine: any EngineClient,
        loginItem: LoginItemRegistrar,
        quit: @escaping @MainActor () -> Void,
        // Long enough to read the result before the app goes away.
        readingTime: Duration = .seconds(6),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        // True while a setup, install or update runs: removing waits until it is done.
        isSetupRunning: @escaping @MainActor () -> Bool = { false },
        // Called once it is undone, so the app can stop reading a status that no longer exists.
        onRemoved: @escaping @MainActor () -> Void = {}
    ) {
        self.engine = engine
        self.loginItem = loginItem
        self.quit = quit
        self.readingTime = readingTime
        self.sleep = sleep
        self.isSetupRunning = isSetupRunning
        self.onRemoved = onRemoved
    }

    /// 제거 was pressed: ask.
    func ask() {
        switch phase {
        case .idle, .refused: phase = .confirming
        case .confirming, .working, .finished: break
        }
    }

    /// 취소, or closing a refusal.
    func dismiss() {
        switch phase {
        case .confirming, .refused: phase = .idle
        case .idle, .working, .finished: break
        }
    }

    /// 제거 was confirmed.
    func confirm() async {
        guard phase == .confirming else { return }
        if isSetupRunning() {
            phase = .refused(RemovalMessages.setupRunning)
            return
        }
        phase = .working
        var undone = true
        do {
            try await engine.uninstall()
        } catch let error as EngineError {
            switch error {
            case .pluginMissing, .setupNeeded:
                // The command was never set up: there is nothing to undo.
                undone = false
            default:
                phase = .refused(await refusal())
                return
            }
        } catch {
            phase = .refused(RemovalMessages.failed)
            return
        }
        let loginItemOff = loginItem.unregisterForRemoval()
        phase = .finished((undone ? RemovalMessages.done : RemovalMessages.nothingToUndo) + (loginItemOff ? "" : RemovalMessages.loginItemStays))
        onRemoved()
        try? await sleep(readingTime)
        quit()
    }

    /// The remover exits with the same code whatever stopped it, so what refused it is read from
    /// what is running now: a Codex host (or Codex itself, when the host cannot be told).
    private func refusal() async -> String {
        if let status = try? await engine.status(), Self.hostMayBeRunning(in: status) {
            return RemovalMessages.hostRunning
        }
        return RemovalMessages.failed
    }

    static func hostMayBeRunning(in status: EngineStatus) -> Bool {
        switch status.host.state {
        case .ready, .starting: true
        case .unknown: status.codex.running
        case .closed, .missing: false
        }
    }
}
