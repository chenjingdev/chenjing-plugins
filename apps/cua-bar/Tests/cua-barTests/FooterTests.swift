import AppKit
import SwiftUI
import Testing
@testable import cua_bar

/// The bottom line (time, new version, 끝내기) and the bottom of 기록 (진단 복사, 알림 켜기, 앱 지우기
/// with its question, the login item line) together, and the diagnosis the person copies.
@MainActor
struct FooterTests {
    private struct Kit {
        var maintenance: Maintenance
        var releases: ReleaseChecker
        var removal: RemovalFlow
        var opener: FakeOpener
        var suite: DefaultsSuite
        var log: EventLog
    }

    private func kit(latest: String? = "0.8.0", app: String = "0.7.0", loginItem: LoginItemStatus = .enabled) -> Kit {
        let suite = DefaultsSuite()
        let log = EventLog()
        let fetcher = latest.map { FakeFetcher(json: FakeFetcher.list($0)) } ?? FakeFetcher(failing: ReleaseFetchError.badResponse)
        let releases = ReleaseChecker(appVersion: app, fetcher: fetcher, defaults: suite.defaults)
        let registrar = LoginItemRegistrar(service: FakeLoginItem(status: loginItem), defaults: suite.defaults)
        let removal = RemovalFlow(engine: FakeEngineClient(), loginItem: registrar, quit: { log.add("quit") }, sleep: ManualSleeper().sleep)
        let opener = FakeOpener()
        return Kit(
            maintenance: Maintenance(releases: releases, removal: removal, loginItem: registrar, opener: opener),
            releases: releases, removal: removal, opener: opener, suite: suite, log: log)
    }

    private func model() async throws -> CUABarViewModel {
        let model = CUABarViewModel(
            engine: FakeEngineClient(status: try Fixtures.status("status-ready")), appVersion: "0.7.0",
            clock: { Fixtures.now }, calendar: Fixtures.utc, sleep: ManualSleeper().sleep)
        await model.refresh()
        return model
    }

    private func waitUntil(_ timeout: Double = 30, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { try? await Task.sleep(for: .milliseconds(2)) }
        return condition()
    }

    private func fittingSize<V: View>(_ view: V) -> CGSize {
        _ = NSApplication.shared
        return NSHostingView(rootView: view).fittingSize
    }

    // MARK: New version

    @Test func theButtonAppearsOnlyWhenTheCheckFoundANewerAppAndOpensItsPage() async throws {
        let kit = kit()
        defer { kit.suite.remove() }
        #expect(kit.releases.newRelease == nil, "no button before there is a result")
        await kit.releases.checkIfDue()
        let release = try #require(kit.releases.newRelease)
        #expect(release.buttonTitle == "새 버전 0.8.0")
        // What the button does: open that release's page, nothing more.
        _ = await kit.maintenance.opener.open(release.url)
        #expect(kit.opener.opened == [URL(string: "https://github.com/chenjingdev/chenjing-plugins/releases/tag/cua-bar--v0.8.0")!])
    }

    @Test func noButtonWhenTheAppIsAlreadyTheNewest() async {
        let kit = kit(latest: "0.7.0")
        defer { kit.suite.remove() }
        await kit.releases.checkIfDue()
        #expect(kit.releases.newRelease == nil)
    }

    @Test func theFooterDrawsTheButtonOnlyWhenThereIsANewerRelease() async {
        let newer = kit(latest: "0.8.0")
        let same = kit(latest: "0.7.0")
        defer { newer.suite.remove(); same.suite.remove() }
        await newer.releases.checkIfDue()
        await same.releases.checkIfDue()
        func width(_ kit: Kit) -> CGFloat {
            fittingSize(FooterView(updatedText: "갱신 12:34:56", maintenance: kit.maintenance, quit: {})).width
        }
        // Its natural width grows by the button and its spacing, nothing else.
        #expect(width(newer) > width(same) + 60, "newer \(width(newer)) vs same \(width(same))")
    }

    @Test func theBottomLineIsOneLineOfTheTimeTheNewVersionAndQuitAndNothingElse() async {
        let kit = kit()
        defer { kit.suite.remove() }
        await kit.releases.checkIfDue() // the new-version button too: the fullest line
        let row = Theme.popoverWidth - 2 * Theme.padding
        let full = fittingSize(FooterView(updatedText: "갱신 12:34:56", maintenance: kit.maintenance, quit: {}))
        #expect(full.width <= row, "everything fits the line side by side")
        #expect(fittingSize(FooterView(updatedText: "갱신 12:34:56", maintenance: kit.maintenance, quit: {}).frame(width: row)).height < 30, "one line")
        // Asking to remove the app puts nothing on this line: its question is at the bottom of 기록.
        kit.removal.ask()
        let asking = fittingSize(FooterView(updatedText: "갱신 12:34:56", maintenance: kit.maintenance, quit: {}).frame(width: row))
        #expect(asking.height < 30)
        kit.removal.dismiss()
    }

    // MARK: The bottom of 기록

