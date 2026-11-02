import Foundation
import Testing
@testable import cua_bar

/// TK-587: Claude Code's company settings folder (`~/.claude-ubion`, `CLAUDE_CONFIG_DIR`) gets the cuabar MCP server too,
/// and the check reads it as it reads the default one. Everything runs over a throwaway home.
struct CompanyFolderTests {
    private func make(
        _ home: TempHome, runner: any ProcessRunning = StepRunner { _ in StepRunner.ok() }
    ) -> ClaudeIntegration {
        let path = home.claudeCLI.path
        return ClaudeIntegration(home: home.url, claude: ClaudeCLILocator(home: home.url, isExecutableFile: { $0 == path }), runner: runner)
    }

    // MARK: Which folders

    @Test func theCompanyFolderCountsOnlyWhenItIsThere() throws {
        let home = try TempHome()
        defer { home.remove() }
        let claude = make(home)
        #expect(claude.folders().map(\.folder) == [.standard])
        #expect(claude.inspect(launcher: nil).otherFolders.isEmpty)
        try home.makeCompanyFolder()
        #expect(claude.folders().map(\.folder) == [.standard, .company])
        #expect(claude.inspect(launcher: nil).otherFolders.map(\.folder) == [.company])
    }

    @Test func aFileNamedLikeTheFolderIsNotAFolder() throws {
        let home = try TempHome()
        defer { home.remove() }
        try home.write("x", to: home.companyFolder)
        #expect(make(home).folders().map(\.folder) == [.standard])
    }

    @Test func eachFolderHasItsOwnFiles() throws {
        let home = try TempHome()
        defer { home.remove() }
        let standard = make(home)
        let company = standard.inFolder(.company)
        #expect(standard.configURL == home.url.appendingPathComponent(".claude.json"))
        #expect(standard.userSettingsURL == home.url.appendingPathComponent(".claude/settings.json"))
        #expect(company.configURL == home.companyConfig)
        #expect(company.userSettingsURL == home.companyFolder.appendingPathComponent("settings.json"))
        #expect(company.retiredSkillFolder == home.companyFolder.appendingPathComponent("skills/cuabar", isDirectory: true))
        #expect(company.legacyRegistryURL == home.companyFolder.appendingPathComponent("plugins/installed_plugins.json"))
    }

    // MARK: Reading

