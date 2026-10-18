import AppKit
import Foundation
import UserNotifications

/// The real notifications, behind `Notifier`. Only the app bundle may touch
/// `UNUserNotificationCenter.current()`: outside one (`swift run`, the tests) it raises an
/// exception, so `SystemNotifier.makeDefault()` hands out a `NoopNotifier` there.
enum SystemNotifier {
    static func makeDefault() -> any Notifier {
        let insideTheApp = Bundle.main.bundleURL.pathExtension == "app" && Bundle.main.bundleIdentifier != nil
        return insideTheApp ? UserNotificationCenterNotifier() : NoopNotifier()
    }
}

final class UserNotificationCenterNotifier: NSObject, Notifier, UNUserNotificationCenterDelegate, @unchecked Sendable {
    static let restartActionIdentifier = "dev.chenjing.cua-bar.restart-codex"

    private let center = UNUserNotificationCenter.current()
    private let lock = NSLock()
    private var handler: (@MainActor @Sendable (NotificationResponse) -> Void)?

    override init() {
        super.init()
        // Set at once so a click that launches the app is not lost.
        center.delegate = self
        // No `.foreground` option: pressing 다시 켜기 must not bring this app to the front (R1).
        let restart = UNNotificationAction(identifier: Self.restartActionIdentifier, title: "다시 켜기", options: [])
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: NotificationKind.codexWithoutHost.rawValue, actions: [restart], intentIdentifiers: [], options: []),
            UNNotificationCategory(
                identifier: NotificationKind.lingeringLease.rawValue, actions: [], intentIdentifiers: [], options: []),
        ])
    }

    func requestAuthorization() async -> Bool {
        // Alerts only: no sound, no badge.
        (try? await center.requestAuthorization(options: [.alert])) ?? false
    }

    func permission() async -> NotificationPermission {
        switch await center.notificationSettings().authorizationStatus {
        case .authorized, .provisional: .allowed
        case .denied: .off
        case .notDetermined: .notDecided
        @unknown default: .notDecided
        }
    }

    func post(_ notification: AppNotification) async -> Bool {
        // The person may have turned notifications off since the question was asked.
        let status = await center.notificationSettings().authorizationStatus
        guard status == .authorized || status == .provisional else { return false }
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.body = notification.body
        content.categoryIdentifier = notification.kind.rawValue
        content.userInfo = ["key": notification.key, "kind": notification.kind.rawValue]
        let request = UNNotificationRequest(identifier: notification.key, content: content, trigger: nil)
        do {
            try await center.add(request)
            return true
        } catch {
            return false
        }
    }

    func setResponseHandler(_ handler: @escaping @MainActor @Sendable (NotificationResponse) -> Void) {
        lock.withLock { self.handler = handler }
    }

    // MARK: UNUserNotificationCenterDelegate

    /// A notification arriving while the popover is open (the app counts as active) still shows.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard
            let kind = (info["kind"] as? String).flatMap(NotificationKind.init(rawValue:)),
            let key = info["key"] as? String
        else { return }
        let tap: NotificationResponse.Tap
        switch response.actionIdentifier {
        case UNNotificationDefaultActionIdentifier: tap = .body
        case Self.restartActionIdentifier: tap = .button(.restartCodex)
        default: return // dismissed, or a button this version does not know
        }
        guard let mapped = NotificationResponse.make(tap: tap, kind: kind, key: key) else { return }
        let handler = lock.withLock { self.handler }
        await handler?(mapped)
    }
}
