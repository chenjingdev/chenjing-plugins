import Foundation
import Testing
@testable import cua_bar

/// Stands in for the process runner of the install: records every command and answers through a handler,
/// which may also change files the way the real command would.
final class StepRunner: ProcessRunning, @unchecked Sendable {
    struct Call: Equatable {
        var executable: String
        var arguments: [String]
        var timeout: Duration

        var isClaude: Bool { executable.hasSuffix("/claude") }
        var isDeveloperToolsCheck: Bool { executable == "/usr/bin/xcode-select" && arguments == ["-p"] }
        var isInstallEngine: Bool { executable == "/bin/sh" && arguments.dropFirst().first == "install-engine" }
    }

    typealias Handler = @Sendable (Call) throws -> ProcessOutput

    private let lock = NSLock()
    private var recorded: [Call] = []
    /// What each call that asked for folders in front of PATH asked for, with its executable.
    private var recordedPathFirst: [(String, [String])] = []
    private let gateFor: @Sendable (Call) -> AsyncGate?
    private let handler: Handler

    init(gateFor: @escaping @Sendable (Call) -> AsyncGate? = { _ in nil }, handler: @escaping Handler) {
        self.gateFor = gateFor
        self.handler = handler
    }

    var calls: [Call] { lock.withLock { recorded } }

    var pathFirst: [(String, [String])] { lock.withLock { recordedPathFirst } }

    func run(_ executable: URL, arguments: [String], timeout: Duration) async throws -> ProcessOutput {
        let call = Call(executable: executable.path, arguments: arguments, timeout: timeout)
        lock.withLock { recorded.append(call) }
        await gateFor(call)?.wait()
        return try handler(call)
    }

    func run(_ executable: URL, arguments: [String], timeout: Duration, pathFirst: [String]) async throws -> ProcessOutput {
        lock.withLock { recordedPathFirst.append((executable.path, pathFirst)) }
        return try await run(executable, arguments: arguments, timeout: timeout)
    }

