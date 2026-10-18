import AppKit
import SwiftUI
import Testing
@testable import cua_bar

/// A fake menu bar strip above the popover, so one picture shows the icon, its tooltip and the
/// popover together. Only the tests draw this.
private struct SnapshotScene: View {
    @ObservedObject var model: CUABarViewModel

    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            HStack(spacing: 14) {
                Spacer()
                Text("Wi-Fi").font(.system(size: 12))
                Image(nsImage: MenuBarIcon.image(for: model.summary.icon))
                    .renderingMode(.template)
                    .foregroundStyle(model.summary.icon == .problem ? Color.orange : Color.primary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 5).fill(Color.primary.opacity(0.18)))
                Text("12:00").font(.system(size: 12))
            }
            .padding(.horizontal, 12)
            .frame(height: 28)
            .background(Color.primary.opacity(0.08))

            Text(model.summary.tooltip)
                .font(.system(size: 11))
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(RoundedRectangle(cornerRadius: 4).fill(Color(nsColor: .controlBackgroundColor)))
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color.primary.opacity(0.25)))
                .padding(.trailing, 14)

            PopoverView(model: model, quit: {})
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color(nsColor: .windowBackgroundColor)))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.primary.opacity(0.18)))
                .shadow(color: .black.opacity(0.25), radius: 10, y: 4)
                .padding(.trailing, 8)
                .padding(.bottom, 14)

            // The three icons side by side and enlarged, to judge by shape alone.
            HStack(spacing: 22) {
                ForEach(IconState.allCases, id: \.self) { state in
                    VStack(spacing: 3) {
                        Image(nsImage: MenuBarIcon.image(for: state)).renderingMode(.template).resizable().scaledToFit().frame(width: 30, height: 30)
                        Text(state.accessibilityDescription).font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.trailing, 20)
            .padding(.bottom, 10)
        }
        .frame(width: 500)
        .background(Color(nsColor: .underPageBackgroundColor))
    }
}

/// Draws the popover for three situations. With `CUABAR_SNAPSHOT_DIR` set the PNGs are written
/// there (A1-popover-ready.png, -working.png, -problem.png); `CUABAR_SNAPSHOT_EXTRA_DIR` adds
/// every tab, and `CUABAR_SNAPSHOT_APPEARANCE=dark` renders dark mode.
@MainActor
struct PopoverSnapshotTests {
    private var environment: [String: String] { ProcessInfo.processInfo.environment }
    private var dark: Bool { environment["CUABAR_SNAPSHOT_APPEARANCE"] == "dark" }

    private func loadedModel(_ fixture: String, tab: PopoverTab = .connections, banner: ActionOutcome? = nil) async throws -> CUABarViewModel {
        let engine = FakeEngineClient(status: try Fixtures.status(fixture))
        let model = CUABarViewModel(
            engine: engine, appVersion: "0.7.0", policy: RefreshPolicy(closed: .seconds(3600), open: .seconds(3600)),
            clock: { Fixtures.now }, calendar: Fixtures.utc, bannerDuration: .seconds(3600))
        await model.refresh()
        // The fixture has an ended connection the app releases by itself (F5): let that finish, so
        // the picture does not catch it half way.
        await model.waitForBackgroundWork()
        model.selectedTab = tab
        return model
    }

    @Test(arguments: [("ready", "status-ready"), ("working", "status-working"), ("problem", "status-problem")])
    func drawsThePopoverForEachState(name: String, fixture: String) async throws {
        let model = try await loadedModel(fixture)
        let bitmap = try #require(Snapshot.bitmap(of: SnapshotScene(model: model), dark: dark))
        // Rendering happens off screen: no window of this test process may ever have been shown.
        #expect(NSApplication.shared.windows.allSatisfy { !$0.isVisible })
        #expect(bitmap.pixelsWide >= 1000 && bitmap.pixelsHigh >= 960)
        #expect(Snapshot.inkRatio(bitmap) > 0.15, "the render looks blank")
        if let directory = environment["CUABAR_SNAPSHOT_DIR"] {
            try Snapshot.write(bitmap, named: "A1-popover-\(name)", to: directory)
        }
    }

