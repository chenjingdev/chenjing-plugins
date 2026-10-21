import Foundation
import Testing
@testable import cua_bar

// The connection test: the command and how its answer is read, who may start it (the button and an install that
// changed something, nobody else), and what it leaves behind in the app.

struct ProbeClientTests {
    private func client(_ runner: ScriptedRunner) throws -> (client: CodexCUAEngineClient, home: TempHome) {
        let home = try TempHome()
        try home.writeCommand()
        return (CodexCUAEngineClient(locator: CommandLocator(home: home.url), runner: runner), home)
    }

    @Test func theTestIsOneDoctorProbeAndTheAppWaitsTenSecondsLongerThanTheEnginesOwnLimit() async throws {
        let runner = ScriptedRunner(stdout: #"{"probe": {"status": "checked"}, "status": "checked"}"#)
        let (client, home) = try client(runner)
        defer { home.remove() }
        #expect(try await client.probe(seconds: 15) == .checked)
        #expect(runner.calls == [.init(
            executable: home.command.path, arguments: ["doctor", "--probe", "--json", "--timeout", "15"], timeout: .seconds(25))])
        #expect(EngineTimeouts().probeMargin == .seconds(10))
    }

    @Test func theCommandExitsWithOneWhenTheTestDidNotPassAndItsReportIsStillRead() async throws {
        for (word, outcome) in [
            ("host_unavailable", ProbeOutcome.hostUnavailable), ("failed", .failed), ("timeout", .timeout),
            ("approval_required", .approvalRequired), ("cleanup_unconfirmed", .cleanupUnconfirmed),
            ("dependencies_missing", .dependenciesMissing), ("something_new", .other("something_new")),
        ] {
            let runner = ScriptedRunner(stdout: #"{"probe": {"status": "\#(word)"}, "status": "\#(word)"}"#, exitCode: 1)
            let (client, home) = try client(runner)
            defer { home.remove() }
            #expect(try await client.probe(seconds: 15) == outcome, "\(word)")
        }
    }

    @Test func anAnswerWithNoProbeStatusIsNotReadAndAnyOtherExitCodeIsNoAnswer() async throws {
        let unreadable = ScriptedRunner(stdout: "not json", exitCode: 0)
        let (first, home1) = try client(unreadable)
        defer { home1.remove() }
        await #expect(throws: EngineError.invalidOutput("doctor --probe")) { try await first.probe(seconds: 15) }

        let noProbe = ScriptedRunner(stdout: #"{"status": "registered"}"#, exitCode: 0)
        let (second, home2) = try client(noProbe)
        defer { home2.remove() }
        await #expect(throws: EngineError.invalidOutput("doctor --probe")) { try await second.probe(seconds: 15) }

        let crashed = ScriptedRunner(stdout: "", exitCode: 2, stderr: "Traceback")
        let (third, home3) = try client(crashed)
        defer { home3.remove() }
        await #expect(throws: EngineError.commandFailed(exitCode: 2, message: "Traceback")) { try await third.probe(seconds: 15) }

        let slow = ScriptedRunner(failing: ProcessRunError.timedOut)
        let (fourth, home4) = try client(slow)
        defer { home4.remove() }
        await #expect(throws: EngineError.timeout) { try await fourth.probe(seconds: 15) }
    }

    @Test func theWordsAreTheEnginesAndOnlyAFailedTestIsAFailure() {
        #expect(ProbeOutcome(word: "checked").isSuccess)
        let failures: [ProbeOutcome] = [.failed, .timeout, .approvalRequired, .cleanupUnconfirmed, .dependenciesMissing, .couldNotRun, .other("x")]
        #expect(failures.allSatisfy { $0.isFailure })
        #expect(!ProbeOutcome.checked.isFailure && !ProbeOutcome.hostUnavailable.isFailure, "a host that was not ready was not tested at all")
        #expect(ProbeOutcome.checked.word == "checked" && ProbeOutcome.approvalRequired.word == "approval_required")
    }

    @Test func theFailureSentenceIsAddedOnlyAfterATestThatFailed() {
        let said = "새 Claude 대화부터 CUA가 붙어요"
        #expect(ProbeMessages.attach(.failed, to: said) == "새 Claude 대화부터 CUA가 붙어요. 연결 시험이 실패했어요 — 점검 탭을 보세요")
        #expect(ProbeMessages.attach(.timeout, to: said).hasSuffix("연결 시험이 실패했어요 — 점검 탭을 보세요"))
        #expect(ProbeMessages.attach(.checked, to: said) == said)
        #expect(ProbeMessages.attach(.hostUnavailable, to: said) == said)
        #expect(ProbeMessages.attach(nil, to: said) == said)
        #expect(ProbeMessages.attach(.failed, to: "") == "연결 시험이 실패했어요 — 점검 탭을 보세요")

        let answer = ProbeMessages.attach(.failed, to: ActionOutcome(kind: .success, message: said))
        #expect(answer.kind == .warning && answer.message == "새 Claude 대화부터 CUA가 붙어요. 연결 시험이 실패했어요 — 점검 탭을 보세요")
        #expect(ProbeMessages.attach(.failed, to: ActionOutcome(kind: .failure, message: "x")).kind == .failure)
        #expect(ProbeMessages.attach(.checked, to: ActionOutcome(kind: .success, message: said)) == ActionOutcome(kind: .success, message: said))
    }

    @Test func aNotificationGetsTheSentenceAfterItsBodyAndNothingElseChanges() {
        let updated = AppNotification.updated(VersionNumber(0, 8, 0))
        let failed = updated.appending(probe: .failed)
        #expect(failed.body == updated.body + ". 연결 시험이 실패했어요 — 점검 탭을 보세요")
        #expect(failed.key == updated.key)
        #expect(failed.title == updated.title)
        #expect(failed.kind == updated.kind)
        #expect(failed.buttons == updated.buttons)
        #expect(updated.appending(probe: .checked) == updated)
        #expect(updated.appending(probe: nil) == updated)
    }
}

@MainActor
struct ProbeModelTests {
    private func ready() throws -> EngineStatus {
        var status = try Fixtures.status("status-ready")
        status.engine.version = "0.7.0"
        return status
    }

    private func codexOff() throws -> EngineStatus {
        var status = try ready()
        status.codex.running = false
        status.codex.pids = []
        status.host.state = .closed
        return status
    }

    private func probes(_ engine: FakeEngineClient) -> [FakeEngineClient.Call] {
        engine.calls.filter { if case .probe = $0 { true } else { false } }
    }

    // MARK: Nobody starts it by reading

    @Test func readingTheStatusOpeningThePopoverAndTheTabNeverRunATest() async throws {
        let rig = await Rig(try ready())
        rig.model.setPopoverOpen(true)
        await rig.model.refresh()
        rig.model.selectedTab = .check
        _ = rig.model.checkContent
        await rig.model.refresh()
        await rig.model.waitForBackgroundWork()
        #expect(probes(rig.engine).isEmpty, "only the button and an install that changed something test")
        #expect(rig.model.lastProbe == nil)
    }

    @Test func openingTheTabAsksTheEngineAndTheSystemForNothing() async throws {
        let rig = await Rig(try ready())
        let before = rig.engine.calls.count
        rig.model.selectedTab = .check
        for _ in 0..<5 { _ = rig.model.checkContent }
        #expect(rig.engine.calls.count == before, "the lines are judged from what the status read already gave")
        #expect(rig.opener.openedPaths.isEmpty && rig.pasteboard.copied.isEmpty)
    }

    @Test func theInspectionNamesWhereClaudeCodeWasFound() throws {
        let home = try TempHome()
        defer { home.remove() }
        try home.installClaudeCode()
        let found = ClaudeIntegration(home: home.url, claude: ClaudeCLILocator(home: home.url), runner: ScriptedRunner())
            .inspect(launcher: nil, skillSource: nil, appVersion: "0.7.0")
        #expect(found.claudeCodeFound && found.claudeCodePath == home.claudeCLI.path)
        let absent = ClaudeIntegration(
            home: home.url, claude: ClaudeCLILocator(home: home.url, isExecutableFile: { _ in false }, namesInFolder: { _ in [] }),
            runner: ScriptedRunner()).inspect(launcher: nil, skillSource: nil, appVersion: "0.7.0")
        #expect(!absent.claudeCodeFound && absent.claudeCodePath == nil)
    }

    // MARK: The button

    @Test func theButtonRunsOneTestAgainstAReadyHostAndTheLineKeepsTheResultAndItsTime() async throws {
        let rig = await Rig(try ready())
        rig.model.selectedTab = .check
        let outcome = await rig.model.perform(.runProbe)
        #expect(probes(rig.engine) == [.probe(seconds: 15)])
        #expect(outcome == ActionOutcome(kind: .success, message: "연결 시험을 통과했어요"))
        #expect(rig.model.lastProbe == ProbeRecord(outcome: .checked, at: rig.clock.now))
        let line = try #require(rig.model.checkContent.line(.host))
        #expect(line.detail == "연결 시험을 통과했어요 · 12:00")
        // It answers on its own line, not in the banner.
        #expect(rig.model.placedResults[.check(.host)] == outcome)
        #expect(rig.model.banner == nil)
        #expect(rig.model.isProbing == false)
        // And nothing was started, stopped or released for it.
        #expect(rig.actionCalls == [.probe(seconds: 15)])
    }

    @Test func aTestThatIsRunningIsNotStartedAgainByAnotherPress() async throws {
        let rig = await Rig(try ready())
        let gate = AsyncGate()
        rig.engine.configure { $0.probeGate = gate }
        defer { gate.open() }
        rig.model.selectedTab = .check
        let first = rig.model.send(.runProbe)
        #expect(await yieldUntil { rig.model.isProbing })
        // While it runs the line shows the wait and the button is off.
        let waiting = try #require(rig.model.checkContent.line(.host))
        #expect(waiting.detail == "연결 시험을 하는 중이에요…" && waiting.button?.isEnabled == false)
        let second = await rig.model.perform(.runProbe)
        #expect(second.message == "이미 하는 중이에요")
        gate.open()
        await first?.value
        #expect(probes(rig.engine).count == 1, "one test, however many presses")
        #expect(rig.model.isProbing == false)
        #expect(rig.model.checkContent.line(.host)?.button?.isEnabled == true)
    }

    @Test func aTestRunningAfterAnInstallIsNotJoinedByAPressAndThePressDoesNotStartAnother() async throws {
        let rig = await Rig(try ready())
        let gate = AsyncGate()
        rig.engine.configure { $0.probeGate = gate }
        defer { gate.open() }
        let afterInstall = Task { await rig.model.probeAfterInstall() }
        #expect(await yieldUntil { rig.model.isProbing })
        let pressed = await rig.model.perform(.runProbe)
        #expect(pressed.message == "이미 하는 중이에요" || pressed.message == "이미 시험하는 중이에요")
        gate.open()
        #expect(await afterInstall.value == .checked)
        #expect(probes(rig.engine).count == 1)
    }

    @Test func withCodexOffThePressRunsNothingAndSaysWhenItTurnsOn() async throws {
        let rig = await Rig(try codexOff())
        let outcome = await rig.model.perform(.runProbe)
        #expect(outcome.kind == .info)
        #expect(outcome.message == "Codex가 꺼져 있어 시험하지 않았어요 — Claude 대화를 열면 켜져요")
        #expect(probes(rig.engine).isEmpty, "the engine is not even asked: a Codex that is off is never turned on for a test")
        #expect(rig.actionCalls.isEmpty)
        #expect(rig.opener.openedPaths.isEmpty, "and the app opens nothing")
        #expect(rig.model.lastProbe == nil)
    }

    @Test func aHostThatIsStartingIsNotTestedEither() async throws {
        var status = try ready()
        status.host.state = .starting
        let rig = await Rig(status)
        _ = await rig.model.perform(.runProbe)
        #expect(probes(rig.engine).isEmpty)
    }

    @Test func eachEndOfATestIsKeptAsItIsAndAnAnswerThatCannotBeReadIsNotATimeout() async throws {
        let cases: [(Result<ProbeOutcome, EngineError>, ProbeOutcome, ActionOutcome.Kind)] = [
            (.success(.failed), .failed, .failure),
            (.success(.timeout), .timeout, .failure),
            (.success(.approvalRequired), .approvalRequired, .warning),
            (.failure(.timeout), .timeout, .failure),
            (.failure(.launchFailed("x")), .couldNotRun, .failure),
            (.failure(.commandFailed(exitCode: 2, message: "SECRET /Users/x")), .couldNotRun, .failure),
            (.failure(.invalidOutput("doctor --probe")), .couldNotRun, .failure),
        ]
        for (answer, expected, kind) in cases {
            let rig = await Rig(try ready())
            rig.engine.configure { $0.probe = answer }
            let outcome = await rig.model.perform(.runProbe)
            #expect(rig.model.lastProbe?.outcome == expected, "\(answer)")
            #expect(outcome.kind == kind && outcome.message == expected.summary, "\(answer)")
            #expect(!outcome.message.contains("SECRET"), "nothing a command printed is shown")
            #expect(rig.model.checkContent.line(.host)?.status == .problem)
        }
    }

    // MARK: After an install

    @Test func afterAnInstallTheHostIsAskedAboutAgainAndTestedOnlyWhenItIsReady() async throws {
        let rig = await Rig(try ready())
        #expect(await rig.model.probeAfterInstall() == .checked)
        #expect(probes(rig.engine) == [.probe(seconds: 15)])
        #expect(rig.model.lastProbe?.outcome == .checked, "the tab shows it afterwards")

        var starting = try ready()
        starting.host.state = .starting
        for status in [try codexOff(), starting] {
            let other = await Rig(status)
            #expect(await other.model.probeAfterInstall() == nil)
            #expect(probes(other.engine).isEmpty)
        }
        let unreadable = await Rig(try ready())
        unreadable.engine.setStatusError(.timeout)
        #expect(await unreadable.model.probeAfterInstall() == nil)
        #expect(probes(unreadable.engine).isEmpty)
    }

    // MARK: Copy

    @Test func copyingACommandPutsItOnThePasteboardAndRunsNothing() async throws {
        let rig = await Rig(try ready())
        rig.model.selectedTab = .check
        let outcome = await rig.model.perform(.copyCommand("claude mcp remove -s user cua", on: .mcp))
        #expect(rig.pasteboard.copied == ["claude mcp remove -s user cua"])
        #expect(outcome == ActionOutcome(kind: .success, message: "명령을 복사했어요"))
        #expect(rig.model.placedResults[.check(.mcp)] == outcome, "told on the line of the command")
        #expect(rig.actionCalls.isEmpty)
    }

    @Test func aCopyOnATabThatIsNotShownIsToldInTheBanner() async throws {
        let rig = await Rig(try ready())
        rig.model.selectedTab = .connections
        await rig.model.perform(.copyCommand("x", on: .skill))
        #expect(rig.model.banner?.outcome.message == "명령을 복사했어요")
    }

    // MARK: The diagnosis

    @Test func theCopiedDiagnosisCarriesTheCheckLinesBetweenTheEnginesTextAndTheNotificationLine() async throws {
        let rig = await Rig(try ready())
        rig.engine.configure { $0.diagnosis = "CUA diagnosis\nhost: ready\n" }
        await rig.model.perform(.runProbe)
        await rig.model.perform(.copyDiagnosis)
        let copied = try #require(rig.pasteboard.copied.last)
        let lines = copied.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        #expect(lines.first == "CUA diagnosis" && lines[1] == "host: ready")
        let check = lines.filter { $0.hasPrefix("점검 ") }
        #expect(check.count == 9)
        #expect(check.map { $0.components(separatedBy: ":").first } == CheckItem.allCases.map { "점검 \($0.title)" })
        #expect(check.last == "점검 Codex 호스트와 연결 시험: 정상 — 켜져 있음, 연결 시험 checked 12:00")
        #expect(lines.drop { !$0.hasPrefix("점검 ") }.dropFirst(9).first == "알림: 켜짐")
        // The names and states only: not a connection, a screen or a request.
        #expect(!check.joined().contains("019a1b2c"), "no session id")
        #expect(!check.joined().contains("computer-use"), "no working folder")
    }

    // MARK: The login environment is read only while it is a conflict or stale

    @Test func launchdIsAskedOnlyWhileTheLoginEnvironmentIsAConflictOrStale() async throws {
        let asked = Counter()
        func model(_ engine: FakeEngineClient) -> CUABarViewModel {
            CUABarViewModel(
                engine: engine, appVersion: "0.7.0", clock: { Fixtures.now }, calendar: Fixtures.utc,
                loginEnvironmentReader: {
                    asked.increment()
                    return LoginEnvironmentReading(agentLabel: nil, launchdValue: "/opt/other/codex-wrapper.sh")
                },
                appLauncherValue: "/Users/x/.local/share/codex-cua/start-desktop-cli.sh")
        }
        let fine = model(FakeEngineClient(status: try ready()))
        await fine.refresh()
        #expect(asked.value == 0 && fine.loginEnvironment == nil)

        var conflict = try ready()
        conflict.setup.loginEnvironment = "conflict"
        let engine = FakeEngineClient(status: conflict)
        let conflicted = model(engine)
        await conflicted.refresh()
        #expect(asked.value == 1)
        #expect(conflicted.loginEnvironment == LoginEnvironmentReading(agentLabel: nil, launchdValue: "/opt/other/codex-wrapper.sh"))
        #expect(conflicted.checkContent.line(.wrapper)?.steps.first == "launchd의 CODEX_CLI_PATH가 다른 값이에요: /opt/other/codex-wrapper.sh")
        #expect(conflicted.summary.problem?.kind == .loginEnvironmentConflict)

        // The conflict is gone: the reading goes with it.
        engine.setStatus(try ready())
        await conflicted.refresh()
        #expect(conflicted.loginEnvironment == nil && asked.value == 1)
    }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func increment() { lock.withLock { count += 1 } }
    var value: Int { lock.withLock { count } }
}

// MARK: - Reading the login environment

struct LoginEnvironmentReaderTests {
    private func plist(label: String) -> String {
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict><key>Label</key><string>\(label)</string><key>RunAtLoad</key><true/></dict></plist>
        """
    }

    @Test func anAgentFileWithAnotherLabelIsSomebodyElsesAndItsLabelIsRead() async throws {
        let home = try TempHome()
        defer { home.remove() }
        let reader = LoginEnvironmentReader(home: home.url, runner: ScriptedRunner(stdout: "", exitCode: 1))
        #expect(await reader.read().agentLabel == nil, "no file")
        try home.write(plist(label: "com.chenjingdev.codex-cua.env"), to: reader.agentFile)
        #expect(await reader.read().agentLabel == nil, "the app's own label")
        try home.write(plist(label: "com.other.thing"), to: reader.agentFile)
        #expect(await reader.read().agentLabel == "com.other.thing")
        try home.write("not a plist", to: reader.agentFile)
        #expect(await reader.read().agentLabel == nil)
    }

    @Test func launchdIsOnlyAskedForTheOneValueAndNothingIsSetOrUnset() async throws {
        let home = try TempHome()
        defer { home.remove() }
        let runner = ScriptedRunner(stdout: "/opt/other/codex-wrapper.sh\n")
        let reading = await LoginEnvironmentReader(home: home.url, runner: runner).read()
        #expect(reading.launchdValue == "/opt/other/codex-wrapper.sh")
        #expect(runner.calls.map(\.arguments) == [["getenv", "CODEX_CLI_PATH"]])
        #expect(runner.calls.first?.executable == "/bin/launchctl")
        #expect(LoginEnvironmentReader(home: home.url).appLauncherValue == home.url.appendingPathComponent(".local/share/codex-cua/start-desktop-cli.sh").path)
    }

    @Test func nothingSetOrACommandThatFailsIsNoValue() async throws {
        let home = try TempHome()
        defer { home.remove() }
        #expect(await LoginEnvironmentReader(home: home.url, runner: ScriptedRunner(stdout: "\n")).read().launchdValue == nil)
        #expect(await LoginEnvironmentReader(home: home.url, runner: ScriptedRunner(stdout: "/x", exitCode: 1)).read().launchdValue == nil)
        #expect(await LoginEnvironmentReader(home: home.url, runner: ScriptedRunner(failing: ProcessRunError.timedOut)).read().launchdValue == nil)
    }
}

@MainActor
struct LoginItemReadingTests {
    @Test func theRegistrarSaysWhatBecameOfTheLoginItemAndTheLineKeepsItsWords() {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let service = FakeLoginItem(status: .enabled)
        let registrar = LoginItemRegistrar(
            service: service, defaults: suite.defaults, bundleURL: URL(fileURLWithPath: "/Applications/CUABar.app"),
            home: URL(fileURLWithPath: "/Users/someone"))
        #expect(registrar.reading.health == .enabled && registrar.line == "로그인 때 자동 실행: 켜짐")
        service.set(.requiresApproval)
        registrar.refresh()
        #expect(registrar.reading.health == .requiresApproval)
        #expect(registrar.line == "로그인 때 자동 실행: 승인이 필요해요 (시스템 설정 > 일반 > 로그인 항목)")
        service.set(.notRegistered)
        registrar.refresh()
        #expect(registrar.reading.health == .notRegistered)
        suite.defaults.set(true, forKey: LoginItemRegistrar.doneKey)
        registrar.refresh()
        #expect(registrar.reading.health == .turnedOff, "the person turned it off, which is respected")
    }
}

// MARK: - After an install that changed something

@MainActor
struct InstallProbeTests {
    private let live = LiveSystemActionsTests()

    private final class Hook: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        private var seenCalls: [Int] = []
        var answer: ProbeOutcome?
        let runner: @Sendable () -> Int

        init(answer: ProbeOutcome?, runner: @escaping @Sendable () -> Int) {
            self.answer = answer
            self.runner = runner
        }

        var calls: Int { lock.withLock { count } }
        /// How many commands the install had run when the test was asked for.
        var commandsBefore: [Int] { lock.withLock { seenCalls } }

        func run() -> ProbeOutcome? {
            lock.withLock {
                count += 1
                seenCalls.append(runner())
            }
            return answer
        }
    }

    private func hook(for rig: LiveSystemActionsTests.Rig, answer: ProbeOutcome?) -> Hook {
        let runner = rig.runner
        let hook = Hook(answer: answer) { runner.calls.count }
        rig.actions.setAfterChange { hook.run() }
        return hook
    }

    @Test func anInstallThatChangedSomethingTestsOnceAfterItsLastCommandAndTheFailureIsInTheSameSentence() async throws {
        let rig = try live.rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        let hook = hook(for: rig, answer: .failed)
        let outcome = await rig.actions.setUp()
        #expect(hook.calls == 1)
        #expect(hook.commandsBefore == [rig.runner.calls.count], "the test comes after everything the install ran")
        #expect(outcome.message == "새 Claude 대화부터 CUA가 붙어요. 연결 시험이 실패했어요 — 점검 탭을 보세요")
        #expect(outcome.kind == .warning)
    }

    @Test func aTestThatPassedOrWasNotRunLeavesTheInstallsWordsAsTheyAre() async throws {
        for answer in [ProbeOutcome.checked, nil, .hostUnavailable] {
            let rig = try live.rig()
            defer { rig.home.remove() }
            try rig.home.installClaudeCode()
            let hook = hook(for: rig, answer: answer)
            let outcome = await rig.actions.setUp()
            #expect(hook.calls == 1, "\(String(describing: answer))")
            #expect(outcome == ActionOutcome(kind: .success, message: "새 Claude 대화부터 CUA가 붙어요"))
        }
    }

    @Test func aRunThatChangedNothingTestsNothing() async throws {
        let rig = try live.rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        rig.engine.setStatus(try live.currentEngine(rig.home).get())
        try rig.home.addMcp(command: rig.launcher)
        try rig.home.addSkill(version: "0.7.0", body: rig.skillSourceBody)
        let hook = hook(for: rig, answer: .failed)
        let outcome = await rig.actions.setUp()
        #expect(hook.calls == 0, "almost every start: nothing changed, nothing is tested")
        #expect(outcome == InstallMessages.nothingToSay)
    }

    @Test func anInstallWithoutClaudeCodeThatOnlyPutTheEngineInStillTestsOnce() async throws {
        let rig = try live.rig(claudeInstalled: false)
        defer { rig.home.remove() }
        let hook = hook(for: rig, answer: .timeout)
        let outcome = await rig.actions.setUp()
        #expect(hook.calls == 1)
        #expect(outcome.message == "연결 설정을 마쳤어요. 연결 시험이 실패했어요 — 점검 탭을 보세요")
    }

    @Test func aRunThatDidNothingBecauseCodexIsMissingTestsNothing() async throws {
        let rig = try live.rig(codexInstalled: false)
        defer { rig.home.remove() }
        let hook = hook(for: rig, answer: .failed)
        _ = await rig.actions.setUp()
        #expect(hook.calls == 0)
    }

    @Test func aBuildOutsideTheBundleInstallsAndTestsNothing() async throws {
        let rig = try live.rig(bundled: false)
        defer { rig.home.remove() }
        let hook = hook(for: rig, answer: .failed)
        _ = await rig.actions.setUp()
        #expect(hook.calls == 0)
    }

    @Test func theInstallAndItsTestAreAlsoGivenApartForTheOneWhoTellsTheNews() async throws {
        let rig = try live.rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        let hook = hook(for: rig, answer: .failed)
        let done = await rig.actions.setUpAndTest()
        #expect(done.outcome == ActionOutcome(kind: .success, message: "새 Claude 대화부터 CUA가 붙어요"), "the install's own words")
        #expect(done.probe == .failed)
        #expect(hook.calls == 1)
        let sentence = ProbeMessages.attach(done.probe, to: done.outcome.message)
        #expect(sentence == "새 Claude 대화부터 CUA가 붙어요. 연결 시험이 실패했어요 — 점검 탭을 보세요")
    }

    @Test func aSecondInstallWhileOneRunsIsBusyAndTestsNothing() async throws {
        let gate = AsyncGate()
        let rig = try live.rig(gateFor: { $0.isInstallEngine ? gate : nil })
        defer { rig.home.remove(); gate.open() }
        try rig.home.installClaudeCode()
        let hook = hook(for: rig, answer: .failed)
        let first = Task { await rig.actions.setUpAndTest() }
        #expect(await yieldUntil { rig.runner.calls.contains { $0.isInstallEngine } })
        let second = await rig.actions.setUpAndTest()
        #expect(second.outcome.message == "이미 하는 중이에요" && second.probe == nil)
        gate.open()
        _ = await first.value
        #expect(hook.calls == 1)
    }

    @Test func withoutAHookAnInstallSaysWhatItSaidBefore() async throws {
        let rig = try live.rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        let outcome = await rig.actions.setUp()
        #expect(outcome == ActionOutcome(kind: .success, message: "새 Claude 대화부터 CUA가 붙어요"))
    }
}
