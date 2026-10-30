import Foundation
import Testing
@testable import cua_bar

/// What an old install leaves on a Mac. A `codex-cua` from the days of the Claude plugin (0.5.0's does not
/// know `status` and exits 2) is an old command the app's install replaces; the old plugin's record in
/// Claude Code is only told about, never removed by the app.
@MainActor
struct OldPluginTests {
    /// What 0.5.0's command does with `status --json`: argparse rejects it and exits 2.
    private static let oldCommand = """
    #!/bin/sh
    # codex-cua authored command v1
    echo "usage: setup.py [-h] {install,setup,ensure,start,doctor,uninstall}" >&2
    echo "setup.py: error: argument command: invalid choice: 'status'" >&2
    exit 2
    """

    private struct Rig {
        var home: TempHome
        var model: CUABarViewModel
        var system: RecordingSystemActions
    }

    /// The real client, locator and process runner over a stand-in command in a throwaway home.
    private func rig(
        command: String = oldCommand, timeouts: EngineTimeouts = EngineTimeouts(), appVersion: String? = "0.7.0", withClaude: Bool = false
    ) throws -> Rig {
        let home = try TempHome()
        try home.writeCommand(command)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: home.command.path)
        let system = RecordingSystemActions()
        let claude = ClaudeIntegration(home: home.url, claude: ClaudeCLILocator(home: home.url, isExecutableFile: { _ in false }))
        var inspector: (@Sendable (String?) -> ClaudeSetupState)?
        if withClaude { inspector = { claude.inspect(launcher: $0) } }
        let model = CUABarViewModel(
            engine: CodexCUAEngineClient(locator: CommandLocator(home: home.url), timeouts: timeouts), appVersion: appVersion,
            systemActions: system, pasteboard: RecordingPasteboard(), clock: { Fixtures.now }, calendar: Fixtures.utc, sleep: ManualSleeper().sleep,
            claudeInspector: inspector)
        return Rig(home: home, model: model, system: system)
    }

    // MARK: A stand-in command that exits 2

    @Test func anOldCommandThatCannotAnswerStatusIsTheSetupProblemWithItsFixButton() async throws {
        let rig = try rig()
        defer { rig.home.remove() }
        await rig.model.refresh()
        let problem = try #require(rig.model.summary.problem)
        #expect(problem.kind == .setupIncomplete)
        #expect(problem.title == "연결 명령이 옛 판이거나 깨졌어요")
        #expect(problem.nextStep == "고치기를 누르면 연결을 다시 설정해요")
        #expect(problem.fix == .runSetup)
        #expect(problem.fixLabel == "고치기")
        #expect(rig.model.summary.warning == nil, "nothing the command printed")
        #expect(rig.model.summary.icon == .problem)
        #expect(rig.model.content == nil)
    }

    @Test func pressingItGoesToTheInstall() async throws {
        let rig = try rig()
        defer { rig.home.remove() }
        await rig.model.refresh()
        await rig.model.perform(try #require(rig.model.summary.fix))
        #expect(rig.system.calls == ["setUp"])
    }

    @Test func unreadableOutputOfAnOldCommandCountsToo() async throws {
        let rig = try rig(command: "#!/bin/sh\n# codex-cua authored command v1\necho 'not json at all'\n")
        defer { rig.home.remove() }
        await rig.model.refresh()
        #expect(rig.model.summary.problem?.kind == .setupIncomplete)
        #expect(rig.model.summary.problem?.fix == .runSetup)
    }

    @Test func aTimeoutSaysNothingAboutTheEngine() async throws {
        let rig = try rig(
            command: "#!/bin/sh\n# codex-cua authored command v1\nexec /bin/sleep 30\n", timeouts: EngineTimeouts(status: .milliseconds(400)))
        defer { rig.home.remove() }
        await rig.model.refresh()
        #expect(rig.model.summary.problem?.kind == .engineUnreadable)
    }

    @Test func aStatusThatWorksIsNotSecondGuessedBecauseOfWhatElseIsOnTheMac() async throws {
        let path = try #require(Bundle.module.url(forResource: "status-ready", withExtension: "json", subdirectory: "Fixtures")).path
        let rig = try rig(command: "#!/bin/sh\n# codex-cua authored command v1\ncat '\(path)'\n", withClaude: true)
        defer { rig.home.remove() }
        try rig.home.addLegacyPlugin() // the old plugin is still recorded
        await rig.model.refresh()
        #expect(rig.model.summary.problem == nil)
        #expect(rig.model.content != nil)
    }

    @Test func theFirstFailureShowsAtOnceButAnEstablishedAnswerWaitsForTwo() async throws {
        // Same rule as every read problem: one slow or odd answer does not flip a working icon.
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let model = CUABarViewModel(engine: engine, appVersion: "0.7.0", clock: { Fixtures.now }, calendar: Fixtures.utc, sleep: ManualSleeper().sleep)
        await model.refresh()
        #expect(model.summary.icon == .ready)
        engine.setStatusError(.commandFailed(exitCode: 2, message: "usage"))
        await model.refresh()
        #expect(model.summary.icon == .ready)
        await model.refresh()
        #expect(model.summary.problem?.kind == .setupIncomplete)

        let fresh = CUABarViewModel(engine: engine, appVersion: "0.7.0", clock: { Fixtures.now }, calendar: Fixtures.utc, sleep: ManualSleeper().sleep)
        await fresh.refresh()
        #expect(fresh.summary.problem?.kind == .setupIncomplete, "no good answer yet: shown at once")
    }

    // MARK: The old plugin's record

    @Test func theOldPluginIsKeptInTheModelForTheCheckAndIsNotOnTheCardOrTheIcon() async throws {
        let rig = try rig(command: try statusReadyCommand(), withClaude: true)
        defer { rig.home.remove() }
        try rig.home.addLegacyPlugin()
        await rig.model.refresh()
        #expect(rig.model.claudeSetup.legacyPlugin)
        #expect(rig.model.summary.problem == nil)
        #expect(rig.model.summary.icon == .ready)
        #expect(rig.system.calls.isEmpty, "the app does not remove it")
    }

    @Test func theNoticeAndTheCommandToRemoveItAreFixed() {
        #expect(LegacyPlugin.notice == "옛 cua 플러그인이 남아 있어요 — CUA가 둘 붙어요")
        #expect(LegacyPlugin.removeCommand == "claude plugin uninstall cua@chenjing-plugins --scope user")
    }

    @Test func theRecordIsTheOnlyThingThatCounts() throws {
        let home = try TempHome()
        defer { home.remove() }
        let claude = ClaudeIntegration(home: home.url)
        #expect(!claude.legacyPluginRecorded(), "no registry")
        try home.write(#"{"version": 2, "plugins": {"other@market": [{"scope": "user", "installPath": "/x"}]}}"#, to: claude.legacyRegistryURL)
        #expect(!claude.legacyPluginRecorded(), "another plugin")
        try home.write(#"{"version": 2, "plugins": {"cua@chenjing-plugins": []}}"#, to: claude.legacyRegistryURL)
        #expect(!claude.legacyPluginRecorded(), "an empty list")
        try home.write("not json", to: claude.legacyRegistryURL)
        #expect(!claude.legacyPluginRecorded())
        try home.addLegacyPlugin()
        #expect(claude.legacyPluginRecorded())
        try home.addLegacyPlugin(scope: "project")
        #expect(claude.legacyPluginRecorded(), "whatever the scope: two CUAs attach either way")
    }

    @Test func theAppNeverReadsTheRegistryToFindItsOwnEngine() throws {
        // A cua plugin folder with a setup.sh is no engine for the app.
        let home = try TempHome()
        defer { home.remove() }
        try home.addLegacyPlugin()
        try home.write("#!/bin/sh\nexit 0\n", to: home.url.appendingPathComponent(".claude/plugins/cache/chenjing-plugins/cua/0.7.0/setup.sh"))
        #expect(CommandLocator(home: home.url).locate() == .engineMissing)
    }

    private func statusReadyCommand() throws -> String {
        let path = try #require(Bundle.module.url(forResource: "status-ready", withExtension: "json", subdirectory: "Fixtures")).path
        return "#!/bin/sh\n# codex-cua authored command v1\ncat '\(path)'\n"
    }
}
