import Foundation
import Testing
@testable import cua_bar

/// Stands in for the process runner of the install and update flows: records every command and
/// answers through a handler, which may also change files the way the real command would.
final class StepRunner: ProcessRunning, @unchecked Sendable {
    struct Call: Equatable {
        var executable: String
        var arguments: [String]
        var timeout: Duration

        var isClaude: Bool { executable.hasSuffix("/claude") }
        /// `plugin install`, `plugin marketplace add` and the like, without what follows the verb.
        var verb: String {
            let words = arguments.count > 1 && arguments[1] == "marketplace" ? 3 : 2
            return arguments.prefix(words).joined(separator: " ")
        }
    }

    typealias Handler = @Sendable (Call) throws -> ProcessOutput

    private let lock = NSLock()
    private var recorded: [Call] = []
    private let gateFor: @Sendable (Call) -> AsyncGate?
    private let handler: Handler

    init(gateFor: @escaping @Sendable (Call) -> AsyncGate? = { _ in nil }, handler: @escaping Handler) {
        self.gateFor = gateFor
        self.handler = handler
    }

    var calls: [Call] { lock.withLock { recorded } }

    func run(_ executable: URL, arguments: [String], timeout: Duration) async throws -> ProcessOutput {
        let call = Call(executable: executable.path, arguments: arguments, timeout: timeout)
        lock.withLock { recorded.append(call) }
        await gateFor(call)?.wait()
        return try handler(call)
    }

    static func ok(_ stdout: String = #"{"success": true}"#) -> ProcessOutput {
        ProcessOutput(exitCode: 0, stdout: Data(stdout.utf8), stderr: Data())
    }

    /// A command that failed and printed something that must never be shown.
    static func failed(code: Int32 = 1) -> ProcessOutput {
        ProcessOutput(exitCode: code, stdout: Data(), stderr: Data(secretStderr.utf8))
    }

    static let secretStderr = "SECRET-STDERR /Users/someone/token=abc123"
}

final class FakeOpener: URLOpening, @unchecked Sendable {
    private let lock = NSLock()
    private var urls: [URL] = []
    var succeeds = true

    var opened: [URL] { lock.withLock { urls } }

    func open(_ url: URL) async -> Bool {
        lock.withLock { urls.append(url) }
        return succeeds
    }
}

@MainActor
struct LiveSystemActionsTests {
    /// Everything an install or update flow needs, over a throwaway home.
    private struct Rig {
        var home: TempHome
        var runner: StepRunner
        var opener: FakeOpener
        var setup: SetupActivity
        var actions: LiveSystemActions
        var claude: String

        /// The folder Claude Code's cache gives the plugin at 0.7.0.
        var pluginAt070: URL { home.url.appendingPathComponent(".claude/plugins/cache/chenjing-plugins/cua/0.7.0") }
    }

    /// - registered: the plugin version already in the registry (nil: not installed).
    /// - registers: `claude plugin install` and `update` put the plugin into the registry at 0.7.0,
    ///   in a folder per version like Claude Code's cache, as the real commands do.
    /// - responses: what each command answers; success by default.
    private func rig(
        appVersion: String? = "0.7.0",
        registered: String? = nil,
        marketplace: Bool = false,
        claudeInstalled: Bool = true,
        registers: Bool = true,
        newest: ReleaseInfo? = nil,
        gateFor: @escaping @Sendable (StepRunner.Call) -> AsyncGate? = { _ in nil },
        responses: (@Sendable (StepRunner.Call) throws -> ProcessOutput)? = nil
    ) throws -> Rig {
        let home = try TempHome()
        if let registered { try home.installPlugin(version: registered) }
        if marketplace { try home.addMarketplace() }
        let claude = home.url.appendingPathComponent(".local/bin/claude").path
        let runner = StepRunner(gateFor: gateFor) { call in
            if registers, call.isClaude, call.verb == "plugin install" || call.verb == "plugin update" {
                try home.installPlugin(version: "0.7.0")
            }
            return try responses?(call) ?? StepRunner.ok()
        }
        let opener = FakeOpener()
        let setup = SetupActivity()
        let actions = LiveSystemActions(
            locator: CommandLocator(home: home.url),
            claude: ClaudeCLILocator(home: home.url, isExecutableFile: { claudeInstalled && $0 == claude }),
            runner: runner, opener: opener, appVersion: appVersion, setup: setup, newestAppRelease: { newest })
        return Rig(home: home, runner: runner, opener: opener, setup: setup, actions: actions, claude: claude)
    }

