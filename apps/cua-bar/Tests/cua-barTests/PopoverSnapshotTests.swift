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

    /// The card's 다시 켜기 with what it cuts off beside it (A2-popover-restart.png): it is said before the press,
    /// so the press asks nothing.
    @Test func theCardsRestartSaysWhatItCutsOffBesideIt() async throws {
        let model = try await loadedModel("status-problem")
        #expect(model.fixNote == "하던 Codex 작업이 끊겨요")
        let bitmap = try #require(Snapshot.bitmap(of: SnapshotScene(model: model), dark: dark))
        #expect(NSApplication.shared.windows.allSatisfy { !$0.isVisible })
        #expect(Snapshot.inkRatio(bitmap) > 0.15, "the render looks blank")
        if let directory = environment["CUABAR_SNAPSHOT_DIR"] {
            try Snapshot.write(bitmap, named: "A2-popover-restart", to: directory)
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
        let live = "claude-12345-1792320000"
        var idle = try Fixtures.status("status-problem")
        idle.connections[1].state = .idle
        idle.connections[1].idleSeconds = 2000

        // A refused release: the row says so and keeps 탭 풀기.
        var rig = await Rig(idle)
        rig.engine.configure { $0.releaseConnectionQueue = [refused] }
        await rig.model.send(.releaseConnection(live))?.value
        try draw("state-refused-row", rig.model)

        // A line's button answers on the line, in one line.
        rig = await Rig(try Fixtures.status("status-problem"))
        rig.engine.configure { $0.releaseConnection = ReleaseResult(ok: false, released: false, reason: "relay_unavailable", scopeCount: 0) }
        await rig.model.send(.releaseConnection("codex-15888-1792319000"))?.value
        #expect(rig.model.banner == nil)
        try draw("state-line-answer", rig.model)

        // A restart whose relaunch failed: the message has its own button.
        rig.engine.configure { $0.restartCodex = RestartResult(ok: false, reason: "relaunch_failed") }
        await rig.model.send(.restartCodex)?.value
        try draw("state-relaunch-failed", rig.model)

        // Ended connections nobody can release: each line has 정리, and the head has 모두 정리.
        var status = try Fixtures.status("status-ready")
        for index in status.connections.indices {
            status.connections[index].state = .ended
            status.connections[index].canRelease = false
        }
        rig = await Rig(status)
        try draw("state-tidy-list", rig.model)
        await rig.model.send(.tidyAll)?.value
        #expect(rig.model.placedResults[.tidyAll] != nil, "under the head of 손볼 것, where 모두 정리 is")
        try draw("state-tidy-all-answer", rig.model)

        // 진단 복사 answers at the bottom of 기록, right above its button.
        rig = await Rig(try Fixtures.status("status-ready"))
        rig.model.selectedTab = .activity
        await rig.model.send(.copyDiagnosis)?.value
        try draw("state-diagnosis-answer", rig.model)

        // A release by session id that failed: its line says why, the guidance is open.
        rig = await Rig(try Fixtures.status("status-problem"))
        rig.engine.configure { $0.releaseSession = SessionReleaseResult(ok: true, released: false, reason: "cleanup_not_confirmed") }
        await rig.model.perform(.releaseSession("019a1b2c-0009", user: true))
        try draw("state-lease-failed", rig.model)

        // 모두 정리 with a Claude session and a Codex chat's session left: the chat's line has its own button.
        status = try Fixtures.status("status-ready")
        status.leases.maybeLeft = [
            LeftoverLease(sessionID: "019a-a", agent: .claude, connectionID: nil, cwd: "/Users/chenjing/dev/y", endedAt: Fixtures.now.addingTimeInterval(-300), releasable: true),
            LeftoverLease(sessionID: "019a-b", agent: .codex, connectionID: nil, cwd: "/Users/chenjing/dev/z/app", endedAt: nil, releasable: true),
        ]
        rig = await Rig(status)
        try draw("state-leftover-leases", rig.model)

        // With 오류 문구 남기기 on, a failed call's error text is under its row, in three lines at most.
        status = try Fixtures.status("status-problem")
        status.settings.errorText = true
        status.activity[1].errorText = "Computer Use cannot act while the Mac is locked. Unlock it, then call again. "
            + String(repeating: "The rest of the answer is long enough to need a fourth line. ", count: 4)
        rig = await Rig(status)
        rig.model.selectedTab = .activity
        try draw("state-error-text", rig.model)

        // A Codex that started without the relay: the card offers 다시 켜기, with what it cuts off beside it.
        status = try Fixtures.status("status-ready")
        status.setup.relay = "inactive"
        status.host.relayReason = "plugin_entry"
        status.host.restartAddsRelay = true
        rig = await Rig(status)
        #expect(rig.model.summary.fixLabel == StatusEvaluator.restartLabel)
        #expect(rig.model.fixNote == StatusEvaluator.restartCutsOffWithClaude)
        try draw("state-restart-offered", rig.model)
    }

    /// The list drawn tall enough to show all of it: the answer to a line's button is one line on it.
    @Test func theAnswersAreDrawnOnTheirOwnLines() async throws {
        let rig = await Rig(try Fixtures.status("status-problem"))
        func tallList() throws -> some View {
            let connections = try #require(rig.model.content).connections
            return ConnectionsTabView(content: connections, failedSessionIDs: [], model: rig.model)
                .frame(width: Theme.popoverWidth - 2 * Theme.padding, height: 780)
                .padding(Theme.padding)
                .background(Color(nsColor: .windowBackgroundColor))
        }
        func draw(_ name: String) throws -> NSBitmapImageRep {
            let bitmap = try #require(Snapshot.bitmap(of: try tallList(), dark: dark))
            #expect(Snapshot.inkRatio(bitmap) > 0.1, "\(name) looks blank")
            if let directory = environment["CUABAR_SNAPSHOT_EXTRA_DIR"] { try Snapshot.write(bitmap, named: name, to: directory) }
            return bitmap
        }
        let plain = try draw("state-line-plain-tall")
        rig.engine.configure { $0.releaseConnection = ReleaseResult(ok: false, released: false, reason: "relay_unavailable", scopeCount: 0) }
        await rig.model.send(.releaseConnection("codex-15888-1792319000"))?.value
        await rig.model.send(.tidy("claude-4001-1792300000"))?.value
        await rig.model.send(.tidyAll)?.value
        let answered = try draw("state-line-answers-tall")
        #expect(Snapshot.inkRatio(answered) > Snapshot.inkRatio(plain), "the answers are lines on the lines and under the head")
    }

    /// The automatic cleanup is running: 모두 정리 and the Claude session lines wait for it
    /// (A2-popover-cleaning-up.png).
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
        #expect(rig.model.tidyAllIsWaiting)
        let connections = try #require(Snapshot.bitmap(of: SnapshotScene(model: rig.model), dark: dark))
        #expect(Snapshot.inkRatio(connections) > 0.1)
        if let directory = environment["CUABAR_SNAPSHOT_DIR"] {
            try Snapshot.write(connections, named: "A2-popover-cleaning-up", to: directory)
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

    /// The list with two cmux-cua clients, one of them an orphan (A4-other-tools.png): the live one is a line
    /// under the tool with no button, the orphan is a line of 손볼 것 with 정리.
    @Test func theListDrawsTheCmuxClients() async throws {
        let rig = await Rig(try Fixtures.status("status-cmux"))
        let plain = try #require(Snapshot.bitmap(of: SnapshotScene(model: rig.model), dark: dark))
        #expect(NSApplication.shared.windows.allSatisfy { !$0.isVisible })
        #expect(Snapshot.inkRatio(plain) > 0.15, "the render looks blank")
        if let directory = environment["CUABAR_SNAPSHOT_EXTRA_DIR"] {
            try Snapshot.write(plain, named: "A4-other-tools", to: directory)
        }
    }

    /// A ready engine with nothing connected: the app's version is the engine's, so the card has no problem.
    private func emptyReadyStatus() -> EngineStatus {
        var status = EngineStatus()
        status.engine.version = "0.7.0"
        return status
    }

    @Test func eachTabDrawsWhenEverythingIsEmpty() async throws {
        let engine = FakeEngineClient(status: emptyReadyStatus())
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

        let empty = FakeEngineClient(status: emptyReadyStatus())
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
        engine.configure { $0.restartCodex = RestartResult(ok: false, reason: "quit_cancelled") }
        let withBanner = CUABarViewModel(engine: engine, appVersion: "0.7.0", clock: { Fixtures.now }, calendar: Fixtures.utc, bannerDuration: .seconds(3600))
        await withBanner.refresh()
        await withBanner.waitForBackgroundWork()
        await withBanner.perform(.restartCodex) // the card's own button answers under the card
        #expect(withBanner.banner?.outcome.message == "Codex가 종료를 취소했어요")
        let bitmap = try #require(Snapshot.bitmap(of: SnapshotScene(model: withBanner), dark: dark))
        if let directory = environment["CUABAR_SNAPSHOT_EXTRA_DIR"] {
            try Snapshot.write(bitmap, named: "state-banner", to: directory)
        }
        _ = model
    }
}

@MainActor
struct ButtonLineTests {
    /// S18: 강제 종료 once broke in two in a narrow row. A title keeps its one line however little room there is.
    @Test func aButtonTitleStaysOnOneLineInANarrowRow() throws {
        let spec = ButtonSpec(title: "모두 정리", action: .tidyAll, help: "")
        let free = try #require(Snapshot.bitmap(of: SpecButton(spec: spec) { _ in }))
        let narrow = try #require(Snapshot.bitmap(of: SpecButton(spec: spec) { _ in }.frame(width: 24)))
        #expect(narrow.size.height == free.size.height)
    }
}

/// The 점검 tab drawn in the states it has, and the popover's height with it (the list area is one height in every tab).
@MainActor
struct CheckTabSnapshotTests {
    private var environment: [String: String] { ProcessInfo.processInfo.environment }
    private var dark: Bool { environment["CUABAR_SNAPSHOT_APPEARANCE"] == "dark" }

    private func fine() throws -> EngineStatus {
        var status = try Fixtures.status("status-ready")
        status.engine.version = "0.7.0"
        return status
    }

    /// A model for a state of the 점검 tab: what Claude Code has, the developer tools, the login environment.
    private func model(
        _ status: EngineStatus, claude: ClaudeSetupState = CheckFixtures.claudeReady(), developerTools: Bool = false,
        login: LoginEnvironmentReading? = nil, probe: ProbeOutcome? = nil, tab: PopoverTab = .check
    ) async -> CUABarViewModel {
        let setup = SetupActivity()
        if developerTools { setup.record(waitingFor: [], developerToolsNeeded: true) }
        let engine = FakeEngineClient(status: status)
        if let probe { engine.configure { $0.probe = .success(probe) } }
        let model = CUABarViewModel(
            engine: engine, appVersion: "0.7.0", policy: RefreshPolicy(closed: .seconds(3600), open: .seconds(3600)),
            clock: { Fixtures.now }, calendar: Fixtures.utc, bannerDuration: .seconds(3600), setupActivity: setup,
            claudeInspector: { _ in claude }, loginItemReading: { LoginItemReading(.enabled, "켜짐") },
            loginEnvironmentReader: { login ?? LoginEnvironmentReading(agentLabel: nil, launchdValue: nil) },
            appLauncherValue: "/Users/x/.local/share/codex-cua/start-desktop-cli.sh")
        await model.refresh()
        await model.waitForBackgroundWork()
        if probe != nil { await model.perform(.runProbe) }
        model.selectedTab = tab
        return model
    }

    private func states() async throws -> [(String, CUABarViewModel)] {
        var conflictClaude = CheckFixtures.claudeReady()
        conflictClaude.mcp = .conflict
        conflictClaude.skill = .conflict
        conflictClaude.legacyPlugin = true
        var brokenOnCard = try fine()
        brokenOnCard.engine.version = "0.6.0"
        brokenOnCard.setup.relay = "unavailable"
        var loginConflict = try fine()
        loginConflict.setup.loginEnvironment = "conflict"
        var off = try fine()
        off.codex.running = false
        off.codex.pids = []
        off.host.state = .closed
        var unusable = CheckFixtures.claudeReady()
        unusable.claudeCodeUnusable = true
        return [
            ("all-fine", await model(try fine())),
            ("probe-passed", await model(try fine(), probe: .checked)),
            ("probe-failed", await model(try fine(), probe: .failed)),
            ("broken-on-the-card", await model(brokenOnCard, claude: { var c = CheckFixtures.claudeReady(); c.mcp = .missing; return c }())),
            ("conflicts-and-old-plugin", await model(try fine(), claude: conflictClaude)),
            ("login-environment-conflict", await model(loginConflict, login: LoginEnvironmentReading(agentLabel: nil, launchdValue: "/opt/other/codex-wrapper.sh"))),
            ("developer-tools", await model(try fine(), developerTools: true)),
            ("no-claude-code", await model(try fine(), claude: .none)),
            ("claude-code-cannot-start", await model(try fine(), claude: unusable)),
            ("codex-off", await model(off)),
        ]
    }

    @Test func theCheckTabDrawsInEachOfItsStates() async throws {
        for (name, model) in try await states() {
            let bitmap = try #require(Snapshot.bitmap(of: SnapshotScene(model: model), dark: dark), Comment(rawValue: name))
            #expect(NSApplication.shared.windows.allSatisfy { !$0.isVisible })
            #expect(Snapshot.inkRatio(bitmap) > 0.1, "\(name) looks blank")
            if let directory = environment["CUABAR_SNAPSHOT_EXTRA_DIR"] {
                try Snapshot.write(bitmap, named: "check-\(name)", to: directory)
            }
        }
    }

    /// The popover does not jump when the person goes to 점검, whatever that tab has to say: the list area is one height.
    @Test func theCheckTabKeepsTheHeightOfTheOtherTabsInEveryState() async throws {
        func height(_ model: CUABarViewModel) -> CGFloat {
            _ = NSApplication.shared
            return NSHostingView(rootView: PopoverView(model: model, quit: {})).fittingSize.height
        }
        for (name, model) in try await states() {
            var heights: Set<CGFloat> = []
            for tab in PopoverTab.allCases {
                model.selectedTab = tab
                heights.insert(height(model))
            }
            #expect(heights.count == 1, "\(name): the height changes between tabs: \(heights)")
        }
    }

    @Test func theTabIsInThePickerAndTheCheckLinesAreInTheTabArea() async throws {
        let model = try #require(try await states().first { $0.0 == "conflicts-and-old-plugin" }?.1)
        let content = model.checkContent
        #expect(content.problemCount == 2 + 0, "the MCP line (conflict and old plugin) and the skill line")
        #expect(content.lines.count == 9)
        #expect(PopoverTab.allCases.map(\.title).contains("점검"))
    }
}
