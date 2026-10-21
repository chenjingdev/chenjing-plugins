import Foundation

enum NotificationKind: String, Equatable, Sendable {
    /// Codex runs without the host (F1 case 2).
    case codexWithoutHost
    /// A lease the owner left behind is still listed a minute later (R16).
    case lingeringLease
    /// A newer CUA Bar is out and the app could not put it in by itself (F4); posted once per version.
    case updateFailed
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

extension AppNotification {
    /// The footer shows the same news as its 새 버전 button; clicking the notification opens the popover.
    static func updateFailed(_ version: String) -> AppNotification {
        AppNotification(
            key: "update-failed-\(version)", kind: .updateFailed, title: "CUA Bar 새 버전 \(version)를 저절로 올리지 못했어요",
            body: "창 아래 버튼으로 받을 수 있어요")
    }
}

/// What the person did with a notification, already turned into what the app should do.
enum NotificationResponse: Equatable, Sendable {
    /// Clicking the body opens the popover; a lingering lease opens it on 연결, where the lease line is.
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
        case (.body, .lingeringLease): .openPopover(.connections)
        case (.body, .updateFailed): .openPopover(nil)
        case (.button(.restartCodex), .codexWithoutHost): .restartCodex(key: key)
        default: nil
        }
    }
}

/// Where this app's notifications stand in System Settings. Until the person answers the system's
/// question, the app can ask it again; System Settings list the app only once it was answered, and a
/// no can then be changed only there.
enum NotificationPermission: Equatable, Sendable {
    /// Alerts may be shown.
    case allowed
    /// Not answered yet. Also an app that started while the screen was locked: its question failed
    /// at once and was never shown.
    case notDecided
    /// Turned off for this app.
    case off
    /// Not the installed app (`swift run`, the tests): there is no setting.
    case unavailable

    /// The footer offers 알림 켜기 while notifications cannot be shown and the person can change that.
    var offersTurningOn: Bool { self == .off || self == .notDecided }

    /// Its line in the copied diagnosis.
    var diagnosisLine: String {
        switch self {
        case .allowed: "알림: 켜짐"
        case .notDecided: "알림: 아직 허용하지 않음"
        case .off: "알림: 꺼짐"
        case .unavailable: "알림: 쓸 수 없음"
        }
    }

    /// This app's page in System Settings → 알림.
    static var settingsURL: URL {
        let id = Bundle.main.bundleIdentifier ?? "dev.chenjing.cua-bar"
        return URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(id)")!
    }
}

/// Notifications behind a seam: `UserNotificationCenterNotifier` in the app, a fake in tests.
/// Nothing in the app depends on a notification being shown: the icon and the status card carry
/// every problem (R21).
protocol Notifier: Sendable {
    /// Asks for permission (the system shows its question only the first time) and says whether
    /// alerts are allowed.
    func requestAuthorization() async -> Bool
    /// What System Settings says now. Never asks.
    func permission() async -> NotificationPermission
    /// Posts it and says whether it went out. False when notifications are off or denied.
    func post(_ notification: AppNotification) async -> Bool
    /// Where clicks on a notification go.
    func setResponseHandler(_ handler: @escaping @MainActor @Sendable (NotificationResponse) -> Void)
}

/// For anything that is not the installed app (`swift run`, tests): nothing is asked or posted.
struct NoopNotifier: Notifier {
    func requestAuthorization() async -> Bool { false }
    func permission() async -> NotificationPermission { .unavailable }
    func post(_ notification: AppNotification) async -> Bool { false }
    func setResponseHandler(_ handler: @escaping @MainActor @Sendable (NotificationResponse) -> Void) {}
}