    @Test func theRareButtonsAreNamedAsTheUserChoseThem() {
        #expect(ActivityContent.diagnosisButton.title == "진단 복사")
        #expect(NotificationsButton.title == "알림 켜기")
        #expect(RemovalMessages.buttonTitle == "앱 지우기…")
        #expect(RemovalMessages.confirmTitle == "앱 지우기")
    }

    private func bottom(
        _ kit: Kit, _ permission: NotificationPermission = .unavailable, maintenance: Bool = true, note: String? = nil
    ) -> ActivityBottomView {
        ActivityBottomView(
            copyButton: ActivityContent.diagnosisButton, copying: false, note: note, maintenance: maintenance ? kit.maintenance : nil,
            notifications: permission, copy: {})
    }

    @Test func theNotificationsButtonIsAtTheBottomOfActivityOnlyWhileTheyCannotBeShownAndTheRowStillFits() {
        let kit = kit()
        defer { kit.suite.remove() }
        let allowed = fittingSize(bottom(kit, .allowed)).width
        #expect(fittingSize(bottom(kit, .off)).width > allowed + 40)
        #expect(fittingSize(bottom(kit, .notDecided)).width == fittingSize(bottom(kit, .off)).width)
        #expect(fittingSize(bottom(kit, .unavailable)).width == allowed)
        let row = Theme.popoverWidth - 2 * Theme.padding
        #expect(fittingSize(bottom(kit, .off)).width <= row, "everything fits the row side by side")
        #expect(fittingSize(bottom(kit, .off).frame(width: row)).height < 40, "one line")
    }

    @Test func withoutMaintenanceOnlyTheDiagnosisButtonIsThereAndWithItTheRemoveButtonToo() {
        let kit = kit()
        defer { kit.suite.remove() }
        let plain = fittingSize(bottom(kit, .off, maintenance: false)).width
        let full = fittingSize(bottom(kit, .allowed)).width
        #expect(full > plain + 40, "앱 지우기… joins 진단 복사: \(plain) vs \(full)")
        // 알림 켜기 needs the opener that maintenance carries, so it is not there without it.
        #expect(fittingSize(bottom(kit, .off, maintenance: false)).width == plain)
    }

    @Test func theRemoveQuestionIsAtTheBottomOfActivityAndAddsOnlyItsOwnCard() {
        let kit = kit()
        defer { kit.suite.remove() }
        let width = Theme.popoverWidth - 2 * Theme.padding
        func size() -> CGSize { fittingSize(bottom(kit, .off, note: "로그인 때 자동 실행: 켜짐").frame(width: width)) }
        let idle = size()
        #expect(idle.height > 20 && idle.height < 70, "buttons and the login line: \(idle)")

        kit.removal.ask()
        let asking = size()
        #expect(asking.height > idle.height + 40, "the question and its two buttons are on screen")
        #expect(asking.height < 200)
        kit.removal.dismiss()
        #expect(abs(size().height - idle.height) < 1, "and gone again when cancelled")
    }

    // MARK: Layout

    @Test func thePopoverKeepsItsSizeWhenTheRemoveQuestionOpensInActivity() async throws {
        let kit = kit()
        defer { kit.suite.remove() }
        await kit.releases.checkIfDue()
        let model = try await model()
        model.selectedTab = .activity
        func popover(_ maintenance: Maintenance?) -> CGSize { fittingSize(PopoverView(model: model, maintenance: maintenance, quit: {})) }
        let without = popover(nil)
        let idle = popover(kit.maintenance)
        #expect(idle.width == Theme.popoverWidth)
        #expect(abs(idle.height - without.height) < 6, "no jump when the extras are added: \(without) vs \(idle)")
        kit.removal.ask()
        let asking = popover(kit.maintenance)
        #expect(asking.width == Theme.popoverWidth)
        #expect(abs(asking.height - idle.height) < 6, "the question sits inside the tab's own room: \(idle) vs \(asking)")
        #expect(asking.height < 760, "still fits a laptop screen: \(asking)")
        // The list tab never shows it: it has no such buttons to ask from.
        model.selectedTab = .connections
        #expect(abs(popover(kit.maintenance).height - idle.height) < 6)
    }

