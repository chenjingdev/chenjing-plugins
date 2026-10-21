import Foundation
import ServiceManagement

enum LoginItemStatus: Equatable, Sendable {
    case notRegistered
    case enabled
    /// Registered, but the person has to allow it in System Settings.
    case requiresApproval
    case notFound
}

/// The system's login item for this app (F1: the app starts when the person logs in). A protocol,
/// so tests register nothing.
protocol LoginItemService: Sendable {
    var status: LoginItemStatus { get }
    func register() throws
    func unregister() throws
}

struct MainAppLoginItem: LoginItemService {
    var status: LoginItemStatus {
        switch SMAppService.mainApp.status {
        case .notRegistered: .notRegistered
        case .enabled: .enabled
        case .requiresApproval: .requiresApproval
        case .notFound: .notFound
        @unknown default: .notFound
        }
    }

    func register() throws { try SMAppService.mainApp.register() }

    func unregister() throws { try SMAppService.mainApp.unregister() }
}

/// What became of the login item, as the check tab reads it.
struct LoginItemReading: Equatable, Sendable {
    enum Health: String, Equatable, Sendable {
        case enabled
        /// Registered, but the person has to allow it in System Settings.
        case requiresApproval
        case failed
        case notFound
        /// Never registered (the app does not sit in an Applications folder).
        case notRegistered
        /// Registered once and turned off since by the person, which is respected.
        case turnedOff

        /// For the copied diagnosis.
        var word: String {
            switch self {
            case .enabled: "켜짐"
            case .requiresApproval: "승인 필요"
            case .failed: "등록 실패"
            case .notFound: "찾지 못함"
            case .notRegistered: "등록 안 함"
            case .turnedOff: "꺼짐"
            }
        }
    }

    var health: Health
    /// The sentence after the label.
    var detail: String
    /// The whole line of the 기록 tab and the copied diagnosis.
    var line: String

    static let label = "로그인 때 자동 실행: "

    init(_ health: Health, _ detail: String) {
        self.health = health
        self.detail = detail
        line = Self.label + detail
    }
}

/// Registers the login item once, the first time the app is opened from `/Applications` or
/// `~/Applications`, and never again: if the person turns it off in System Settings, that is
/// respected. There is no switch in the app. Nothing here asks or prompts; what happened is a
/// line for the 기록 tab and the copied diagnosis.
@MainActor
final class LoginItemRegistrar {
    static let doneKey = "loginItem.registered"

    private let service: any LoginItemService
    private let defaults: UserDefaults
    private let bundleURL: URL
    private let home: URL
    private var registrationFailed = false

    /// What became of the login item, kept up to date by `refresh()`.
    private(set) var reading = LoginItemReading(.notRegistered, "")

    /// One line about the login item.
    var line: String { reading.line }

    init(
        service: any LoginItemService,
        defaults: UserDefaults = .standard,
        bundleURL: URL = Bundle.main.bundleURL,
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) {
        self.service = service
        self.defaults = defaults
        self.bundleURL = bundleURL
        self.home = home
        refresh()
    }

    /// Whether the app sits directly in `/Applications` or `~/Applications`.
    var isInApplicationsFolder: Bool {
        guard bundleURL.pathExtension == "app" else { return false }
        let parent = Self.normalized(bundleURL.deletingLastPathComponent())
        return [URL(fileURLWithPath: "/Applications"), home.appendingPathComponent("Applications")]
            .map(Self.normalized).contains(parent)
    }

    private static func normalized(_ url: URL) -> String {
        url.resolvingSymlinksInPath().standardizedFileURL.path
    }

    /// Registers, once. Anything but a first launch from an Applications folder does nothing.
    func registerOnFirstLaunch() {
        guard !defaults.bool(forKey: Self.doneKey), isInApplicationsFolder else {
            refresh()
            return
        }
        do {
            try service.register()
            registrationFailed = false
            defaults.set(true, forKey: Self.doneKey)
        } catch {
            // Already registered, or waiting for the person's approval: it was asked, so it is done.
            // Anything else is tried again at the next launch.
            if service.status == .enabled || service.status == .requiresApproval {
                defaults.set(true, forKey: Self.doneKey)
            } else {
                registrationFailed = true
            }
        }
        refresh()
    }

    /// Takes the login item away for the remove action. The "first launch" memory goes with it, so
    /// opening the app again after a removal starts over. True when it is off afterwards.
    func unregisterForRemoval() -> Bool {
        defaults.removeObject(forKey: Self.doneKey)
        registrationFailed = false
        try? service.unregister()
        refresh()
        return service.status == .notRegistered || service.status == .notFound
    }

    func refresh() {
        reading = describe()
    }

    private func describe() -> LoginItemReading {
        if registrationFailed { return LoginItemReading(.failed, "등록하지 못했어요") }
        let status = service.status
        switch status {
        case .enabled:
            return LoginItemReading(.enabled, "켜짐")
        case .requiresApproval:
            return LoginItemReading(.requiresApproval, "승인이 필요해요 (시스템 설정 > 일반 > 로그인 항목)")
        case .notRegistered, .notFound:
            if defaults.bool(forKey: Self.doneKey) {
                return status == .notFound
                    ? LoginItemReading(.notFound, "찾지 못했어요")
                    : LoginItemReading(.turnedOff, "꺼짐 (시스템 설정 > 일반 > 로그인 항목에서 켤 수 있어요)")
            }
            return LoginItemReading(.notRegistered, "등록 안 함 (앱을 Applications 폴더에 옮겨 켜면 등록돼요)")
        }
    }
}
