import Foundation
import Testing
@testable import cua_bar

/// Stands in for `SMAppService.mainApp`: remembers what it was asked and never touches the system.
final class FakeLoginItem: LoginItemService, @unchecked Sendable {
    struct Failure: Error {}

    private let lock = NSLock()
    private var current: LoginItemStatus
    private var recorded: [String] = []
    /// What the status becomes after a successful `register()`.
    var statusAfterRegister: LoginItemStatus = .enabled
    var registerFails = false
    var unregisterFails = false

    init(status: LoginItemStatus = .notRegistered) { current = status }

    var calls: [String] { lock.withLock { recorded } }
    var status: LoginItemStatus { lock.withLock { current } }
    func set(_ status: LoginItemStatus) { lock.withLock { current = status } }

    func register() throws {
        try lock.withLock {
            recorded.append("register")
            if registerFails { throw Failure() }
            current = statusAfterRegister
        }
    }

    func unregister() throws {
        try lock.withLock {
            recorded.append("unregister")
            if unregisterFails { throw Failure() }
            current = .notRegistered
        }
    }
}

@MainActor
struct LoginItemTests {
    private let home = URL(fileURLWithPath: "/Users/someone", isDirectory: true)

    private func registrar(
        _ service: FakeLoginItem, _ suite: DefaultsSuite, app: String = "/Applications/CUABar.app"
    ) -> LoginItemRegistrar {
        LoginItemRegistrar(service: service, defaults: suite.defaults, bundleURL: URL(fileURLWithPath: app, isDirectory: true), home: home)
    }

    // MARK: Only the first launch from Applications registers

    @Test(arguments: ["/Applications/CUABar.app", "/Users/someone/Applications/CUABar.app"])
    func theFirstLaunchFromAnApplicationsFolderRegisters(app: String) {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let service = FakeLoginItem()
        let registrar = registrar(service, suite, app: app)
        registrar.registerOnFirstLaunch()
        #expect(service.calls == ["register"])
        #expect(suite.defaults.bool(forKey: LoginItemRegistrar.doneKey), "remembered")
        #expect(registrar.line == "로그인 때 자동 실행: 켜짐")
    }

    @Test(arguments: [
        "/Users/someone/Downloads/CUABar.app",
        "/Users/someone/dev/chenjing-plugins/apps/cua-bar/CUABar.app",
        "/Volumes/Disk/CUABar.app",
        "/Applications/Utilities/CUABar.app",
        "/Users/someone/Applications/Sub/CUABar.app",
        "/Users/other/Applications/CUABar.app",
        "/Applications",
        "/Users/someone/dev/cua-bar/.build/debug",
    ])
    func aLaunchFromAnywhereElseDoesNotRegisterAndIsNotRemembered(app: String) {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let service = FakeLoginItem()
        let registrar = registrar(service, suite, app: app)
        registrar.registerOnFirstLaunch()
        #expect(service.calls.isEmpty)
        #expect(!suite.defaults.bool(forKey: LoginItemRegistrar.doneKey), "so a later launch from Applications is still the first")
        #expect(registrar.line.contains("등록 안 함"))
    }

    @Test func afterThatItNeverRegistersAgain() {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let service = FakeLoginItem()
        registrar(service, suite).registerOnFirstLaunch()
        #expect(service.calls == ["register"])
        // The next launch, a new object over the same preferences.
        registrar(service, suite).registerOnFirstLaunch()
        registrar(service, suite).registerOnFirstLaunch()
        #expect(service.calls == ["register"])
    }

    @Test func ifThePersonTurnedItOffInSystemSettingsItStaysOff() {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let service = FakeLoginItem()
        registrar(service, suite).registerOnFirstLaunch()
        service.set(.notRegistered) // switched off in System Settings > Login Items
        let later = registrar(service, suite)
        later.registerOnFirstLaunch()
        #expect(service.calls == ["register"], "respected: no second register()")
        #expect(later.line.contains("꺼짐"))
        #expect(later.line.contains("시스템 설정"))
    }

    // MARK: Without a prompt

    @Test func waitingForApprovalIsDoneAndSaysWhereToApprove() {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let service = FakeLoginItem()
        service.statusAfterRegister = .requiresApproval
        let registrar = registrar(service, suite)
        registrar.registerOnFirstLaunch()
        #expect(service.calls == ["register"])
        #expect(suite.defaults.bool(forKey: LoginItemRegistrar.doneKey), "it was asked once; no asking again")
        #expect(registrar.line.contains("승인이 필요해요"))
        #expect(registrar.line.contains("로그인 항목"))
    }

    @Test func anErrorIsAFailedLineAndNextLaunchTriesAgain() {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let service = FakeLoginItem()
        service.registerFails = true
        let first = registrar(service, suite)
        first.registerOnFirstLaunch()
        #expect(first.line == "로그인 때 자동 실행: 등록하지 못했어요")
        #expect(!suite.defaults.bool(forKey: LoginItemRegistrar.doneKey))
        service.registerFails = false
        let second = registrar(service, suite)
        second.registerOnFirstLaunch()
        #expect(service.calls == ["register", "register"])
        #expect(second.line == "로그인 때 자동 실행: 켜짐")
    }

    @Test func anErrorBecauseItWasAlreadyThereIsNotAFailure() {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let service = FakeLoginItem(status: .enabled)
        service.registerFails = true // "already registered"
        let registrar = registrar(service, suite)
        registrar.registerOnFirstLaunch()
        #expect(suite.defaults.bool(forKey: LoginItemRegistrar.doneKey))
        #expect(registrar.line == "로그인 때 자동 실행: 켜짐")
    }

    @Test func theLineFollowsTheSystemWhenItIsRefreshed() {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let service = FakeLoginItem()
        let registrar = registrar(service, suite)
        registrar.registerOnFirstLaunch()
        #expect(registrar.line == "로그인 때 자동 실행: 켜짐")
        service.set(.requiresApproval)
        #expect(registrar.line == "로그인 때 자동 실행: 켜짐", "not read again until asked")
        registrar.refresh()
        #expect(registrar.line.contains("승인이 필요해요"))
    }

    // MARK: Removal

    @Test func removalTakesItAwayAndTheNextOpeningStartsOver() {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let service = FakeLoginItem()
        let registrar = registrar(service, suite)
        registrar.registerOnFirstLaunch()
        #expect(registrar.unregisterForRemoval())
        #expect(service.calls == ["register", "unregister"])
        #expect(!suite.defaults.bool(forKey: LoginItemRegistrar.doneKey))
        // The app was not trashed and is opened again: that is a first launch again.
        self.registrar(service, suite).registerOnFirstLaunch()
        #expect(service.calls == ["register", "unregister", "register"])
    }

    @Test func removalThatCannotUnregisterReportsItIsStillOn() {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let service = FakeLoginItem(status: .enabled)
        service.unregisterFails = true
        #expect(!registrar(service, suite).unregisterForRemoval())
    }

    @Test func removalWhenItWasNeverRegisteredIsFine() {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let service = FakeLoginItem()
        service.unregisterFails = true // nothing to unregister
        #expect(registrar(service, suite).unregisterForRemoval())
    }
}