    @Test func everyRemovalStateDrawsSomething() async throws {
        let log = EventLog()
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let engine = FakeEngineClient()
        let registrar = LoginItemRegistrar(service: FakeLoginItem(status: .enabled), defaults: suite.defaults)
        let sleeper = ManualSleeper()
        let flow = RemovalFlow(engine: engine, loginItem: registrar, quit: { log.add("quit") }, sleep: sleeper.sleep)
        let width = Theme.popoverWidth - 2 * Theme.padding
        var heights: [String: CGFloat] = [:]
        func record(_ name: String) {
            heights[name] = fittingSize(RemovalNoticeView(removal: flow).frame(width: width)).height
        }
        record("idle")
        flow.ask()
        record("confirming")
        let gate = AsyncGate()
        engine.configure { $0.actionGate = gate }
        let running = Task { await flow.confirm() }
        #expect(await waitUntil { engine.calls.contains(.uninstall) })
        record("working")
        gate.open()
        #expect(await waitUntil { !sleeper.requestedDurations.isEmpty })
        record("finished")
        sleeper.releaseAll()
        await running.value
        #expect(heights["idle"] == 0, "nothing is drawn while idle")
        for state in ["confirming", "working", "finished"] { #expect((heights[state] ?? 0) > 20, "\(state): \(heights[state] ?? 0)") }
        #expect(log.events == ["quit"])
    }

    // MARK: The 기록 tab line and the copied diagnosis

    @Test func theDiagnosisCopyGetsTwoAppLinesAndNothingElseIsChanged() async throws {
        let kit = kit(loginItem: .requiresApproval)
        defer { kit.suite.remove() }
        let board = RecordingPasteboard()
        let pasteboard = DiagnosisPasteboard(base: board) { "앱: CUA Bar 0.7.0\n\(kit.maintenance.loginItem.line)" }
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        engine.configure { $0.diagnosis = "CUA diagnosis (fake)\nhost: ready\n" }
        let model = CUABarViewModel(
            engine: engine, appVersion: "0.7.0", pasteboard: pasteboard, clock: { Fixtures.now }, calendar: Fixtures.utc,
            sleep: ManualSleeper().sleep)
        await model.perform(.copyDiagnosis)
        let copied = try #require(board.copied.first)
        #expect(copied.hasPrefix("CUA diagnosis (fake)\nhost: ready\n"))
        #expect(copied.hasSuffix("앱: CUA Bar 0.7.0\n로그인 때 자동 실행: 승인이 필요해요 (시스템 설정 > 일반 > 로그인 항목)\n"))
        #expect(board.copied.count == 1)
    }

    @Test func theDiagnosisCopyAddsALineBreakOnlyWhenNeeded() {
        let board = RecordingPasteboard()
        let pasteboard = DiagnosisPasteboard(base: board) { "앱: x" }
        pasteboard.copy("no newline at the end")
        pasteboard.copy("with newline\n")
        pasteboard.copy("")
        #expect(board.copied == ["no newline at the end\n앱: x\n", "with newline\n앱: x\n", "앱: x\n"])
    }

    @Test func theActivityTabShowsTheLoginLineWhenGivenWithoutMakingThePopoverTaller() async throws {
        let kit = kit(loginItem: .notRegistered)
        defer { kit.suite.remove() }
        let model = try await model()
        model.selectedTab = .activity
        let with = fittingSize(PopoverView(model: model, maintenance: kit.maintenance, quit: {}))
        let without = fittingSize(PopoverView(model: model, maintenance: nil, quit: {}))
        #expect(kit.maintenance.loginItem.line.contains("등록 안 함"))
        // The tab area is a fixed height, so the line must not make the popover taller.
        #expect(abs(with.height - without.height) < 6, "\(with) vs \(without)")
    }

    // MARK: Pictures

    /// The popover with the bottom of 기록 in its states renders to a real PNG. With `CUABAR_SNAPSHOT_DIR`
    /// set the files are kept there for a look by eye; otherwise they are only checked and dropped.
    @Test func thePopoverWithTheFooterRendersToPictures() async throws {
        let kit = kit()
        defer { kit.suite.remove() }
        await kit.releases.checkIfDue()
        let model = try await model()
        let directory = ProcessInfo.processInfo.environment["CUABAR_SNAPSHOT_DIR"]
        func picture(_ name: String, dark: Bool = false) throws {
            _ = NSApplication.shared
            let view = PopoverView(model: model, maintenance: kit.maintenance, quit: {}).background(Color(nsColor: .windowBackgroundColor))
            let host = NSHostingView(rootView: view)
            let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            host.appearance = appearance
            let size = host.fittingSize
            host.frame = NSRect(origin: .zero, size: size)
            let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
            window.appearance = appearance
            window.contentView = host
            host.layoutSubtreeIfNeeded()
            let bitmap = try #require(NSBitmapImageRep(
                bitmapDataPlanes: nil, pixelsWide: Int(size.width) * 2, pixelsHigh: Int(size.height) * 2, bitsPerSample: 8,
                samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
            bitmap.size = size
            host.cacheDisplay(in: host.bounds, to: bitmap)
            let png = try #require(bitmap.representation(using: .png, properties: [:]))
            #expect(png.count > 10_000, "\(name) looks blank")
            #expect(NSApplication.shared.windows.allSatisfy { !$0.isVisible })
            if let directory {
                let folder = URL(fileURLWithPath: directory, isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                try png.write(to: folder.appendingPathComponent(name + ".png"))
            }
        }
        try picture("A3-footer-idle")
        model.selectedTab = .activity
        try picture("A3-footer-activity")
        try picture("A3-footer-activity-dark", dark: true)
        kit.removal.ask()
        try picture("A3-footer-confirm")
        kit.removal.dismiss()
    }
}
