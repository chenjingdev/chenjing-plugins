import Foundation

enum NotificationKind: String, Equatable, Sendable {
    /// Codex runs without the host (F1 case 2).
    case codexWithoutHost
    /// A lease the owner left behind is still listed a minute later (R16).
    case lingeringLease
}

enum NotificationButton: String, Equatable, Sendable {
    case restartCodex
}

/// One notification the app may post. `key` says what it is about, so each is posted once.
struct AppNotification: Equatable, Sendable {
    var key: String
    var kind: NotificationKind
    var title: String
    var body: String
    var buttons: [NotificationButton] = []

    /// The question F1 asks instead of restarting Codex by itself: the notification is the question.
    static func codexWithoutHost(key: String) -> AppNotification {
        AppNotification(
            key: key, kind: .codexWithoutHost, title: "Codex가 연결 없이 켜져 있어요",
            body: "다시 켜면 Claude가 붙어요. 하던 Codex 작업이 끊겨요.", buttons: [.restartCodex])
    }

    /// `beforeRestart`: a session a still-running bridge had before Codex restarted (`ended_at`
    /// null); its connection did not end, so the body does not say it did.
    static func lingeringLease(key: String, entry: LeftoverLease, beforeRestart: Bool = false) -> AppNotification {
        let who = entry.cwd.map { "\(entry.agent.label) · \(Format.folder($0))" } ?? entry.agent.label
        let body = beforeRestart
            ? "Codex가 다시 켜지기 전 세션의 점유가 1분 넘게 남아 있어요 (\(who)). 눌러서 확인해 보세요."
            : "\(who) 연결이 끝난 지 1분이 넘었는데 점유가 풀렸는지 확인되지 않았어요. 눌러서 확인해 보세요."
        return AppNotification(key: key, kind: .lingeringLease, title: "브라우저 탭이 아직 잡혀 있을 수 있어요", body: body)
    }
}

/// What the person did with a notification, already turned into what the app should do.
enum NotificationResponse: Equatable, Sendable {
    /// Clicking the body opens the popover; a lingering lease opens it on 브라우저 점유.
    case openPopover(PopoverTab?)
    /// The 다시 켜기 button. `key` names the Codex process the notification was about.
    case restartCodex(key: String)

    enum Tap: Equatable, Sendable {
        case body
        case button(NotificationButton)
        case dismissed
    }

    static func make(tap: Tap, kind: NotificationKind, key: String) -> NotificationResponse? {
        switch (tap, kind) {
        case (.body, .codexWithoutHost): .openPopover(nil)
        case (.body, .lingeringLease): .openPopover(.leases)
        case (.button(.restartCodex), .codexWithoutHost): .restartCodex(key: key)
        default: nil
        }
    }
}

/// Notifications behind a seam: `UserNotificationCenterNotifier` in the app, a fake in tests.
/// Nothing in the app depends on a notification being shown: the icon and the status card carry
/// every problem (R21).
protocol Notifier: Sendable {
    /// Asks for permission (the system shows its question only the first time) and says whether
    /// alerts are allowed.
    func requestAuthorization() async -> Bool
    /// Posts it and says whether it went out. False when notifications are off or denied.
    func post(_ notification: AppNotification) async -> Bool
    /// Where clicks on a notification go.
    func setResponseHandler(_ handler: @escaping @MainActor @Sendable (NotificationResponse) -> Void)
}

/// For anything that is not the installed app (`swift run`, tests): nothing is asked or posted.
struct NoopNotifier: Notifier {
    func requestAuthorization() async -> Bool { false }
    func post(_ notification: AppNotification) async -> Bool { false }
    func setResponseHandler(_ handler: @escaping @MainActor @Sendable (NotificationResponse) -> Void) {}
}
