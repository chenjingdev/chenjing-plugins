import Foundation
import Testing
@testable import cua_bar

/// What happened, in order, across the engine, the login item and the app itself.
final class EventLog: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String] = []
    var events: [String] { lock.withLock { recorded } }
    func add(_ event: String) { lock.withLock { recorded.append(event) } }
}

/// A login item that writes into the shared log, so the order of removal can be checked.
final class LoggingLoginItem: LoginItemService, @unchecked Sendable {
    private let log: EventLog
    private let lock = NSLock()
    private var current: LoginItemStatus
    init(log: EventLog, status: LoginItemStatus = .enabled) {
        self.log = log
        current = status
    }
    var status: LoginItemStatus { lock.withLock { current } }
    func register() throws {}
    func unregister() throws {
        log.add("unregister login item")
        lock.withLock { current = .notRegistered }
    }
}

@MainActor
struct RemovalTests {
    private struct Rig {
        var flow: RemovalFlow
        var engine: FakeEngineClient
        var log: EventLog
        var suite: DefaultsSuite
        var sleeper: ManualSleeper
    }

    private func rig(
        uninstallError: EngineError? = nil, status: EngineStatus? = nil, loginItem: LoginItemStatus = .enabled
    ) -> Rig {
        let log = EventLog()
        let engine = FakeEngineClient(status: status ?? EngineStatus())
        engine.configure {
            $0.uninstallError = uninstallError
            $0.onUninstall = { log.add("uninstall") }
        }
        let suite = DefaultsSuite()
        suite.defaults.set(true, forKey: LoginItemRegistrar.doneKey)
        let registrar = LoginItemRegistrar(service: LoggingLoginItem(log: log, status: loginItem), defaults: suite.defaults)
        let sleeper = ManualSleeper()
        let flow = RemovalFlow(engine: engine, loginItem: registrar, quit: { log.add("quit") }, readingTime: .seconds(6), sleep: sleeper.sleep)
        return Rig(flow: flow, engine: engine, log: log, suite: suite, sleeper: sleeper)
    }

    private func waitUntil(_ timeout: Double = 30, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { try? await Task.sleep(for: .milliseconds(2)) }
        return condition()
    }

    private func hostRunning() -> EngineStatus {
        var status = EngineStatus()
        status.codex.running = true
        status.host.state = .ready
        return status
    }

    // MARK: Asking first

    @Test func nothingHappensUntilTheQuestionIsAnswered() async {
        let rig = rig()
        defer { rig.suite.remove() }
        #expect(rig.flow.phase == .idle)
        rig.flow.ask()
        #expect(rig.flow.phase == .confirming)
        #expect(rig.log.events.isEmpty, "asking changes nothing")
        #expect(rig.engine.calls.isEmpty)
    }

    @Test func theQuestionIsTheOneThePersonIsGiven() {
        #expect(RemovalMessages.question == "연결 설정과 중계기를 되돌려요. Codex는 다음에 켤 때부터 연결 없이 원래대로 켜져요.")
    }

    @Test func cancellingLeavesEverythingAsItWas() async {
        let rig = rig()
        defer { rig.suite.remove() }
        rig.flow.ask()
        rig.flow.dismiss()
        #expect(rig.flow.phase == .idle)
        await rig.flow.confirm() // nothing is being asked any more
        #expect(rig.flow.phase == .idle)
        #expect(rig.log.events.isEmpty)
    }

    @Test func confirmingWithoutAskingDoesNothing() async {
        let rig = rig()
        defer { rig.suite.remove() }
        await rig.flow.confirm()
        #expect(rig.log.events.isEmpty)
        #expect(rig.flow.phase == .idle)
    }

    // MARK: The removal

    @Test func confirmUninstallsThenTakesTheLoginItemAwayThenShowsTheResultThenQuits() async {
        let rig = rig()
        defer { rig.suite.remove() }
        rig.flow.ask()
        let removal = Task { await rig.flow.confirm() }
        #expect(await waitUntil { rig.sleeper.requestedDurations.count == 1 }, "it waits for the result to be read")
        #expect(rig.log.events == ["uninstall", "unregister login item"], "not quit yet")
        #expect(rig.flow.phase == .finished(RemovalMessages.done))
        #expect(rig.sleeper.requestedDurations == [.seconds(6)])
        rig.sleeper.releaseAll()
        await removal.value
        #expect(rig.log.events == ["uninstall", "unregister login item", "quit"])
    }