    /// A pending group-stop confirmation under the status card (A2-popover-confirm.png).
    @Test func aPendingGroupStopConfirmationDraws() async throws {
        let model = try await loadedModel("status-problem")
        model.send(.stopGroup(.all, force: false))
        #expect(model.confirmationPrompt?.title == "연결 3개를 끌까요?")
        let withQuestion = try #require(Snapshot.bitmap(of: SnapshotScene(model: model), dark: dark))
        #expect(NSApplication.shared.windows.allSatisfy { !$0.isVisible })
        model.cancelPending()
        let without = try #require(Snapshot.bitmap(of: SnapshotScene(model: model), dark: dark))
        #expect(withQuestion.pixelsHigh > without.pixelsHigh, "the question takes room of its own")
        if let directory = environment["CUABAR_SNAPSHOT_DIR"] {
            try Snapshot.write(withQuestion, named: "A2-popover-confirm", to: directory)
        }
    }

    /// The states the action layer adds, each drawn (and written when `CUABAR_SNAPSHOT_EXTRA_DIR` is set).
    @Test func theActionStatesDraw() async throws {
        func draw(_ name: String, _ model: CUABarViewModel) throws {
            let bitmap = try #require(Snapshot.bitmap(of: SnapshotScene(model: model), dark: dark))
            #expect(Snapshot.inkRatio(bitmap) > 0.1, "\(name) looks blank")
            if let directory = environment["CUABAR_SNAPSHOT_EXTRA_DIR"] { try Snapshot.write(bitmap, named: name, to: directory) }
        }
        let refused = ReleaseResult(ok: false, released: false, reason: "request_in_flight", scopeCount: 0)
        let ended = "claude-4001-1792300000"

        // A refused release, asked about once more, then refused again: the row says so.
        var rig = await Rig(try Fixtures.status("status-problem"))
        rig.engine.configure { $0.releaseConnectionQueue = [refused, refused] }
        rig.model.setPopoverOpen(true) // a question appears only in an open popover
        await rig.model.send(.releaseConnection(ended))?.value
        try draw("state-retry-question", rig.model)
        await rig.model.confirmPending()
        try draw("state-refused-row", rig.model)

        // Force stop and restart, each with its question.
        rig = await Rig(try Fixtures.status("status-problem"))
        rig.model.send(.stopConnection("claude-12345-1792320000", force: true))
        try draw("state-force-confirm", rig.model)
        rig.model.send(.restartCodex)
        try draw("state-restart-confirm", rig.model)
        rig.model.cancelPending()

        // A restart whose relaunch failed: the message has its own button.
        rig.engine.configure { $0.restartCodex = RestartResult(ok: false, reason: "relaunch_failed") }
        rig.model.send(.restartCodex)
        await rig.model.confirmPending()
        try draw("state-relaunch-failed", rig.model)

        // Ended connections nobody can release: the card stops them, after one question.
        var status = try Fixtures.status("status-ready")
        for index in status.connections.indices {
            status.connections[index].state = .ended
            status.connections[index].canRelease = false
        }
        rig = await Rig(status)
        try draw("state-stop-ended-card", rig.model)
        rig.model.send(.stopEnded)
        try draw("state-stop-ended-confirm", rig.model)

        // A pinpoint release that failed: its row says why, the guidance is open.
        rig = await Rig(try Fixtures.status("status-problem"))
        rig.engine.configure { $0.releaseSession = SessionReleaseResult(ok: true, released: false, reason: "cleanup_not_confirmed") }
        rig.model.selectedTab = .leases
        await rig.model.perform(.releaseSession("019a1b2c-0009", user: true))
        try draw("state-lease-failed", rig.model)

        // The card's own release of leftover sessions was a partial success.
        status = try Fixtures.status("status-ready")
        status.leases.maybeLeft = [
            LeftoverLease(sessionID: "019a-a", agent: .claude, connectionID: nil, cwd: "/Users/chenjing/dev/y", endedAt: Fixtures.now.addingTimeInterval(-300), releasable: true),
            LeftoverLease(sessionID: "019a-b", agent: .codex, connectionID: nil, cwd: "/Users/chenjing/dev/z/app", endedAt: nil, releasable: true),
        ]
        rig = await Rig(status)
        try draw("state-card-leftover", rig.model)

        // Ended connections already tried this run: the card stops them now.
        status = try Fixtures.status("status-ready")
        status.connections[0].state = .ended
        rig = await Rig(status)
        #expect(rig.model.summary.fix == .stopEnded)
        try draw("state-tried-ended-card", rig.model)
    }