    private func release(_ version: String) -> ReleaseInfo {
        ReleaseInfo(
            version: VersionNumber(strict: version)!, tag: "cua-bar--v\(version)",
            url: URL(string: "https://github.com/chenjingdev/chenjing-plugins/releases/tag/cua-bar--v\(version)")!)
    }

    private func setupCall(_ plugin: URL) -> StepRunner.Call {
        .init(executable: "/bin/sh", arguments: [plugin.appendingPathComponent("setup.sh").path, "setup"], timeout: EngineTimeouts().setup)
    }

    private func waitUntil(_ timeout: Double = 30, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { try? await Task.sleep(for: .milliseconds(2)) }
        return condition()
    }

    // MARK: Install (plugin_missing)

    @Test func installAddsTheMarketplaceThenInstallsThenSetsUp() async throws {
        let rig = try rig()
        defer { rig.home.remove() }
        let outcome = await rig.actions.installPlugin()
        let step: Duration = .seconds(300)
        #expect(rig.runner.calls == [
            .init(executable: rig.claude, arguments: ["plugin", "marketplace", "add", "chenjingdev/chenjing-plugins", "--json"], timeout: step),
            .init(executable: rig.claude, arguments: ["plugin", "install", "cua@chenjing-plugins", "--scope", "user", "--json"], timeout: step),
            setupCall(rig.pluginAt070),
        ])
        #expect(outcome == ActionOutcome(kind: .success, message: "새 Claude 대화부터 CUA가 붙어요"))
        #expect(rig.setup.phase == .idle)
    }

    @Test func installLeavesTheMarketplaceAloneWhenClaudeCodeKnowsIt() async throws {
        let rig = try rig(marketplace: true)
        defer { rig.home.remove() }
        let outcome = await rig.actions.installPlugin()
        #expect(rig.runner.calls == [
            .init(executable: rig.claude, arguments: ["plugin", "install", "cua@chenjing-plugins", "--scope", "user", "--json"], timeout: .seconds(300)),
            setupCall(rig.pluginAt070),
        ])
        #expect(outcome.kind == .success)
    }

    @Test func installNeedsClaudeCodeAndSaysNothingElse() async throws {
        let rig = try rig(claudeInstalled: false)
        defer { rig.home.remove() }
        let outcome = await rig.actions.installPlugin()
        #expect(outcome == ActionOutcome(kind: .failure, message: "Claude Code가 없어요"))
        #expect(rig.runner.calls.isEmpty)
    }

    @Test func installTrustsTheRegistryOverTheCommandsWord() async throws {
        // Both commands exit 0 but the plugin never shows up: that is a failed install.
        let rig = try rig(registers: false)
        defer { rig.home.remove() }
        let outcome = await rig.actions.installPlugin()
        #expect(outcome == ActionOutcome(kind: .failure, message: "플러그인을 설치하지 못했어요"))
        #expect(rig.runner.calls.allSatisfy { $0.isClaude }, "no setup for a plugin that is not there")
        #expect(rig.setup.phase == .idle)
    }

    @Test func aCommandThatPrintsNoJsonIsJudgedByItsExitCode() async throws {
        let rig = try rig(responses: { _ in StepRunner.ok("Successfully installed plugin: cua@chenjing-plugins\n") })
        defer { rig.home.remove() }
        #expect(await rig.actions.installPlugin().kind == .success)
    }

    @Test func theResultLineIsReadAndAFailureInItStopsTheFlow() async throws {
        let lines = [
            #"{"success": false, "message": "SECRET-STDERR"}"#,
            #"{"ok": false}"#,
            #"{"error": "SECRET-STDERR boom"}"#,
            #"{"status": "failed"}"#,
            "downloading...\n" + #"{"success": false}"# + "\n",
        ]
        for line in lines {
            let rig = try rig(marketplace: true, responses: { call in
                call.isClaude ? StepRunner.ok(line) : StepRunner.ok()
            })
            defer { rig.home.remove() }
            let outcome = await rig.actions.installPlugin()
            #expect(outcome == ActionOutcome(kind: .failure, message: "플러그인을 설치하지 못했어요"), "result line \(line)")
            #expect(!outcome.message.contains("SECRET"))
            #expect(rig.runner.calls.count == 1, "nothing runs after a failed step: \(line)")
        }
    }

    @Test func aGoodResultLineIsReadAsSuccess() async throws {
        for line in [#"{"success": true}"#, #"{"ok": true, "error": null}"#, #"{"error": ""}"#, #"{"status": "installed"}"#, "{}", "not json\n" + #"{"success": true}"#] {
            let rig = try rig(marketplace: true, responses: { _ in StepRunner.ok(line) })
            defer { rig.home.remove() }
            #expect(await rig.actions.installPlugin().kind == .success, "result line \(line)")
        }
    }

    // MARK: Fixed lines, never what a command printed

    @Test func everyFailingStepGivesItsOneFixedLine() async throws {
        struct Case {
            var name: String
            var failingVerb: String
            var line: String
            var run: @MainActor (LiveSystemActions) async -> ActionOutcome
            var registered: String?
            var marketplace: Bool
        }
        let cases = [
            Case(name: "marketplace add", failingVerb: "plugin marketplace add", line: "플러그인 저장소를 추가하지 못했어요",
                 run: { await $0.installPlugin() }, registered: nil, marketplace: false),
            Case(name: "install", failingVerb: "plugin install", line: "플러그인을 설치하지 못했어요",
                 run: { await $0.installPlugin() }, registered: nil, marketplace: true),
            Case(name: "marketplace update", failingVerb: "plugin marketplace update", line: "플러그인 목록을 새로 받지 못했어요",
                 run: { await $0.matchPluginVersion() }, registered: "0.5.0", marketplace: true),
            Case(name: "update", failingVerb: "plugin update", line: "플러그인을 갱신하지 못했어요",
                 run: { await $0.matchPluginVersion() }, registered: "0.5.0", marketplace: true),
        ]
        for testCase in cases {
            for exit in [Int32(1), 2, 127] {
                let rig = try rig(registered: testCase.registered, marketplace: testCase.marketplace, responses: { call in
                    call.isClaude && call.verb == testCase.failingVerb ? StepRunner.failed(code: exit) : StepRunner.ok()
                })
                defer { rig.home.remove() }
                let outcome = await testCase.run(rig.actions)
                #expect(outcome == ActionOutcome(kind: .failure, message: testCase.line), "\(testCase.name), exit \(exit)")
                #expect(!outcome.message.contains("SECRET") && !outcome.message.contains("token"))
                #expect(rig.runner.calls.last?.verb == testCase.failingVerb, "\(testCase.name) was the last thing that ran")
                #expect(rig.setup.phase == .idle, "setup was never reached")
            }
        }
    }

    @Test func aFailingSetupGivesItsFixedLineAndMarksSetupFailed() async throws {
        for call in ["install", "update"] {
            let rig = try rig(registered: call == "update" ? "0.5.0" : nil, marketplace: true, responses: { call in
                call.executable == "/bin/sh" ? StepRunner.failed() : StepRunner.ok()
            })
            defer { rig.home.remove() }
            let outcome = call == "install" ? await rig.actions.installPlugin() : await rig.actions.matchPluginVersion()
            #expect(outcome == ActionOutcome(kind: .failure, message: "플러그인은 준비됐지만 연결 설정에 실패했어요 — 다시 하기를 눌러 주세요"))
            #expect(!outcome.message.contains("SECRET"))
            #expect(rig.setup.phase == .failed, "the status card then offers 다시 하기")
        }
    }

    @Test func aStepThatCannotStartIsTheSameFixedLine() async throws {
        let cannotStart = try rig(responses: { _ in throw ProcessRunError.launchFailed("SECRET launch detail") })
        defer { cannotStart.home.remove() }
        let outcome = await cannotStart.actions.installPlugin()
        #expect(outcome == ActionOutcome(kind: .failure, message: "플러그인 저장소를 추가하지 못했어요"))
        let timedOut = try rig(marketplace: true, responses: { _ in throw ProcessRunError.timedOut })
        defer { timedOut.home.remove() }
        #expect(await timedOut.actions.installPlugin() == ActionOutcome(kind: .failure, message: "플러그인을 설치하지 못했어요"))
    }

    @Test func noFlowEverPassesAnAutoAcceptFlag() async throws {
        let install = try rig()
        let update = try rig(registered: "0.5.0", marketplace: true)
        defer { install.home.remove(); update.home.remove() }
        _ = await install.actions.installPlugin()
        _ = await update.actions.matchPluginVersion()
        let calls = install.runner.calls + update.runner.calls
        #expect(calls.count == 6)
        for call in calls {
            for flag in ["-y", "--yes", "--accept-command"] {
                #expect(!call.arguments.contains(flag), "\(call.arguments) passes \(flag)")
            }
            #expect(!call.arguments.contains { $0.hasPrefix("--accept") || $0 == "-f" || $0 == "--force" })
        }
    }

    // MARK: Update (version_mismatch)

    @Test func aPluginOlderThanTheAppIsUpdatedAndSetUp() async throws {
        let rig = try rig(registered: "0.5.0", marketplace: true)
        defer { rig.home.remove() }
        let outcome = await rig.actions.matchPluginVersion()
        let step: Duration = .seconds(300)
        #expect(rig.runner.calls == [
            .init(executable: rig.claude, arguments: ["plugin", "marketplace", "update", "chenjing-plugins", "--json"], timeout: step),
            .init(executable: rig.claude, arguments: ["plugin", "update", "cua@chenjing-plugins", "--scope", "user", "--json"], timeout: step),
            setupCall(rig.pluginAt070),
        ], "setup runs from the folder the update registered, not from the old one")
        #expect(outcome == ActionOutcome(kind: .success, message: "새 Claude 대화부터 새 판이 붙어요"))
        #expect(rig.opener.opened.isEmpty)
    }

    @Test func aPluginNewerThanTheAppOpensTheNewestAppReleaseInsteadOfRunningAnything() async throws {
        let rig = try rig(registered: "0.8.0", newest: release("0.8.0"))
        defer { rig.home.remove() }
        let outcome = await rig.actions.matchPluginVersion()
        #expect(rig.runner.calls.isEmpty, "no claude command and no setup")
        #expect(rig.opener.opened == [release("0.8.0").url])
        #expect(outcome.kind == .info)
    }

    @Test func withoutAKnownNewerReleaseTheReleasesPageIsOpened() async throws {
        for newest in [nil, release("0.7.0"), release("0.6.0")] {
            let rig = try rig(registered: "0.8.0", newest: newest)
            defer { rig.home.remove() }
            _ = await rig.actions.matchPluginVersion()
            #expect(rig.opener.opened == [ReleaseSource.releasesPage], "newest: \(String(describing: newest?.tag))")
            #expect(rig.runner.calls.isEmpty)
        }
    }

    @Test func versionsAreComparedAsNumbersWhenChoosing() async throws {
        // As text "0.10.0" < "0.9.0", which would run an update; as numbers the plugin is newer.
        let newer = try rig(appVersion: "0.9.0", registered: "0.10.0", newest: release("0.10.0"))
        defer { newer.home.remove() }
        _ = await newer.actions.matchPluginVersion()
        #expect(newer.runner.calls.isEmpty)
        #expect(newer.opener.opened == [release("0.10.0").url])

        let older = try rig(appVersion: "0.10.0", registered: "0.9.0", marketplace: true)
        defer { older.home.remove() }
        _ = await older.actions.matchPluginVersion()
        #expect(older.runner.calls.first?.verb == "plugin marketplace update")
        #expect(older.opener.opened.isEmpty)
    }

    @Test func theSameVersionHasNothingToMatch() async throws {
        let rig = try rig(registered: "0.7.0")
        defer { rig.home.remove() }
        #expect(await rig.actions.matchPluginVersion() == ActionOutcome(kind: .info, message: "앱과 플러그인 판이 이미 같아요"))
        #expect(rig.runner.calls.isEmpty)
        #expect(rig.opener.opened.isEmpty)
    }

    @Test func anUpdateNeedsClaudeCodeButOpeningAReleasePageDoesNot() async throws {
        let older = try rig(registered: "0.5.0", claudeInstalled: false)
        defer { older.home.remove() }
        #expect(await older.actions.matchPluginVersion() == ActionOutcome(kind: .failure, message: "Claude Code가 없어요"))
        #expect(older.runner.calls.isEmpty)

        let newer = try rig(registered: "0.9.0", claudeInstalled: false, newest: release("0.9.0"))
        defer { newer.home.remove() }
        #expect(await newer.actions.matchPluginVersion().kind == .info)
        #expect(newer.opener.opened == [release("0.9.0").url])
    }

    @Test func anUpdateThatChangedNothingDoesNotClaimANewVersion() async throws {
        // The marketplace has nothing newer: the registry still says 0.5.0 afterwards.
        let rig = try rig(registered: "0.5.0", marketplace: true, registers: false)
        defer { rig.home.remove() }
        let outcome = await rig.actions.matchPluginVersion()
        #expect(outcome == ActionOutcome(kind: .warning, message: "플러그인 판이 그대로예요 — 받을 수 있는 가장 새 판이 앱과 달라요"))
        #expect(rig.runner.calls.allSatisfy { $0.isClaude }, "and it sets nothing up")
    }

    @Test func anUnknownAppVersionCannotBeMatched() async throws {
        let rig = try rig(appVersion: nil, registered: "0.5.0")
        defer { rig.home.remove() }
        #expect(await rig.actions.matchPluginVersion() == ActionOutcome(kind: .failure, message: "앱 판을 알 수 없어요"))
        #expect(rig.runner.calls.isEmpty)
    }

    @Test func aRegisteredPluginWithoutAVersionIsUpdated() async throws {
        let rig = try rig(marketplace: true)
        defer { rig.home.remove() }
        try rig.home.installPlugin(version: nil)
        let outcome = await rig.actions.matchPluginVersion()
        #expect(rig.runner.calls.first?.verb == "plugin marketplace update")
        #expect(outcome.kind == .success)
    }

    // MARK: One at a time

    @Test func aSecondInstallWhileOneRunsRunsNothing() async throws {
        let gate = AsyncGate()
        let rig = try rig(marketplace: true, gateFor: { $0.verb == "plugin install" ? gate : nil })
        defer { rig.home.remove(); gate.open() }
        let first = Task { await rig.actions.installPlugin() }
        #expect(await waitUntil { rig.runner.calls.count == 1 }) // the install is stuck in the runner
        let second = await rig.actions.installPlugin()
        let update = await rig.actions.matchPluginVersion()
        #expect(second == ActionOutcome(kind: .info, message: "이미 하는 중이에요"))
        #expect(update == ActionOutcome(kind: .info, message: "이미 하는 중이에요"))
        #expect(rig.runner.calls.count == 1, "nothing started beside the first")
        gate.open()
        #expect(await first.value.kind == .success)
        #expect(rig.runner.calls.count == 2)
        // And the slot is free again afterwards.
        #expect(await rig.actions.installPlugin().kind == .success)
    }

    @Test func theSetupAtTheEndOfAFlowTakesTheSharedSetupSlot() async throws {
        let rig = try rig(marketplace: true)
        defer { rig.home.remove() }
        #expect(rig.setup.begin(), "some other setup is running")
        let outcome = await rig.actions.installPlugin()
        #expect(outcome == ActionOutcome(kind: .info, message: "이미 하는 중이에요"))
        #expect(!rig.runner.calls.contains { $0.executable == "/bin/sh" }, "no second setup beside the first")
        #expect(rig.setup.phase == .running, "the other setup keeps its slot")
    }

    @Test func theSetupSlotIsRunningWhileTheFlowsSetupRuns() async throws {
        let gate = AsyncGate()
        let rig = try rig(marketplace: true, gateFor: { $0.executable == "/bin/sh" ? gate : nil })
        defer { rig.home.remove(); gate.open() }
        let flow = Task { await rig.actions.installPlugin() }
        #expect(await waitUntil { rig.runner.calls.contains { $0.executable == "/bin/sh" } })
        #expect(rig.setup.phase == .running)
        gate.open()
        _ = await flow.value
        #expect(rig.setup.phase == .idle)
    }

    // MARK: Time

    @Test func setupGetsAtLeastFifteenMinutesAndTheOtherStepsAreBounded() async throws {
        let rig = try rig()
        defer { rig.home.remove() }
        _ = await rig.actions.installPlugin()
        let setup = try #require(rig.runner.calls.last)
        #expect(setup.executable == "/bin/sh")
        #expect(setup.timeout >= .seconds(15 * 60), "pip may be installing; a signal halfway leaves a broken environment")
        #expect(setup.timeout == EngineTimeouts().setup)
        for call in rig.runner.calls.dropLast() { #expect(call.timeout <= .seconds(600), "\(call.arguments) must not wait forever") }
    }

    // MARK: Codex download

    @Test func theCodexDownloadPageIsOpenedFromOneConstant() async throws {
        let rig = try rig()
        defer { rig.home.remove() }
        let outcome = await rig.actions.openCodexDownload()
        #expect(rig.opener.opened == [URL(string: "https://openai.com/codex/")!])
        #expect(rig.opener.opened == [ExternalPages.codexDownload])
        #expect(outcome == ActionOutcome(kind: .info, message: "Codex 받는 곳을 열었어요"))
        #expect(rig.runner.calls.isEmpty)
    }

    @Test func aPageThatCannotBeOpenedIsAFailureLine() async throws {
        let rig = try rig(registered: "0.9.0", newest: release("0.9.0"))
        defer { rig.home.remove() }
        rig.opener.succeeds = false
        #expect(await rig.actions.openCodexDownload() == ActionOutcome(kind: .failure, message: "받는 곳을 열지 못했어요"))
        #expect(await rig.actions.matchPluginVersion() == ActionOutcome(kind: .failure, message: "받는 곳을 열지 못했어요"))
    }
}