    @Test func theResultSaysTheAppFileCanGoToTheTrashAndThePluginStays() {
        #expect(RemovalMessages.done.contains("휴지통"))
        #expect(RemovalMessages.done.contains("Claude 플러그인은 그대로"))
        #expect(RemovalMessages.done.hasPrefix("연결 설정과 중계기를 되돌렸어요"))
    }

    @Test func theUninstallCommandIsTheOnlyEngineCallAndCodexIsNeverTouched() async {
        let rig = rig()
        defer { rig.suite.remove() }
        rig.flow.ask()
        let removal = Task { await rig.flow.confirm() }
        #expect(await waitUntil { rig.sleeper.requestedDurations.count == 1 })
        rig.sleeper.releaseAll()
        await removal.value
        #expect(rig.engine.calls == [.uninstall], "no restart, no stop, no release")
    }

    @Test func aSetupThatNeverHappenedHasNothingToUndoButTheAppStillGoes() async {
        for error in [EngineError.pluginMissing, .setupNeeded(installPath: "/x")] {
            let rig = rig(uninstallError: error)
            defer { rig.suite.remove() }
            rig.flow.ask()
            let removal = Task { await rig.flow.confirm() }
            #expect(await waitUntil { rig.sleeper.requestedDurations.count == 1 })
            #expect(rig.flow.phase == .finished(RemovalMessages.nothingToUndo))
            rig.sleeper.releaseAll()
            await removal.value
            #expect(rig.log.events == ["uninstall", "unregister login item", "quit"])
        }
    }