    /// The automatic cleanup is running: the card's fix, 끝난 연결 놓아주기 and the Claude session
    /// rows wait for it (A2-popover-cleaning-up.png, with the 브라우저 점유 tab as an extra).
    @Test func aRunningCleanupDraws() async throws {
        var status = try Fixtures.status("status-ready")
        status.connections[0].state = .ended
        status.leases.maybeLeft = [
            LeftoverLease(sessionID: "019a-a", agent: .claude, connectionID: nil, cwd: "/Users/chenjing/dev/y", endedAt: Fixtures.now.addingTimeInterval(-20), releasable: true),
        ]
        let gate = AsyncGate()
        let engine = FakeEngineClient(status: status)
        engine.configure { $0.actionGate = gate }
        defer { gate.open() }
        let rig = await Rig(status, engine: engine, refresh: false)
        await rig.model.refresh()
        #expect(rig.model.isCleaningUp)
        #expect(rig.model.fixIsBusy)
        let connections = try #require(Snapshot.bitmap(of: SnapshotScene(model: rig.model), dark: dark))
        #expect(Snapshot.inkRatio(connections) > 0.1)
        rig.model.selectedTab = .leases
        let leases = try #require(Snapshot.bitmap(of: SnapshotScene(model: rig.model), dark: dark))
        if let directory = environment["CUABAR_SNAPSHOT_DIR"] {
            try Snapshot.write(connections, named: "A2-popover-cleaning-up", to: directory)
        }
        if let directory = environment["CUABAR_SNAPSHOT_EXTRA_DIR"] {
            try Snapshot.write(leases, named: "state-cleaning-up-leases", to: directory)
        }
        gate.open()
        await rig.model.waitForBackgroundWork()
        #expect(!rig.model.isCleaningUp)
    }

    @Test func eachTabDrawsForTheProblemFixture() async throws {
        for tab in PopoverTab.allCases {
            let model = try await loadedModel("status-problem", tab: tab)
            let bitmap = try #require(Snapshot.bitmap(of: SnapshotScene(model: model), dark: dark))
            #expect(Snapshot.inkRatio(bitmap) > 0.15)
            if let directory = environment["CUABAR_SNAPSHOT_EXTRA_DIR"] {
                try Snapshot.write(bitmap, named: "tab-problem-\(tab.rawValue)", to: directory)
            }
        }
    }

    /// The 다른 도구 tab with two cmux-cua clients, one of them an orphan (A4-other-tools.png), and the same
    /// tab after a normal stop of the first one timed out: its row offers 강제 종료 too.
    @Test func theOtherToolsTabDrawsTheCmuxClients() async throws {
        let first = "cmux-12892-1792284408"
        let rig = await Rig(try Fixtures.status("status-cmux"))
        rig.model.selectedTab = .otherTools
        let plain = try #require(Snapshot.bitmap(of: SnapshotScene(model: rig.model), dark: dark))
        #expect(NSApplication.shared.windows.allSatisfy { !$0.isVisible })
        #expect(Snapshot.inkRatio(plain) > 0.15, "the render looks blank")

        rig.engine.configure { $0.stopConnectionByID[first] = StopResult(ok: false, stopped: false, released: false, reason: "timeout") }
        await rig.model.send(.stopConnection(first, force: false))?.value
        #expect(rig.model.stopTimedOutIDs == [first])
        let timedOut = try #require(Snapshot.bitmap(of: SnapshotScene(model: rig.model), dark: dark))
        #expect(Snapshot.inkRatio(timedOut) > 0.15)
        if let directory = environment["CUABAR_SNAPSHOT_EXTRA_DIR"] {
            try Snapshot.write(plain, named: "A4-other-tools", to: directory)
            try Snapshot.write(timedOut, named: "A4-other-tools-timed-out", to: directory)
        }
    }

    @Test func eachTabDrawsWhenEverythingIsEmpty() async throws {
        let engine = FakeEngineClient(status: EngineStatus())
        let model = CUABarViewModel(engine: engine, appVersion: "0.7.0", clock: { Fixtures.now }, calendar: Fixtures.utc)
        await model.refresh()
        for tab in PopoverTab.allCases {
            model.selectedTab = tab
            let bitmap = try #require(Snapshot.bitmap(of: SnapshotScene(model: model), dark: dark))
            #expect(Snapshot.inkRatio(bitmap) > 0.1)
            if let directory = environment["CUABAR_SNAPSHOT_EXTRA_DIR"] {
                try Snapshot.write(bitmap, named: "tab-empty-\(tab.rawValue)", to: directory)
            }
        }
    }