    static func ok(_ stdout: String = "") -> ProcessOutput {
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

/// A thing that is there or not, which a test turns on and off between two looks.
final class Presence: @unchecked Sendable {
    private let lock = NSLock()
    private var present: Bool
    init(_ present: Bool) { self.present = present }
    var isThere: Bool {
        get { lock.withLock { present } }
        set { lock.withLock { present = newValue } }
    }
}

@MainActor
struct LiveSystemActionsTests {
    /// Everything the install needs, over a throwaway home and an engine in a throwaway "bundle".
    struct Rig {
        var home: TempHome
        var codex: Presence
        var claudeCode: Presence
        var runner: StepRunner
        var opener: FakeOpener
        var setup: SetupActivity
        var engine: FakeEngineClient
        var actions: LiveSystemActions
        var claude: ClaudeIntegration
        var bundle: BundledEngine
        /// Where an update leaves its mark for the app that starts after it.
        var notice: UpdateNotice
        /// What the install posted as a notification.
        var announcements: Announcements

        var claudePath: String { home.claudeCLI.path }
        var launcher: String { home.launcher }
        var installEngineCall: StepRunner.Call {
            .init(executable: "/bin/sh", arguments: [bundle.setupScript.path, "install-engine", "--json"], timeout: EngineTimeouts().setup)
        }
        var developerToolsCheck: StepRunner.Call {
            .init(executable: "/usr/bin/xcode-select", arguments: ["-p"], timeout: .seconds(30))
        }
        func mcpAdd(_ command: String? = nil) -> StepRunner.Call {
            .init(executable: claudePath, arguments: ["mcp", "add", "-s", "user", "cuabar", "--", command ?? launcher], timeout: .seconds(120))
        }
        var mcpRemove: StepRunner.Call {
            .init(executable: claudePath, arguments: ["mcp", "remove", "-s", "user", "cuabar"], timeout: .seconds(120))
        }
        var skillSourceBody: String { (try? String(contentsOf: bundle.skillSource, encoding: .utf8)) ?? "" }
    }

    /// - engine: the status the engine answers with (an error: no engine); a current one says the app's version.
    /// - responses: what a command answers instead of the default (the stand-ins for `claude mcp add` and
    ///   `remove` write `~/.claude.json` the way the real ones do).
    func rig(
        appVersion: String? = "0.7.0",
        codexInstalled: Bool = true,
        developerTools: Bool = true,
        claudeInstalled: Bool = true,
        bundled: Bool = true,
        engine status: Result<EngineStatus, EngineError> = .failure(.engineMissing),
        installPrints: String? = nil,
        installedSetup: String = #"{"command": "ready"}"#,
        gateFor: @escaping @Sendable (StepRunner.Call) -> AsyncGate? = { _ in nil },
        responses: (@Sendable (StepRunner.Call) throws -> ProcessOutput?)? = nil
    ) throws -> Rig {
        let home = try TempHome()
        let bundleRoot = home.url.appendingPathComponent("Bundle/engine", isDirectory: true)
        try home.write("#!/bin/sh\nexit 0\n", to: bundleRoot.appendingPathComponent("setup.sh"))
        try home.write("the bundled skill\n", to: bundleRoot.appendingPathComponent("skills/cuabar/SKILL.md"))
        let bundle = BundledEngine(root: bundleRoot)
        let launcher = home.launcher
        let claudePath = home.claudeCLI.path
        let printed = installPrints ?? #"{"version": "0.7.0", "root": "/x/engine/0.7.0", "removed": [], "launcher": "\#(launcher)", "setup": \#(installedSetup)}"#
        let runner = StepRunner(gateFor: gateFor) { call in
            if let answer = try responses?(call) { return answer }
            if call.isDeveloperToolsCheck { return developerTools ? StepRunner.ok("/Library/Developer/CommandLineTools\n") : StepRunner.failed(code: 2) }
            if call.isInstallEngine { return StepRunner.ok(printed + "\n") }
            if call.executable == claudePath, call.arguments.starts(with: ["mcp", "add"]), let command = call.arguments.last {
                try home.addMcp(command: command)
            }
            if call.executable == claudePath, call.arguments.starts(with: ["mcp", "remove"]) {
                try home.writeClaudeConfig(["numStartups": 7, "mcpServers": [String: Any]()])
            }
            return StepRunner.ok()
        }
        let fake = FakeEngineClient()
        switch status {
        case .success(let value): fake.setStatus(value)
        case .failure(let error): fake.setStatusError(error)
        }
        let claudeCode = Presence(claudeInstalled)
        let codex = Presence(codexInstalled)
        let claude = ClaudeIntegration(
            home: home.url, claude: ClaudeCLILocator(home: home.url, isExecutableFile: { claudeCode.isThere && $0 == claudePath }), runner: runner)
        let opener = FakeOpener()
        let setup = SetupActivity()
        let notice = UpdateNotice(home: home.url)
        let announcements = Announcements()
        let actions = LiveSystemActions(
            claude: claude, engine: fake, runner: runner, opener: opener, bundle: bundled ? bundle : nil, appVersion: appVersion, setup: setup,
            codex: CodexLocator(home: home.url, environment: [:], isCodexBundle: { _ in codex.isThere }), updateNotice: notice,
            announce: announcements.post)
        return Rig(
            home: home, codex: codex, claudeCode: claudeCode, runner: runner, opener: opener, setup: setup, engine: fake, actions: actions,
            claude: claude, bundle: bundle, notice: notice, announcements: announcements)
    }

    /// A status of an engine that is the app's.
    func currentEngine(_ home: TempHome, version: String = "0.7.0") -> Result<EngineStatus, EngineError> {
        var status = EngineStatus()
        status.engine = EngineInfo(version: version, root: "/x/engine/\(version)", launcher: home.launcher)
        return .success(status)
    }

    private func waitUntil(_ timeout: Double = 30, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { try? await Task.sleep(for: .milliseconds(2)) }
        return condition()
    }

    // MARK: The first install

    @Test func aFirstInstallUnpacksTheEngineThenPutsTheMCPServerAndTheSkillIntoClaudeCode() async throws {
        let rig = try rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        let outcome = await rig.actions.setUp()
        #expect(rig.runner.calls == [rig.developerToolsCheck, rig.installEngineCall, rig.mcpAdd()])
        #expect(rig.claude.mcpState(launcher: rig.launcher) == .ready)
        #expect(rig.claude.skillState(source: rig.bundle.skillSource, appVersion: "0.7.0") == .ready)
        #expect(try String(contentsOf: rig.home.skillFolder.appendingPathComponent("SKILL.md"), encoding: .utf8) == rig.skillSourceBody)
        #expect(outcome == ActionOutcome(kind: .success, message: "새 Claude 대화부터 CUA가 붙어요"))
        #expect(rig.setup.phase == .idle)
        #expect(rig.setup.waitingFor.isEmpty && !rig.setup.developerToolsNeeded)
    }

    @Test func theEngineIsInstalledWithShNeverTheBundlesScriptDirectlyAndGetsTimeForPackages() async throws {
        let rig = try rig()
        defer { rig.home.remove() }
        _ = await rig.actions.setUp()
        let install = try #require(rig.runner.calls.first { $0.isInstallEngine })
        #expect(install.executable == "/bin/sh")
        #expect(install.arguments == [rig.bundle.setupScript.path, "install-engine", "--json"])
        #expect(install.timeout >= .seconds(15 * 60), "pip may be installing; a signal halfway leaves a broken environment")
        #expect(install.timeout == EngineTimeouts().setup)
        #expect(LiveSystemActions.Timeouts().engineInstall >= .seconds(15 * 60))
        #expect(rig.runner.calls.allSatisfy { !$0.arguments.contains("-y") && !$0.arguments.contains("--yes") })
    }

    @Test func theMCPServerIsAddedForTheUserWithTheOneLauncherAndNoArguments() async throws {
        let rig = try rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        _ = await rig.actions.setUp()
        let add = try #require(rig.runner.calls.first { $0.isClaude })
        #expect(add.arguments == ["mcp", "add", "-s", "user", "cuabar", "--", rig.home.engineCopies.appendingPathComponent("current/start-mcp.sh").path])
        #expect(!rig.runner.calls.contains { $0.isClaude && ($0.arguments.contains("list") || $0.arguments.contains("get")) }, "those start the servers")
    }

    @Test func aLauncherTheInstallDoesNotNameIsAskedOfTheStatusAndThenTheDefaultIsUsed() async throws {
        let named = try rig(installPrints: #"{"version": "0.7.0", "root": "/x/engine/0.7.0"}"#)
        defer { named.home.remove() }
        try named.home.installClaudeCode()
        var status = EngineStatus()
        status.engine.launcher = "/custom/home/.local/share/codex-cua/engine/current/start-mcp.sh"
        named.engine.setStatus(status)
        // The engine is not the app's (no version), so it is installed; then the status names the launcher.
        _ = await named.actions.setUp()
        #expect(named.runner.calls.contains(named.mcpAdd("/custom/home/.local/share/codex-cua/engine/current/start-mcp.sh")))

        let silent = try rig(installPrints: "no json at all")
        defer { silent.home.remove() }
        try silent.home.installClaudeCode()
        _ = await silent.actions.setUp()
        #expect(silent.runner.calls.contains(silent.mcpAdd(silent.home.launcher)), "nobody said: <home>/.local/share/codex-cua/engine/current/start-mcp.sh")
    }

    // MARK: Looking first, changing only what needs it

    @Test func whenEverythingIsCurrentNothingIsChangedAndNothingIsSaid() async throws {
        let rig = try rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        rig.engine.setStatus(try currentEngine(rig.home).get())
        try rig.home.addMcp(command: rig.launcher)
        try rig.home.addSkill(version: "0.7.0", body: rig.skillSourceBody)
        let outcome = await rig.actions.setUp()
        #expect(rig.runner.calls == [rig.developerToolsCheck], "only looked")
        #expect(outcome == InstallMessages.nothingToSay)
        #expect(outcome.message.isEmpty, "no banner at every launch")
        #expect(rig.setup.phase == .idle)
    }

    @Test func anEngineOfAnotherVersionIsInstalledAgainButTheMCPServerIsNotRegisteredAgain() async throws {
        let rig = try rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        rig.engine.setStatus(try currentEngine(rig.home, version: "0.6.0").get())
        try rig.home.addMcp(command: rig.launcher)
        try rig.home.addSkill(version: "0.7.0", body: rig.skillSourceBody)
        let outcome = await rig.actions.setUp()
        #expect(rig.runner.calls == [rig.developerToolsCheck, rig.installEngineCall], "the launcher is the same whatever the version")
        #expect(outcome == ActionOutcome(kind: .success, message: "새 Claude 대화부터 CUA가 붙어요"))
    }

    @Test(arguments: [EngineError.engineMissing, .setupNeeded(installPath: "/x"), .commandFailed(exitCode: 2, message: "usage"), .launchFailed("x"),
                      .invalidOutput("x"), .unsupportedSchema(2)])
    func everyKindOfBrokenOrMissingEngineIsInstalled(error: EngineError) async throws {
        let rig = try rig(engine: .failure(error))
        defer { rig.home.remove() }
        _ = await rig.actions.setUp()
        #expect(rig.runner.calls.contains(rig.installEngineCall))
    }

    @Test func anEngineThatCannotBeAskedIsNotInstalledOverBlindlyAndItsStepWaitsForAnAnswer() async throws {
        let rig = try rig(claudeInstalled: false, engine: .failure(.timeout))
        defer { rig.home.remove() }
        let outcome = await rig.actions.setUp()
        #expect(rig.runner.calls == [rig.developerToolsCheck])
        #expect(outcome.message.isEmpty)
        #expect(rig.setup.waitingFor == [.status, .claudeCode])
    }

    @Test func aStatusThatRunsOutOfTimeStillPutsInTheMCPServerAndTheSkillAndOnlyTheEngineStepWaits() async throws {
        // The launcher is one path whatever the engine's version, so Claude Code's part does not need the answer.
        let rig = try rig(engine: .failure(.timeout))
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        try rig.home.write("#!/bin/sh\n", to: URL(fileURLWithPath: rig.launcher)) // an engine was unpacked before
        let outcome = await rig.actions.setUp()
        #expect(rig.runner.calls == [rig.developerToolsCheck, rig.mcpAdd(rig.launcher)], "no install-engine")
        #expect(rig.claude.mcpState(launcher: nil) == .ready)
        #expect(rig.claude.skillState(source: rig.bundle.skillSource, appVersion: "0.7.0") == .ready)
        #expect(outcome == ActionOutcome(kind: .success, message: "새 Claude 대화부터 CUA가 붙어요"))
        #expect(rig.setup.waitingFor == [.status], "the engine step comes back with the first read that works")
        #expect(rig.setup.phase == .idle)
    }

    @Test func withoutTheEnginesAnswerOrItsLauncherTheMCPServerWaitsWithTheEngineStep() async throws {
        // An app engine was never unpacked here (an old command answers slowly): a server pointing at nothing would
        // fail in every new conversation. The skill does not depend on it.
        let rig = try rig(engine: .failure(.timeout))
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        let outcome = await rig.actions.setUp()
        #expect(rig.runner.calls == [rig.developerToolsCheck], "no install-engine and no MCP server yet")
        #expect(rig.claude.mcpState(launcher: nil) == .missing)
        #expect(rig.claude.skillState(source: rig.bundle.skillSource, appVersion: "0.7.0") == .ready)
        #expect(outcome == ActionOutcome(kind: .success, message: "새 Claude 대화부터 CUA가 붙어요"))
        #expect(rig.setup.waitingFor == [.status])
    }

    @Test func aSkillOrServerOfAnotherIsStillLeftAloneWhileTheStatusCannotBeHad() async throws {
        let rig = try rig(engine: .failure(.timeout))
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        try rig.home.addMcp(command: "/usr/local/bin/cua")
        let outcome = await rig.actions.setUp()
        #expect(rig.runner.calls == [rig.developerToolsCheck])
        #expect(outcome == ActionOutcome(kind: .warning, message: InstallMessages.conflict))
        #expect(rig.setup.waitingFor == [.status])
    }

    // MARK: A matching engine with a broken part (the card's 고치기 has to do something)

    nonisolated static let brokenParts: [(String, String)] = [
        ("command", "missing"), ("dependencies", "missing"), ("login_environment", "missing"), ("login_environment", "stale"),
        ("wrapper", "missing"), ("wrapper", "broken"), ("relay", "unavailable"),
    ]

    private func engineWith(_ field: String, _ value: String, home: TempHome) throws -> EngineStatus {
        var status = try currentEngine(home).get()
        switch field {
        case "command": status.setup.command = value
        case "dependencies": status.setup.dependencies = value
        case "login_environment": status.setup.loginEnvironment = value
        case "wrapper": status.setup.wrapper = value
        default: status.setup.relay = value
        }
        return status
    }

    @Test(arguments: LiveSystemActionsTests.brokenParts)
    func anEngineOfTheAppsVersionWithABrokenPartHasItsSetupRunAgain(part: (String, String)) async throws {
        let rig = try rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        rig.engine.setStatus(try engineWith(part.0, part.1, home: rig.home))
        try rig.home.addMcp(command: rig.launcher)
        try rig.home.addSkill(version: "0.7.0", body: rig.skillSourceBody)
        let outcome = await rig.actions.setUp()
        #expect(rig.runner.calls == [rig.developerToolsCheck, rig.installEngineCall], "\(part): the card's 고치기 must do something")
        // Nothing in Claude Code changed, so it is not a new conversation that has something.
        #expect(outcome == ActionOutcome(kind: .success, message: "연결 설정을 마쳤어요"))
        #expect(rig.setup.phase == .idle)
    }

    @Test func aLoginEnvironmentSomebodyElseSetIsNotSetUpAgainAtEveryStart() async throws {
        // The setup never overwrites that value, so running it again cannot change it: it has a card of its own.
        let rig = try rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        rig.engine.setStatus(try engineWith("login_environment", "conflict", home: rig.home))
        try rig.home.addMcp(command: rig.launcher)
        try rig.home.addSkill(version: "0.7.0", body: rig.skillSourceBody)
        let outcome = await rig.actions.setUp()
        #expect(rig.runner.calls == [rig.developerToolsCheck])
        #expect(outcome == InstallMessages.nothingToSay)
        #expect(rig.setup.phase == .idle)
    }

    @Test func aSetupThatLeavesAPartNotReadySaysSoOnce() async throws {
        // The relay could not be set up this time either: not silence, a fixed line that points at the check tab.
        let rig = try rig(installedSetup: #"{"command": "ready", "login_environment": "ready", "relay": "missing"}"#)
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        rig.engine.setStatus(try engineWith("relay", "unavailable", home: rig.home))
        try rig.home.addMcp(command: rig.launcher)
        try rig.home.addSkill(version: "0.7.0", body: rig.skillSourceBody)
        let outcome = await rig.actions.setUp()
        #expect(rig.runner.calls.contains(rig.installEngineCall))
        #expect(outcome == ActionOutcome(kind: .warning, message: "다시 설정했지만 고쳐지지 않은 곳이 있어요 — 점검 탭에서 보세요"))
        #expect(rig.setup.phase == .idle, "the install itself went through")
    }

    @Test func aLoginEnvironmentConflictLeftAfterARepairDoesNotCountAgainstIt() async throws {
        // The repair was for the Python environment; the clash it reports again has its own card.
        let rig = try rig(installedSetup: #"{"command": "ready", "login_environment": "conflict", "relay": "ready"}"#)
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        rig.engine.setStatus(try engineWith("dependencies", "missing", home: rig.home))
        try rig.home.addMcp(command: rig.launcher)
        try rig.home.addSkill(version: "0.7.0", body: rig.skillSourceBody)
        #expect(await rig.actions.setUp() == ActionOutcome(kind: .success, message: "연결 설정을 마쳤어요"))
        #expect(LiveSystemActions.setupIsSettled(in: Data(#"{"setup": {"command": "ready", "login_environment": "conflict", "relay": "ready"}}"#.utf8)))
        #expect(!LiveSystemActions.setupIsSettled(in: Data(#"{"setup": {"command": "ready", "login_environment": "failed", "relay": "ready"}}"#.utf8)))
    }

    // MARK: A claude that cannot start

    @Test func theClaudeFoundRunsWithItsOwnFolderFirstInPath() async throws {
        // npm, nvm and bun put a script there for the node beside it.
        let rig = try rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        _ = await rig.actions.setUp()
        let folder = rig.home.claudeCLI.deletingLastPathComponent().path
        let claudeRuns = rig.runner.pathFirst.filter { $0.0 == rig.claudePath }
        #expect(claudeRuns.count == 1)
        #expect(claudeRuns.allSatisfy { $0.1 == [folder] })
    }

    @Test func aClaudeThatCannotStartIsTreatedLikeNoClaudeCodeAndNotAsAFailure() async throws {
        // Exit 127: the node an npm-installed claude needs is nowhere. Another try would not help, so no 다시 하기 and
        // nothing waits for it (the next start of the app tries again); the check tab says why.
        let rig = try rig(responses: { call in call.isClaude ? StepRunner.failed(code: 127) : nil })
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        let outcome = await rig.actions.setUp()
        #expect(rig.runner.calls == [rig.developerToolsCheck, rig.installEngineCall, rig.mcpAdd()])
        #expect(outcome == ActionOutcome(kind: .success, message: "연결 설정을 마쳤어요"), "the engine was put in")
        #expect(rig.setup.phase == .idle)
        #expect(rig.setup.claudeCodeUnusable)
        #expect(!rig.setup.waitingFor.contains(.claudeCode), "a catch-up would run it again at every read")
        #expect(!FileManager.default.fileExists(atPath: rig.home.skillFolder.path))

        // A later run that can start it puts it right and forgets.
        let fixed = try self.rig()
        defer { fixed.home.remove() }
        try fixed.home.installClaudeCode()
        fixed.setup.record(waitingFor: [], developerToolsNeeded: false, claudeCodeUnusable: true)
        _ = await fixed.actions.setUp()
        #expect(!fixed.setup.claudeCodeUnusable)
    }

    @Test func theCardSaysNothingAboutMCPAndSkillForAClaudeThatCannotStart() {
        let unusable = ClaudeSetupState(claudeCodeFound: true, claudeCodeUnusable: true, mcp: .missing, skill: .conflict)
        #expect(StatusEvaluator.claudeIssues(in: unusable).isEmpty)
        #expect(StatusEvaluator.conflictProblem(in: unusable) == nil)
    }

    @Test func aMatchingEngineWithNothingBrokenIsNotSetUpAgain() async throws {
        let rig = try rig()
        defer { rig.home.remove() }
        rig.engine.setStatus(try currentEngine(rig.home).get())
        try rig.home.installClaudeCode()
        try rig.home.addMcp(command: rig.launcher)
        try rig.home.addSkill(version: "0.7.0", body: rig.skillSourceBody)
        _ = await rig.actions.setUp()
        #expect(!rig.runner.calls.contains { $0.isInstallEngine })
    }

    // MARK: Codex: the engine's word first, the app's look at the disk when it cannot say

    @Test func theEnginesWordThatCodexIsThereCountsMoreThanTheAppsLookAtTheDisk() async throws {
        // Codex is somewhere the app does not look, and the engine found it.
        let rig = try rig(codexInstalled: false)
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        var status = try currentEngine(rig.home, version: "0.6.0").get()
        status.codex.installed = true
        rig.engine.setStatus(status)
        _ = await rig.actions.setUp()
        #expect(rig.runner.calls.contains(rig.installEngineCall))
        #expect(rig.setup.waitingFor.isEmpty)
    }

    @Test func theEnginesWordThatCodexIsNotThereCountsMoreToo() async throws {
        let rig = try rig(codexInstalled: true)
        defer { rig.home.remove() }
        var status = try currentEngine(rig.home, version: "0.6.0").get()
        status.codex.installed = false
        rig.engine.setStatus(status)
        let outcome = await rig.actions.setUp()
        #expect(rig.runner.calls.isEmpty)
        #expect(outcome.message.isEmpty)
        #expect(rig.setup.waitingFor == [.codex])
    }

    @Test func anEngineThatDoesNotSayAboutCodexLeavesItToTheAppsLook() async throws {
        for there in [false, true] {
            let rig = try rig(codexInstalled: there)
            defer { rig.home.remove() }
            var status = try currentEngine(rig.home, version: "0.6.0").get()
            status.codex.installed = nil
            rig.engine.setStatus(status)
            _ = await rig.actions.setUp()
            #expect(rig.runner.calls.contains(rig.installEngineCall) == there, "app sees Codex: \(there)")
        }
    }

    @Test func anOutOfDateMCPServerOfTheAppsOwnIsRemovedAndAddedAgain() async throws {
        let rig = try rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        rig.engine.setStatus(try currentEngine(rig.home).get())
        try rig.home.addSkill(version: "0.7.0", body: rig.skillSourceBody)
        // The app's own, from a time the launcher was a version folder.
        try rig.home.addMcp(command: rig.home.engineCopies.appendingPathComponent("0.6.0/start-mcp.sh").path)
        let outcome = await rig.actions.setUp()
        #expect(rig.runner.calls == [rig.developerToolsCheck, rig.mcpRemove, rig.mcpAdd()])
        #expect(rig.claude.mcpState(launcher: rig.launcher) == .ready)
        #expect(outcome.kind == .success)
    }

    @Test func anMCPServerWithArgumentsIsOutOfDateToo() async throws {
        let rig = try rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        rig.engine.setStatus(try currentEngine(rig.home).get())
        try rig.home.addSkill(version: "0.7.0", body: rig.skillSourceBody)
        try rig.home.addMcp(command: rig.launcher, args: ["--debug"])
        _ = await rig.actions.setUp()
        #expect(rig.runner.calls == [rig.developerToolsCheck, rig.mcpRemove, rig.mcpAdd()])
    }

    @Test func anMCPServerTheAppDidNotPutThereIsNeverTouchedAndIsToldAsAConflict() async throws {
        let rig = try rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        rig.engine.setStatus(try currentEngine(rig.home).get())
        try rig.home.addSkill(version: "0.7.0", body: rig.skillSourceBody)
        try rig.home.addMcp(command: "/Users/someone/.claude/plugins/cache/chenjing-plugins/cua/0.7.0/start-mcp.sh")
        let before = try Data(contentsOf: rig.home.claudeConfig)
        let outcome = await rig.actions.setUp()
        #expect(rig.runner.calls == [rig.developerToolsCheck], "no remove, no add")
        #expect(try Data(contentsOf: rig.home.claudeConfig) == before)
        #expect(outcome == ActionOutcome(kind: .warning, message: InstallMessages.conflict))
        #expect(rig.claude.mcpState(launcher: rig.launcher) == .conflict)
        #expect(rig.setup.phase == .idle, "a conflict is not a failed install")
    }

    @Test func aSkillFolderWithoutTheAppsMarkIsNeverTouchedAndIsToldAsAConflict() async throws {
        let rig = try rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        rig.engine.setStatus(try currentEngine(rig.home).get())
        try rig.home.addMcp(command: rig.launcher)
        try rig.home.addSkill(version: nil, body: "someone else's skill\n")
        let outcome = await rig.actions.setUp()
        #expect(try String(contentsOf: rig.home.skillFolder.appendingPathComponent("SKILL.md"), encoding: .utf8) == "someone else's skill\n")
        #expect(!FileManager.default.fileExists(atPath: rig.home.skillFolder.appendingPathComponent(".cua-bar.json").path))
        #expect(outcome == ActionOutcome(kind: .warning, message: InstallMessages.conflict))
    }

    @Test func aMarkedSkillOfAnotherVersionIsWrittenOverAndAMissingOneIsWritten() async throws {
        let rig = try rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        rig.engine.setStatus(try currentEngine(rig.home).get())
        try rig.home.addMcp(command: rig.launcher)
        try rig.home.addSkill(version: "0.6.0", body: "the old skill\n")
        let outcome = await rig.actions.setUp()
        #expect(try String(contentsOf: rig.home.skillFolder.appendingPathComponent("SKILL.md"), encoding: .utf8) == rig.skillSourceBody)
        let mark = try JSONSerialization.jsonObject(with: Data(contentsOf: rig.home.skillFolder.appendingPathComponent(".cua-bar.json"))) as? [String: String]
        #expect(mark == ["version": "0.7.0"])
        #expect(outcome == ActionOutcome(kind: .success, message: "새 Claude 대화부터 CUA가 붙어요"))
        #expect(rig.runner.calls == [rig.developerToolsCheck], "the MCP server was fine")

        // A marked folder whose skill was deleted by hand is written again.
        try FileManager.default.removeItem(at: rig.home.skillFolder.appendingPathComponent("SKILL.md"))
        _ = await rig.actions.setUp()
        #expect(rig.claude.skillState(source: rig.bundle.skillSource, appVersion: "0.7.0") == .ready)
    }

    // MARK: What the install waits for

    @Test func withoutCodexNothingRunsAndTheInstallWaitsForIt() async throws {
        let rig = try rig(codexInstalled: false)
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        let outcome = await rig.actions.setUp()
        #expect(rig.runner.calls.isEmpty, "not even a look at the developer tools")
        #expect(outcome.message.isEmpty)
        #expect(rig.setup.waitingFor == [.codex])
        #expect(rig.setup.phase == .idle)
        #expect(!FileManager.default.fileExists(atPath: rig.home.claudeConfig.path))
    }

    @Test func withoutDeveloperToolsNothingIsInstalledAndNoInstallerOpens() async throws {
        let rig = try rig(developerTools: false)
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        let outcome = await rig.actions.setUp()
        #expect(rig.runner.calls == [rig.developerToolsCheck], "xcode-select -p only: never python3, never --install")
        #expect(outcome.message.isEmpty, "the card says it")
        #expect(rig.setup.developerToolsNeeded)
        #expect(rig.setup.phase == .idle)
        #expect(rig.setup.waitingFor.isEmpty)
    }

    @Test func withoutClaudeCodeTheEngineIsInstalledAndTheMCPServerAndSkillWait() async throws {
        let rig = try rig(claudeInstalled: false)
        defer { rig.home.remove() }
        let outcome = await rig.actions.setUp()
        #expect(rig.runner.calls == [rig.developerToolsCheck, rig.installEngineCall])
        #expect(outcome == ActionOutcome(kind: .success, message: "연결 설정을 마쳤어요"), "it cannot say a Claude conversation will have it")
        #expect(rig.setup.waitingFor == [.claudeCode])
        #expect(!FileManager.default.fileExists(atPath: rig.home.claudeConfig.path))
        #expect(!FileManager.default.fileExists(atPath: rig.home.skillFolder.path))
    }

    @Test func aBuildThatDoesNotRunFromAnAppBundleInstallsNothingAndChangesNothing() async throws {
        let rig = try rig(bundled: false)
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        let outcome = await rig.actions.setUp()
        #expect(rig.runner.calls.isEmpty)
        #expect(outcome.message.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: rig.home.claudeConfig.path))
    }

    // MARK: Failures: one fixed line, never what a command printed

    @Test func anEngineInstallThatFailsGivesItsFixedLineAndMarksSetupFailed() async throws {
        for failure in [StepRunner.failed(code: 1), StepRunner.failed(code: 127)] {
            let rig = try rig(responses: { call in call.isInstallEngine ? failure : nil })
            defer { rig.home.remove() }
            try rig.home.installClaudeCode()
            let outcome = await rig.actions.setUp()
            #expect(outcome == ActionOutcome(kind: .failure, message: "연결 엔진을 설치하지 못했어요"))
            #expect(!outcome.message.contains("SECRET") && !outcome.message.contains("token"))
            #expect(rig.runner.calls.allSatisfy { !$0.isClaude }, "no MCP server for an engine that is not there")
            #expect(rig.setup.phase == .failed, "the status card then offers 다시 하기")
        }
    }

    @Test func aStepThatCannotStartOrRunsOutOfTimeIsTheSameFixedLine() async throws {
        for error: ProcessRunError in [.launchFailed("SECRET launch detail"), .timedOut] {
            let rig = try rig(responses: { call in
                if call.isInstallEngine { throw error }
                return nil
            })
            defer { rig.home.remove() }
            #expect(await rig.actions.setUp() == ActionOutcome(kind: .failure, message: "연결 엔진을 설치하지 못했어요"))
        }
    }

    @Test func anMCPAddThatFailsGivesItsFixedLine() async throws {
        let rig = try rig(responses: { call in call.isClaude ? StepRunner.failed(code: 1) : nil })
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        let outcome = await rig.actions.setUp()
        #expect(outcome == ActionOutcome(kind: .failure, message: "Claude Code에 CUA를 연결하지 못했어요"))
        #expect(!outcome.message.contains("SECRET"))
        #expect(rig.setup.phase == .failed)
        #expect(!FileManager.default.fileExists(atPath: rig.home.skillFolder.path), "it stopped there")
    }

    @Test func anMCPAddThatSaysOkButLeavesNoServerIsAFailureBecauseTheFileIsWhatCounts() async throws {
        let rig = try rig(responses: { call in call.isClaude ? StepRunner.ok("Added stdio MCP server cuabar") : nil })
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        let outcome = await rig.actions.setUp()
        #expect(outcome == ActionOutcome(kind: .failure, message: "Claude Code에 CUA를 연결하지 못했어요"))
    }

    @Test func anOutOfDateServerThatCannotBeRemovedIsNotAddedOver() async throws {
        let rig = try rig(responses: { call in call.isClaude && call.arguments.first == "mcp" && call.arguments[1] == "remove" ? StepRunner.failed() : nil })
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        rig.engine.setStatus(try currentEngine(rig.home).get())
        try rig.home.addMcp(command: rig.home.engineCopies.appendingPathComponent("0.6.0/start-mcp.sh").path)
        let outcome = await rig.actions.setUp()
        #expect(outcome.kind == .failure)
        #expect(rig.runner.calls == [rig.developerToolsCheck, rig.mcpRemove])
    }

    // MARK: One at a time

    @Test func aSecondInstallWhileOneRunsRunsNothing() async throws {
        let gate = AsyncGate()
        let rig = try rig(gateFor: { $0.isInstallEngine ? gate : nil })
        defer { rig.home.remove(); gate.open() }
        let first = Task { await rig.actions.setUp() }
        #expect(await waitUntil { rig.runner.calls.contains { $0.isInstallEngine } })
        #expect(rig.setup.phase == .running)
        let second = await rig.actions.setUp()
        #expect(second == ActionOutcome(kind: .info, message: "이미 하는 중이에요"))
        #expect(rig.runner.calls.filter { $0.isInstallEngine }.count == 1, "nothing started beside the first")
        gate.open()
        _ = await first.value
        #expect(rig.setup.phase == .idle)
        // And the slot is free again afterwards.
        _ = await rig.actions.setUp()
        #expect(rig.runner.calls.filter { $0.isDeveloperToolsCheck }.count == 2)
    }

    @Test func theSlotAnotherSetupHoldsKeepsTheInstallOut() async throws {
        let rig = try rig()
        defer { rig.home.remove() }
        #expect(rig.setup.begin(), "some other run is going")
        let outcome = await rig.actions.setUp()
        #expect(outcome == ActionOutcome(kind: .info, message: "이미 하는 중이에요"))
        #expect(rig.runner.calls.isEmpty)
        #expect(rig.setup.phase == .running, "the other keeps its slot")
    }

    // MARK: Developer tools button

    @Test func theDeveloperToolsButtonOpensTheSystemsInstallerWhenTheToolsAreStillMissing() async throws {
        let rig = try rig(developerTools: false)
        defer { rig.home.remove() }
        let outcome = await rig.actions.installDeveloperTools()
        #expect(rig.runner.calls.map(\.arguments) == [["-p"], ["--install"]])
        #expect(rig.runner.calls.allSatisfy { $0.executable == "/usr/bin/xcode-select" })
        #expect(outcome == ActionOutcome(kind: .info, message: "개발자 도구 설치 창을 열었어요 — 끝나면 설치를 한 번 더 눌러 주세요"))
    }

    @Test func theDeveloperToolsButtonRunsTheWholeInstallOnceTheToolsHaveComeAndClearsTheCard() async throws {
        let rig = try rig()
        defer { rig.home.remove() }
        rig.setup.record(waitingFor: [], developerToolsNeeded: true)
        let outcome = await rig.actions.installDeveloperTools()
        #expect(!rig.runner.calls.contains { $0.arguments == ["--install"] })
        #expect(rig.runner.calls.contains(rig.installEngineCall))
        #expect(!rig.setup.developerToolsNeeded)
        #expect(outcome.kind == .success)
    }

    @Test func anInstallerThatCannotBeOpenedIsAFixedLine() async throws {
        let rig = try rig(responses: { call in
            if call.isDeveloperToolsCheck { return StepRunner.failed(code: 2) }
            if call.arguments == ["--install"] { return StepRunner.failed(code: 1) }
            return nil
        })
        defer { rig.home.remove() }
        #expect(await rig.actions.installDeveloperTools() == ActionOutcome(kind: .failure, message: "개발자 도구 설치 창을 열지 못했어요"))
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
        let rig = try rig()
        defer { rig.home.remove() }
        rig.opener.succeeds = false
        #expect(await rig.actions.openCodexDownload() == ActionOutcome(kind: .failure, message: "받는 곳을 열지 못했어요"))
    }

    // MARK: The pieces

    @Test func theResultLineOfTheInstallIsTheLastJsonObjectOnStdout() {
        let out = "unpacking...\n" + #"{"version": "0.8.0", "launcher": "/h/.local/share/codex-cua/engine/current/start-mcp.sh"}"# + "\n"
        #expect(LiveSystemActions.launcher(in: Data(out.utf8)) == "/h/.local/share/codex-cua/engine/current/start-mcp.sh")
        #expect(LiveSystemActions.launcher(in: Data(#"{"launcher": "relative/start-mcp.sh"}"#.utf8)) == nil)
        #expect(LiveSystemActions.launcher(in: Data(#"{"launcher": 7}"#.utf8)) == nil)
        #expect(LiveSystemActions.launcher(in: Data("not json".utf8)) == nil)
        #expect(LiveSystemActions.launcher(in: Data()) == nil)
    }
}