    @Test func withoutItsCommandOnlyTheRemoversNothingInstalledCountsAsNothingToUndo() async throws {
        // The real client: the plugin is there, `codex-cua` is not, and the plugin's remover exits 1.
        for leftBehind in [false, true] {
            let home = try TempHome()
            defer { home.remove() }
            let install = try home.installPlugin()
            if leftBehind { try home.addSupportInstallation() }
            let runner = ScriptedRunner(stdout: "", exitCode: 1, stderr: "codex-cua could not complete.\n")
            let log = EventLog()
            let suite = DefaultsSuite()
            defer { suite.remove() }
            let sleeper = ManualSleeper()
            let flow = RemovalFlow(
                engine: CodexCUAEngineClient(locator: CommandLocator(home: home.url), runner: runner),
                loginItem: LoginItemRegistrar(service: LoggingLoginItem(log: log), defaults: suite.defaults),
                quit: { log.add("quit") }, sleep: sleeper.sleep)
            flow.ask()
            let removal = Task { await flow.confirm() }
            #expect(await waitUntil { flow.phase != .confirming && flow.phase != .working })
            if case .finished = flow.phase {
                // Let the result be read and the app quit, whatever the phase should have been.
                #expect(await waitUntil { sleeper.requestedDurations.count == 1 })
                sleeper.releaseAll()
            }
            await removal.value
            if leftBehind {
                #expect(flow.phase == .refused(RemovalMessages.failed), "a remover that had something to undo failed")
                #expect(log.events.isEmpty, "the login item stays and the app does not quit")
            } else {
                #expect(flow.phase == .finished(RemovalMessages.nothingToUndo))
                #expect(log.events == ["unregister login item", "quit"])
            }
            #expect(runner.calls == [.init(
                executable: "/bin/sh", arguments: [install.appendingPathComponent("setup.sh").path, "uninstall"],
                timeout: EngineTimeouts().uninstall)])
        }
    }

    @Test func aLoginItemThatCannotBeRemovedIsSaidSoInTheResult() async {
        let log = EventLog()
        let engine = FakeEngineClient()
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let stubborn = FakeLoginItem(status: .enabled)
        stubborn.unregisterFails = true
        let registrar = LoginItemRegistrar(service: stubborn, defaults: suite.defaults)
        let sleeper = ManualSleeper()
        let flow = RemovalFlow(engine: engine, loginItem: registrar, quit: { log.add("quit") }, sleep: sleeper.sleep)
        flow.ask()
        let removal = Task { await flow.confirm() }
        #expect(await waitUntil { sleeper.requestedDurations.count == 1 })
        #expect(flow.phase == .finished(RemovalMessages.done + RemovalMessages.loginItemStays))
        sleeper.releaseAll()
        await removal.value
        #expect(log.events == ["quit"])
    }

    @Test func aSecondConfirmWhileItRunsDoesNotRunItTwice() async {
        let rig = rig()
        defer { rig.suite.remove() }
        rig.flow.ask()
        let gate = AsyncGate()
        rig.engine.configure { $0.actionGate = gate }
        defer { gate.open() }
        let first = Task { await rig.flow.confirm() }
        #expect(await waitUntil { rig.engine.calls.contains(.uninstall) })
        #expect(rig.flow.phase == .working)
        await rig.flow.confirm()
        rig.flow.ask()
        rig.flow.dismiss()
        #expect(rig.flow.phase == .working, "asking or dismissing does nothing while it runs")
        gate.open()
        #expect(await waitUntil { rig.sleeper.requestedDurations.count == 1 })
        rig.sleeper.releaseAll()
        await first.value
        #expect(rig.engine.calls.filter { $0 == .uninstall }.count == 1)
    }

    @Test func onceItIsUndoneTheAppStopsReadingAStatusThatNoLongerExists() async {
        let log = EventLog()
        let engine = FakeEngineClient()
        engine.configure { $0.onUninstall = { log.add("uninstall") } }
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let registrar = LoginItemRegistrar(service: LoggingLoginItem(log: log), defaults: suite.defaults)
        let sleeper = ManualSleeper()
        let flow = RemovalFlow(
            engine: engine, loginItem: registrar, quit: { log.add("quit") }, sleep: sleeper.sleep, onRemoved: { log.add("stop reading") })
        flow.ask()
        let removal = Task { await flow.confirm() }
        #expect(await waitUntil { sleeper.requestedDurations.count == 1 })
        #expect(log.events == ["uninstall", "unregister login item", "stop reading"])
        sleeper.releaseAll()
        await removal.value
        #expect(log.events.last == "quit")
    }

    // MARK: Refusal

    @Test func aSetupThatRunsMakesItWaitInsteadOfRemovingUnderneathIt() async {
        let log = EventLog()
        let engine = FakeEngineClient()
        engine.configure { $0.onUninstall = { log.add("uninstall") } }
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let registrar = LoginItemRegistrar(service: LoggingLoginItem(log: log), defaults: suite.defaults)
        let flow = RemovalFlow(
            engine: engine, loginItem: registrar, quit: { log.add("quit") }, sleep: ManualSleeper().sleep,
            isSetupRunning: { true }, onRemoved: { log.add("stop reading") })
        flow.ask()
        await flow.confirm()
        #expect(flow.phase == .refused("연결을 설정하는 중이라 지금은 못 해요. 끝난 뒤에 다시 해 주세요"))
        #expect(log.events.isEmpty, "nothing was touched")
        #expect(engine.calls.isEmpty)
    }

    @Test func aRunningCodexHostRefusesAndNothingElseChanges() async {
        let rig = rig(uninstallError: .commandFailed(exitCode: 1, message: "A Codex host is running; quit normally before uninstalling"), status: hostRunning())
        defer { rig.suite.remove() }
        rig.flow.ask()
        await rig.flow.confirm()
        #expect(rig.flow.phase == .refused("Codex를 정상 종료한 뒤 다시 해 주세요"))
        #expect(rig.log.events == ["uninstall"], "the login item stays and the app does not quit")
        #expect(rig.sleeper.requestedDurations.isEmpty)
        #expect(rig.engine.calls == [.uninstall, .status], "it only looked at what runs; Codex is not touched")
        #expect(rig.suite.defaults.bool(forKey: LoginItemRegistrar.doneKey), "the login item's memory is kept")
    }

    @Test func theRefusalCanBeClosedAndAskedAgain() async {
        let rig = rig(uninstallError: .commandFailed(exitCode: 1, message: ""), status: hostRunning())
        defer { rig.suite.remove() }
        rig.flow.ask()
        await rig.flow.confirm()
        rig.flow.dismiss()
        #expect(rig.flow.phase == .idle)
        // Codex was quit normally; the next try works.
        rig.engine.configure { $0.uninstallError = nil }
        rig.flow.ask()
        let removal = Task { await rig.flow.confirm() }
        #expect(await waitUntil { rig.sleeper.requestedDurations.count == 1 })
        rig.sleeper.releaseAll()
        await removal.value
        #expect(rig.log.events == ["uninstall", "uninstall", "unregister login item", "quit"])
    }

    @Test func askingAgainStraightFromARefusalIsAllowed() async {
        let rig = rig(uninstallError: .commandFailed(exitCode: 1, message: ""), status: hostRunning())
        defer { rig.suite.remove() }
        rig.flow.ask()
        await rig.flow.confirm()
        rig.flow.ask()
        #expect(rig.flow.phase == .confirming)
    }

    @Test(arguments: [HostState.ready, .starting, .stopping])
    func aHostThatIsReadyStartingOrStoppingRefusesWhateverCodexReportsAsRunning(host: HostState) async {
        var status = EngineStatus()
        status.host.state = host
        status.codex.running = false
        let rig = rig(uninstallError: .commandFailed(exitCode: 1, message: ""), status: status)
        defer { rig.suite.remove() }
        rig.flow.ask()
        await rig.flow.confirm()
        #expect(rig.flow.phase == .refused(RemovalMessages.hostRunning))
    }

    @Test func anUnknownHostWithCodexRunningIsTreatedAsRunning() async {
        var status = EngineStatus()
        status.host.state = .unknown("")
        status.codex.running = true
        let rig = rig(uninstallError: .commandFailed(exitCode: 1, message: ""), status: status)
        defer { rig.suite.remove() }
        rig.flow.ask()
        await rig.flow.confirm()
        #expect(rig.flow.phase == .refused(RemovalMessages.hostRunning))
    }

    @Test func aFailureWithNoHostRunningIsTheGenericFixedLine() async {
        for status in [EngineStatus(), { () -> EngineStatus in
            var closed = EngineStatus()
            closed.host.state = .closed
            closed.codex.running = true // Codex runs without a host: a host did not refuse
            return closed
        }()] {
            let rig = rig(uninstallError: .commandFailed(exitCode: 1, message: "SECRET-STDERR token=abc"), status: status)
            defer { rig.suite.remove() }
            rig.flow.ask()
            await rig.flow.confirm()
            #expect(rig.flow.phase == .refused("앱을 지우지 못했어요 — 연결 설정은 그대로 남아 있을 수 있어요"))
            #expect(rig.log.events == ["uninstall"])
        }
    }

    @Test func aFailureWhenTheStatusCannotBeReadEitherIsTheGenericLine() async {
        let rig = rig(uninstallError: .timeout)
        defer { rig.suite.remove() }
        rig.engine.setStatusError(.timeout)
        rig.flow.ask()
        await rig.flow.confirm()
        #expect(rig.flow.phase == .refused(RemovalMessages.failed))
    }

    @Test func noMessageEverCarriesWhatACommandPrinted() async {
        let secret = "SECRET-STDERR /Users/someone/token=abc123"
        let errors: [EngineError] = [
            .commandFailed(exitCode: 1, message: secret), .launchFailed(secret), .invalidOutput(secret), .timeout,
        ]
        for error in errors {
            for status in [hostRunning(), EngineStatus()] {
                let rig = rig(uninstallError: error, status: status)
                defer { rig.suite.remove() }
                rig.flow.ask()
                await rig.flow.confirm()
                guard case .refused(let text) = rig.flow.phase else {
                    Issue.record("expected a refusal for \(error)")
                    continue
                }
                #expect(!text.contains("SECRET") && !text.contains("token") && !text.contains("/Users"))
                #expect([RemovalMessages.hostRunning, RemovalMessages.failed].contains(text))
            }
        }
    }

    // MARK: The pieces

    @Test func theHostRuleReadsTheStatesTheContractLists() {
        func status(_ host: HostState, running: Bool) -> EngineStatus {
            var status = EngineStatus()
            status.host.state = host
            status.codex.running = running
            return status
        }
        #expect(RemovalFlow.hostMayBeRunning(in: status(.ready, running: true)))
        #expect(RemovalFlow.hostMayBeRunning(in: status(.starting, running: false)))
        #expect(RemovalFlow.hostMayBeRunning(in: status(.unknown("x"), running: true)))
        #expect(!RemovalFlow.hostMayBeRunning(in: status(.unknown("x"), running: false)))
        #expect(!RemovalFlow.hostMayBeRunning(in: status(.closed, running: true)))
        #expect(!RemovalFlow.hostMayBeRunning(in: status(.missing, running: false)))
    }
}