    /// The popover keeps one height per card: switching tabs or hitting an unreadable engine must
    /// not make it jump or grow (a modifier applied to two views once doubled the placeholder).
    @Test func theTabAreaKeepsItsHeightInEveryTabAndState() async throws {
        func height(_ model: CUABarViewModel) -> CGFloat {
            _ = NSApplication.shared
            return NSHostingView(rootView: PopoverView(model: model, quit: {})).fittingSize.height
        }
        let problem = try await loadedModel("status-problem")
        var heights: Set<CGFloat> = []
        for tab in PopoverTab.allCases {
            problem.selectedTab = tab
            heights.insert(height(problem))
        }
        #expect(heights.count == 1, "the height changes between tabs: \(heights)")

        let empty = FakeEngineClient(status: EngineStatus())
        let emptyModel = CUABarViewModel(engine: empty, appVersion: "0.7.0", clock: { Fixtures.now }, calendar: Fixtures.utc)
        let loadingHeight = height(emptyModel)
        await emptyModel.refresh()
        let readyEmptyHeight = height(emptyModel)
        empty.setStatusError(.timeout)
        let broken = CUABarViewModel(engine: empty, appVersion: "0.7.0", clock: { Fixtures.now }, calendar: Fixtures.utc)
        await broken.refresh()
        // Same list area, cards a little different: all within a few lines of each other, and short enough for a laptop.
        for value in [loadingHeight, readyEmptyHeight, height(broken), heights.first ?? 0] {
            #expect(value > 380 && value < 700, "unexpected popover height \(value)")
        }
        #expect(abs(loadingHeight - readyEmptyHeight) < 30)
    }

    /// The popover's window is sized from the SwiftUI view (`preferredContentSize`); a zero size
    /// there is how a popover ends up blank. Checked without any status item or visible window.
    @Test func theHostingControllerReportsThePopoverSize() async throws {
        _ = NSApplication.shared
        let model = try await loadedModel("status-problem")
        let host = NSHostingController(rootView: PopoverView(model: model, quit: {}))
        host.sizingOptions = [.preferredContentSize]
        let window = NSWindow(contentViewController: host)
        window.contentView?.layoutSubtreeIfNeeded()
        #expect(host.preferredContentSize.width == Theme.popoverWidth)
        #expect(host.preferredContentSize.height > 400)
        window.close()
    }

    @Test func theStatesLookDifferent() async throws {
        var ratios: [Double] = []
        for fixture in ["status-ready", "status-working", "status-problem"] {
            let model = try await loadedModel(fixture)
            ratios.append(Snapshot.inkRatio(try #require(Snapshot.bitmap(of: SnapshotScene(model: model), dark: dark))))
        }
        #expect(Set(ratios).count == 3)
    }

    @Test func theUnreadableAndLoadingStatesDraw() async throws {
        let engine = FakeEngineClient()
        let loading = CUABarViewModel(engine: engine, appVersion: "0.7.0", clock: { Fixtures.now }, calendar: Fixtures.utc)
        let loadingBitmap = try #require(Snapshot.bitmap(of: SnapshotScene(model: loading), dark: dark))
        engine.setStatusError(.timeout)
        let broken = CUABarViewModel(engine: engine, appVersion: "0.7.0", clock: { Fixtures.now }, calendar: Fixtures.utc)
        await broken.refresh()
        let brokenBitmap = try #require(Snapshot.bitmap(of: SnapshotScene(model: broken), dark: dark))
        if let directory = environment["CUABAR_SNAPSHOT_EXTRA_DIR"] {
            try Snapshot.write(loadingBitmap, named: "state-loading", to: directory)
            try Snapshot.write(brokenBitmap, named: "state-unreadable", to: directory)
        }
    }

    @Test func aBannerDraws() async throws {
        let model = try await loadedModel("status-problem")
        let engine = FakeEngineClient(status: try Fixtures.status("status-problem"))
        engine.configure { $0.releaseEnded = ReleaseEndedResult(ok: false, results: [
            EndedRelease(connectionID: "a", released: true), EndedRelease(connectionID: "b", released: false, reason: "request_in_flight")]) }
        let withBanner = CUABarViewModel(engine: engine, appVersion: "0.7.0", clock: { Fixtures.now }, calendar: Fixtures.utc, bannerDuration: .seconds(3600))
        await withBanner.perform(.releaseEnded)
        #expect(withBanner.banner != nil)
        let bitmap = try #require(Snapshot.bitmap(of: SnapshotScene(model: withBanner), dark: dark))
        if let directory = environment["CUABAR_SNAPSHOT_EXTRA_DIR"] {
            try Snapshot.write(bitmap, named: "state-banner", to: directory)
        }
        _ = model
    }
}