    @Test func theCompanyFolderWithoutTheServerIsMissingWhileTheDefaultOneIsReady() throws {
        let home = try TempHome()
        defer { home.remove() }
        try home.makeCompanyFolder()
        try home.addMcp(command: home.launcher)
        let claude = make(home)
        var state = claude.inspect(launcher: home.launcher)
        #expect(state.mcp == .ready)
        #expect(state.otherFolders.first?.mcp == .missing)
        try home.addMcp(command: home.launcher, in: home.companyConfig)
        state = claude.inspect(launcher: home.launcher)
        #expect(state.otherFolders.first?.mcp == .ready)
        #expect(claude.inFolder(.standard).configParseCount >= 1 && claude.inFolder(.company).configParseCount >= 1,
                "each folder keeps its own read")
    }

    @Test func leftoversAndRulesAreReadInTheCompanyFolderToo() throws {
        let home = try TempHome()
        defer { home.remove() }
        try home.makeCompanyFolder()
        try home.write(
            #"{"version": 2, "plugins": {"cua@ubion": [{"scope": "user", "installPath": "/x", "version": "0.7.0"}]}}"#,
            to: home.companyFolder.appendingPathComponent("plugins/installed_plugins.json"))
        try home.write(#"{"permissions": {"defaultMode": "auto"}}"#, to: home.companyFolder.appendingPathComponent("settings.json"))
        try home.write(#"{"permissions": {"allow": ["mcp__cuabar"]}}"#, to: home.url.appendingPathComponent(".claude/settings.json"))
        let state = make(home).leftovers()
        #expect(state.legacyPlugins.isEmpty)
        #expect(state.permissions?.userRule == .allowed)
        let company = try #require(state.otherFolders.first)
        #expect(company.legacyPlugins == ["cua@ubion"])
        #expect(company.permissions?.defaultMode == "auto" && company.permissions?.needsAllowRule == true)
        #expect(state.hasOldNames, "the company folder's old plugin counts")
        #expect(UpdateAdvice.line(for: state) == UpdateAdvice.oldNames)
    }

    @Test func theCompanyFoldersProjectsAreLookedAtFromItsOwnList() throws {
        let home = try TempHome()
        defer { home.remove() }
        try home.makeCompanyFolder()
        let project = home.url.appendingPathComponent("dev/work", isDirectory: true)
        try home.write(#"{"permissions": {"allow": ["mcp__cua__js"]}}"#, to: project.appendingPathComponent(".claude/settings.json"))
        try home.writeClaudeConfig(["projects": [project.path: [String: Any]()]], to: home.companyConfig)
        let state = make(home).leftovers()
        #expect(state.permissions?.oldRuleFiles == [], "the default folder does not list it")
        #expect(state.otherFolders.first?.permissions?.oldRuleFiles == ["~/dev/work/.claude/settings.json"])
    }

    // MARK: Changing

    @Test func eachFoldersCommandNamesItsFolderAndTheDefaultOneTakesTheVariableAway() async throws {
        let home = try TempHome()
        defer { home.remove() }
        let runner = StepRunner { _ in StepRunner.ok() }
        let claude = make(home, runner: runner)
        _ = await claude.addMCP(command: home.launcher)
        _ = await claude.inFolder(.company).addMCP(command: home.launcher)
        _ = await claude.inFolder(.company).removeMCP()
        let settings = runner.setting.map { $0.1 }
        #expect(settings.count == 3)
        #expect(settings[0].keys.contains("CLAUDE_CONFIG_DIR") && settings[0]["CLAUDE_CONFIG_DIR"]! == nil)
        #expect(settings[1]["CLAUDE_CONFIG_DIR"] == .some(home.companyFolder.path))
        #expect(runner.calls.map(\.configDir) == [nil, home.companyFolder.path, home.companyFolder.path])
    }

    @Test func theRealRunnerSetsAndTakesAwayTheVariable() {
        let base = ["PATH": "/usr/bin", "CLAUDE_CONFIG_DIR": "/somewhere"]
        #expect(SystemProcessRunner.environment(base, setting: ["CLAUDE_CONFIG_DIR": nil]) == ["PATH": "/usr/bin"])
        #expect(SystemProcessRunner.environment(base, setting: ["CLAUDE_CONFIG_DIR": "/c"])["CLAUDE_CONFIG_DIR"] == "/c")
    }

    /// A real `claude` stand-in that writes what it was given: an app started from a terminal with the variable set
    /// still puts the default folder's server where Claude Code's default is.
    @Test func aRealCommandGetsTheFolderItIsFor() async throws {
        let home = try TempHome()
        defer { home.remove() }
        let seen = home.url.appendingPathComponent("seen")
        try home.write("#!/bin/sh\necho \"${CLAUDE_CONFIG_DIR-unset}\" >> \"\(seen.path)\"\n", to: home.claudeCLI)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: home.claudeCLI.path)
        var environment = SystemProcessRunner.defaultEnvironment()
        environment["CLAUDE_CONFIG_DIR"] = "/inherited"
        let claude = make(home, runner: SystemProcessRunner(environment: environment))
        #expect(await claude.addMCP(command: home.launcher) == .succeeded)
        #expect(await claude.inFolder(.company).addMCP(command: home.launcher) == .succeeded)
        #expect(try String(contentsOf: seen, encoding: .utf8) == "unset\n\(home.companyFolder.path)\n")
    }

    @Test func removalTakesTheAppsServerOutOfEveryFolder() async throws {
        let home = try TempHome()
        defer { home.remove() }
        try home.makeCompanyFolder()
        try home.addMcp(command: home.launcher)
        try home.addMcp(command: home.launcher, in: home.companyConfig)
        let runner = StepRunner { call in
            let config = call.configDir.map { URL(fileURLWithPath: $0).appendingPathComponent(".claude.json") } ?? home.claudeConfig
            try home.writeClaudeConfig(["mcpServers": [String: Any]()], to: config)
            return StepRunner.ok()
        }
        let claude = make(home, runner: runner)
        let removal = await claude.removeAppOwned()
        #expect(removal == ClaudeIntegration.Removal(mcpStays: false, removedAnything: true))
        #expect(runner.calls.map(\.configDir) == [nil, home.companyFolder.path])
        #expect(claude.inFolder(.company).mcpState(launcher: home.launcher) == .missing)
    }
}

/// The install puts the server into each folder (TK-587).
@MainActor
struct CompanyFolderInstallTests {
    private let base = LiveSystemActionsTests()

    @Test func theInstallPutsTheServerIntoTheCompanyFolderToo() async throws {
        let rig = try base.rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        try rig.home.makeCompanyFolder()
        let outcome = await rig.actions.setUp()
        #expect(rig.runner.calls == [rig.developerToolsCheck, rig.installEngineCall, rig.mcpAdd(), rig.companyMcpAdd()])
        #expect(rig.claude.mcpState(launcher: rig.launcher) == .ready)
        #expect(rig.claude.inFolder(.company).mcpState(launcher: rig.launcher) == .ready)
        #expect(outcome == ActionOutcome(kind: .success, message: "새 Claude 대화부터 CUA가 붙어요"))
    }

    @Test func aServerTheAppDidNotPutInTheCompanyFolderIsLeftAlone() async throws {
        let rig = try base.rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        try rig.home.makeCompanyFolder()
        try rig.home.addMcp(command: rig.launcher)
        try rig.home.addMcp(command: "/old/elsewhere", in: rig.home.companyConfig)
        _ = await rig.actions.setUp()
        let claudeCalls = rig.runner.calls.filter(\.isClaude)
        #expect(claudeCalls.isEmpty, "a server the app did not put there is left as it is: \(claudeCalls)")
        #expect(rig.claude.inFolder(.company).mcpState(launcher: rig.launcher) == .conflict)
    }

    @Test func anOutdatedCompanyServerIsReplacedThere() async throws {
        let rig = try base.rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        try rig.home.makeCompanyFolder()
        try rig.home.addMcp(command: rig.launcher)
        try rig.home.addMcp(command: rig.home.engineCopies.appendingPathComponent("0.6.0/start-mcp.sh").path, in: rig.home.companyConfig)
        _ = await rig.actions.setUp()
        #expect(rig.runner.calls.filter(\.isClaude) == [rig.companyMcpRemove, rig.companyMcpAdd()])
        #expect(rig.claude.inFolder(.company).mcpState(launcher: rig.launcher) == .ready)
    }
}

/// What the card and the 점검 tab say of the company folder (TK-587).
struct CompanyFolderCheckTests {
    private func claude(company: ClaudeSetupState.Part, permissions: PermissionReading = PermissionReading(userRule: .allowed))
        -> ClaudeSetupState
    {
        var state = CheckFixtures.claudeReady()
        state.otherFolders = [ClaudeFolderState(folder: .company, mcp: company, permissions: permissions)]
        return state
    }

    @Test func aCompanyFolderWithoutTheServerIsNotSaidToBeFine() throws {
        let status = try CheckFixtures.healthy()
        let state = claude(company: .missing)
        let issues = StatusEvaluator.claudeIssues(in: state)
        #expect(issues.map(\.sentence) == ["~/.claude-ubion의 Claude Code에 CUA가 연결되지 않았어요"])
        let card = StatusEvaluator.problem(in: status, appVersion: CheckFixtures.appVersion, facts: LocalFacts(claude: state))
        #expect(card?.title == "~/.claude-ubion의 Claude Code에 CUA가 연결되지 않았어요")
        #expect(card?.fix == .runSetup)
        let line = try #require(CheckFixtures.content(status, claude: state).line(.mcp))
        #expect(line.status == .problem)
        #expect(line.detail == CheckContent.fixedOnCard)
        #expect(line.facts?.contains("~/.claude-ubion ~/.claude-ubion의 Claude Code에 CUA가 연결되지 않았어요") == true)
        #expect(line.facts?.contains("~/.claude 앱의 엔진에 연결됨") == true)
    }

    @Test func bothFoldersReadyNamesThemAndTellsWhichCodexAccountRuns() throws {
        let line = try #require(CheckFixtures.content(try CheckFixtures.healthy(), claude: claude(company: .ready)).line(.mcp))
        #expect(line.status == .ready)
        #expect(line.detail == "앱의 엔진에 연결돼 있어요 · ~/.claude, ~/.claude-ubion")
        #expect(line.steps == [CheckContent.codexAccountStep(.company)])
        #expect(CheckContent.codexAccountStep(.company).contains("데스크톱 Codex(~/.codex 계정)"))
    }

    @Test func withoutTheCompanyFolderTheLineIsAsBefore() throws {
        let line = try #require(CheckFixtures.content(try CheckFixtures.healthy()).line(.mcp))
        #expect(line == CheckLine(item: .mcp, status: .ready, detail: "앱의 엔진에 연결돼 있어요", facts: "앱의 엔진에 연결됨"))
    }

    @Test func aConflictInTheCompanyFolderGivesThatFoldersCommand() throws {
        let status = try CheckFixtures.healthy()
        let state = claude(company: .conflict)
        let card = StatusEvaluator.problem(in: status, appVersion: CheckFixtures.appVersion, facts: LocalFacts(claude: state))
        #expect(card?.kind == .claudeConflict)
        let line = try #require(CheckFixtures.content(status, claude: state).line(.mcp))
        #expect(line.status == .problem)
        #expect(line.detail.hasPrefix("~/.claude-ubion에 앱이 깔지 않은 cuabar MCP가 있어요"))
        #expect(line.commands.map(\.text) == [#"CLAUDE_CONFIG_DIR="$HOME/.claude-ubion" claude mcp remove -s user cuabar"#])
    }

    @Test func leftoversInTheCompanyFolderAreToldWithItsName() throws {
        var state = claude(company: .ready)
        state.otherFolders[0].legacyPlugins = ["cua@ubion"]
        state.otherFolders[0].retiredSkill = true
        let line = try #require(CheckFixtures.content(try CheckFixtures.healthy(), claude: state).line(.mcp))
        #expect(line.status == .problem)
        #expect(line.detail == "~/.claude-ubion: " + LegacyPlugin.notice)
        #expect(line.commands.map(\.text) == [
            #"CLAUDE_CONFIG_DIR="$HOME/.claude-ubion" claude plugin uninstall cua@ubion --scope user"#,
            "rm -rf ~/.claude-ubion/skills/cuabar",
        ])
    }

    @Test func theCompanyFolderWithoutTheRuleIsAdvisedOnItsOwn() throws {
        let state = claude(company: .ready, permissions: PermissionReading(defaultMode: "auto"))
        let line = try #require(CheckFixtures.content(try CheckFixtures.healthy(), claude: state).line(.permissions))
        #expect(line.status == .advice)
        #expect(line.detail == "~/.claude-ubion의 Claude Code는 auto 모드에서도 CUA를 부를 때마다 물을 수 있어요")
        #expect(line.steps == [CheckContent.allowRuleStep(in: .company)])
        #expect(line.commands.map(\.text) == [CuabarRule.allowAll])
        #expect(line.facts == "사용자 설정이 cuabar 허용, 기본 모드 정하지 않음, ~/.claude-ubion 사용자 설정에 cuabar 규칙 없음, ~/.claude-ubion 기본 모드 auto")
    }

    @Test func anUnreadableCompanySettingsFileIsUnknown() throws {
        let state = claude(company: .ready, permissions: PermissionReading(unreadable: true))
        let line = try #require(CheckFixtures.content(try CheckFixtures.healthy(), claude: state).line(.permissions))
        #expect(line.status == .unknown)
        #expect(line.detail == "~/.claude-ubion/settings.json을 읽지 못했어요")
    }
}
