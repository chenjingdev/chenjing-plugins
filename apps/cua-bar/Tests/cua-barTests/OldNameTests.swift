import Foundation
import Testing
@testable import cua_bar

/// CUA's old names left in Claude Code after the rename to cuabar (F9, R25, R26): what the app reads of them, how the
/// 점검 tab tells them with what to run or paste, and the line the update's notification adds. The app changes no file.
struct OldNameTests {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    private func settings(_ home: TempHome) -> URL { home.url.appendingPathComponent(".claude/settings.json") }

    /// A folder Claude Code was used in, with the settings file "다시 묻지 않기" writes there.
    @discardableResult
    private func project(_ home: TempHome, _ relative: String, local: String? = nil) throws -> String {
        let folder = home.url.appendingPathComponent(relative, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        if let local { try home.write(local, to: folder.appendingPathComponent(".claude/settings.local.json")) }
        return folder.path
    }

    private func listing(_ home: TempHome, _ folders: [String], servers: [String: Any] = [:]) throws {
        try home.writeClaudeConfig(["projects": Dictionary(uniqueKeysWithValues: folders.map { ($0, [String: Any]()) }), "mcpServers": servers])
    }

    private let oldRule = #"{"permissions": {"allow": ["mcp__cua__js"]}}"#

    // MARK: The names

    @Test func theOldToolNamesAreTheServerOf080AndTheOldPlugins() {
        for rule in ["mcp__cua", "mcp__cua__js", "mcp__cua__*", "mcp__plugin_cua_cua", "mcp__plugin_cua_cua__js_reset"] {
            #expect(OldToolNames.named(byRule: rule), "\(rule)")
        }
        for rule in ["mcp__cuabar", "mcp__cuabar__js", "mcp__cuax__js", "Bash(cua:*)", "mcp__plugin_cua_cuabar__js"] {
            #expect(!OldToolNames.named(byRule: rule), "\(rule)")
        }
        // A matcher is a pattern: an old tool name anywhere in it is old.
        #expect(OldToolNames.named(byMatcher: "mcp__cua__js"))
        #expect(OldToolNames.named(byMatcher: "Bash|mcp__plugin_cua_cua__.*"))
        #expect(OldToolNames.named(byMatcher: "mcp__cua"))
        #expect(!OldToolNames.named(byMatcher: "mcp__cuabar__.*"))
        #expect(!OldToolNames.named(byMatcher: "Bash"))
        #expect(CuabarRule.names("mcp__cuabar") && CuabarRule.names("mcp__cuabar__js") && CuabarRule.names("mcp__cuabar__*"))
        #expect(!CuabarRule.names("mcp__cuabarx") && !CuabarRule.names("mcp__cua__js"))
    }

    @Test func aSettingsFileIsReadForItsRulesItsModeAndItsHookMatchers() throws {
        #expect(SettingsFileReading(data: Data("not json".utf8)) == nil)
        #expect(SettingsFileReading(data: Data("[]".utf8)) == nil)
        let empty = try #require(SettingsFileReading(data: Data("{}".utf8)))
        #expect(!empty.oldRules && !empty.oldHooks && !empty.cuabarAllowed && !empty.cuabarAskedOrDenied && empty.defaultMode == nil)
        let text = #"""
        {"permissions": {"allow": ["Bash(ls:*)", "mcp__cuabar"], "deny": ["mcp__plugin_cua_cua__js"], "defaultMode": "auto"},
         "hooks": {"PreToolUse": [{"matcher": "mcp__cua__js", "hooks": [{"type": "command", "command": "true"}]}]}}
        """#
        let file = try #require(SettingsFileReading(data: Data(text.utf8)))
        #expect(file.oldRules && file.oldHooks && file.cuabarAllowed && !file.cuabarAskedOrDenied)
        #expect(file.defaultMode == "auto")
        let asked = try #require(SettingsFileReading(data: Data(#"{"permissions": {"ask": ["mcp__cuabar__js"]}}"#.utf8)))
        #expect(asked.cuabarAskedOrDenied && !asked.cuabarAllowed && !asked.oldRules)
        // Things of another shape are nothing, not a reason to fail.
        let odd = try #require(SettingsFileReading(data: Data(#"{"permissions": {"allow": "mcp__cua__js"}, "hooks": {"PreToolUse": "x"}}"#.utf8)))
        #expect(!odd.oldRules && !odd.oldHooks)
    }

    @Test func rulesForTheOldNamesCountOnlyWhileClaudeCodeStillAsksAboutCUAAndHooksAlways() {
        #expect(PermissionReading().needsAllowRule)
        #expect(!PermissionReading().hasOldNames)
        #expect(!PermissionReading(unreadable: true).needsAllowRule, "an unreadable file says nothing of its rules")
        #expect(!PermissionReading(defaultMode: "bypassPermissions").needsAllowRule)
        #expect(PermissionReading(defaultMode: "auto").needsAllowRule)
        #expect(!PermissionReading(userRule: .askedOrDenied).needsAllowRule, "the person chose to be asked")
        #expect(PermissionReading(oldRuleFiles: ["a"]).hasOldNames)
        #expect(!PermissionReading(userRule: .allowed, oldRuleFiles: ["a"]).hasOldNames)
        #expect(!PermissionReading(defaultMode: "bypassPermissions", oldRuleFiles: ["a"]).hasOldNames)
        #expect(PermissionReading(userRule: .askedOrDenied, oldRuleFiles: ["a"]).hasOldNames)
        #expect(PermissionReading(userRule: .allowed, oldHookFiles: ["a"]).hasOldNames, "a hook for an old name never runs again")
    }

    // MARK: Reading the files

    @Test func theOldServerAndSkillAreToldOnlyWhenTheyAreThe080App() throws {
        let home = try TempHome()
        defer { home.remove() }
        let claude = ClaudeIntegration(home: home.url)
        #expect(claude.leftovers(now: start) == ClaudeSetupState(permissions: PermissionReading()))
        try home.writeClaudeConfig(["mcpServers": ["cua": ["type": "stdio", "command": home.launcher, "args": []]]])
        #expect(claude.leftovers(now: start).oldServer)
        try home.writeClaudeConfig(["mcpServers": ["cua": ["type": "stdio", "command": "/opt/other/cua", "args": []]]])
        #expect(!claude.leftovers(now: start).oldServer, "somebody else's cua is not the app's to tell about")

        let skill = home.url.appendingPathComponent(".claude/skills/cua", isDirectory: true)
        try home.write("a skill\n", to: skill.appendingPathComponent("SKILL.md"))
        #expect(!claude.oldSkillPresent(), "no mark: somebody else's")
        try home.write(#"{"version": "0.8.0"}"#, to: skill.appendingPathComponent(".cua-bar.json"))
        #expect(claude.oldSkillPresent())
        #expect(claude.leftovers(now: start).hasOldNames)
    }

    @Test func bothOldPluginsAreToldEachWithItsOwnCommand() throws {
        let home = try TempHome()
        defer { home.remove() }
        let claude = ClaudeIntegration(home: home.url)
        try home.write(
            #"{"version": 2, "plugins": {"cua@ubion": [{"scope": "user"}], "cua@chenjing-plugins": [{"scope": "user"}]}}"#,
            to: claude.legacyRegistryURL)
        #expect(claude.recordedLegacyPlugins() == ["cua@chenjing-plugins", "cua@ubion"])
        #expect(LegacyPlugin.uninstallCommand(for: "cua@ubion") == "claude plugin uninstall cua@ubion --scope user")
        #expect(claude.leftovers(now: start).legacyPlugins == LegacyPlugin.ids)
    }

    @Test func theUserSettingsSayWhetherCUAIsAskedAbout() throws {
        let home = try TempHome()
        defer { home.remove() }
        let claude = ClaudeIntegration(home: home.url)
        #expect(claude.permissionReading(now: start) == PermissionReading(), "no file: no rule, nothing unreadable")
        try home.write("{ not json", to: settings(home))
        #expect(claude.permissionReading(now: start).unreadable)
        try home.write(#"{"permissions": {"allow": ["mcp__cuabar__js"], "defaultMode": "auto"}}"#, to: settings(home))
        #expect(claude.permissionReading(now: start) == PermissionReading(userRule: .allowed, defaultMode: "auto"))
        try home.write(#"{"permissions": {"deny": ["mcp__cuabar"]}}"#, to: settings(home))
        #expect(claude.permissionReading(now: start).userRule == .askedOrDenied)
        let hooked = #"{"permissions": {"allow": ["mcp__cua__js"]}, "hooks": {"PostToolUse": [{"matcher": "mcp__cua__.*", "hooks": []}]}}"#
        try home.write(hooked, to: settings(home))
        let reading = claude.permissionReading(now: start)
        #expect(reading.oldRuleFiles == ["~/.claude/settings.json"])
        #expect(reading.oldHookFiles == ["~/.claude/settings.json"])
    }

    @Test func theProjectFoldersAndTheTopsOfTheirRepositoriesAreReadForTheOldNames() throws {
        let home = try TempHome()
        defer { home.remove() }
        let plain = try project(home, "dev/plain", local: oldRule)
        // "다시 묻지 않기" saves at the top of the repository, not in the folder Claude Code ran in.
        let sub = try project(home, "dev/repo/app")
        try FileManager.default.createDirectory(at: home.url.appendingPathComponent("dev/repo/.git"), withIntermediateDirectories: true)
        try home.write(oldRule, to: home.url.appendingPathComponent("dev/repo/.claude/settings.json"))
        let hooks = try project(home, "dev/hooks")
        try home.write(
            #"{"hooks": {"PreToolUse": [{"matcher": "mcp__plugin_cua_cua__js", "hooks": []}]}}"#,
            to: URL(fileURLWithPath: hooks).appendingPathComponent(".claude/settings.json"))
        let clean = try project(home, "dev/clean", local: #"{"permissions": {"allow": ["mcp__cuabar"]}}"#)
        try listing(home, [plain, sub, hooks, clean])
        let reading = ClaudeIntegration(home: home.url).permissionReading(now: start)
        #expect(reading.oldRuleFiles == ["~/dev/plain/.claude/settings.local.json", "~/dev/repo/.claude/settings.json"])
        #expect(reading.oldHookFiles == ["~/dev/hooks/.claude/settings.json"])
        #expect(reading.userRule == .none, "a project's allow rule is not the user settings'")
    }

    @Test func foldersMacOSAsksAboutLinksAndFoldersOutsideTheHomeFolderAreNotRead() throws {
        let home = try TempHome()
        let other = try TempHome()
        defer {
            home.remove()
            other.remove()
        }
        let documents = try project(home, "Documents/notes", local: oldRule)
        let downloads = try project(home, "Downloads/x", local: oldRule)
        let library = try project(home, "Library/Mobile Documents/y", local: oldRule)
        let real = try project(home, "elsewhere/real", local: oldRule)
        let link = home.url.appendingPathComponent("dev/link")
        try FileManager.default.createDirectory(at: link.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(atPath: link.path, withDestinationPath: real)
        let outside = try project(other, "work", local: oldRule)
        let gone = home.url.appendingPathComponent("dev/gone").path
        let lowered = home.url.appendingPathComponent("documents/notes").path
        try listing(home, [documents, downloads, library, link.path, outside, gone, lowered])
        let claude = ClaudeIntegration(home: home.url)
        #expect(claude.projectSettingsFiles().isEmpty)
        #expect(claude.permissionReading(now: start).oldRuleFiles.isEmpty)
        // The same folder listed as itself is read: the link is what is left alone.
        try listing(home, [real])
        #expect(ClaudeIntegration(home: home.url).permissionReading(now: start).oldRuleFiles == ["~/elsewhere/real/.claude/settings.local.json"])
    }

    @Test func theProjectFoldersAreReadAtMostOnceAMinuteAndTheUserSettingsEveryTime() throws {
        let home = try TempHome()
        defer { home.remove() }
        let folder = try project(home, "dev/p")
        try listing(home, [folder])
        let claude = ClaudeIntegration(home: home.url)
        #expect(claude.permissionReading(now: start).oldRuleFiles.isEmpty)
        try home.write(oldRule, to: URL(fileURLWithPath: folder).appendingPathComponent(".claude/settings.local.json"))
        try home.write(#"{"permissions": {"allow": ["mcp__cuabar"]}}"#, to: settings(home))
        let soon = claude.permissionReading(now: start.addingTimeInterval(30))
        #expect(soon.oldRuleFiles.isEmpty, "the folders were looked at less than a minute ago")
        #expect(soon.userRule == .allowed, "the user settings are read every time")
        let copy = claude
        #expect(copy.permissionReading(now: start.addingTimeInterval(61)).oldRuleFiles == ["~/dev/p/.claude/settings.local.json"],
                "a copy shares the look")
        #expect(claude.permissionReading(now: start.addingTimeInterval(62)).oldRuleFiles == ["~/dev/p/.claude/settings.local.json"])
    }

    // MARK: The 점검 tab

    private func status() throws -> EngineStatus {
        var status = try CheckFixtures.healthy()
        status.engine.version = CheckFixtures.appVersion
        return status
    }

    private func line(_ claude: ClaudeSetupState, _ item: CheckItem = .permissions) throws -> CheckLine {
        try #require(CheckFixtures.content(try status(), claude: claude).line(item))
    }

    private func claude(_ permissions: PermissionReading?) -> ClaudeSetupState {
        var claude = CheckFixtures.claudeReady()
        claude.permissions = permissions
        return claude
    }

    @Test func withoutARuleForCUAThePermissionsLineAdvisesTheOneRuleWithACopyButton() throws {
        let advice = try line(claude(PermissionReading(defaultMode: "auto")))
        #expect(advice.status == .advice)
        #expect(advice.status.label == "안내")
        #expect(advice.detail == "auto 모드에서도 CUA를 부를 때마다 물을 수 있어요")
        #expect(advice.steps == [CheckContent.allowRuleStep])
        #expect(advice.steps[0].contains("/permissions") && advice.steps[0].contains("User settings"))
        #expect(advice.steps[0].contains("auto 모드 검사를 건너뛰어요"))
        #expect(advice.commands.map(\.text) == ["mcp__cuabar"])
        #expect(advice.commands.first?.copy.action == .copyCommand("mcp__cuabar", on: .permissions))
        #expect(advice.commands.first?.copy.help == CheckContent.allowRuleHelp)
        #expect(advice.diagnosisLine == "점검 허락 규칙: 안내 — 사용자 설정에 cuabar 규칙 없음, 기본 모드 auto")
        let content = CheckFixtures.content(try status(), claude: claude(PermissionReading()))
        #expect(content.problemCount == 0, "advice is not a problem")
        #expect(content.line(.permissions)?.diagnosisLine == "점검 허락 규칙: 안내 — 사용자 설정에 cuabar 규칙 없음, 기본 모드 정하지 않음")
    }

    @Test func aRuleOrAModeThatAsksNothingIsReady() throws {
        let allowed = try line(claude(PermissionReading(userRule: .allowed, defaultMode: "auto")))
        #expect(allowed.status == .ready && allowed.detail == "CUA를 부를 때 묻지 않아요" && allowed.commands.isEmpty)
        #expect(allowed.diagnosisLine == "점검 허락 규칙: 정상 — 사용자 설정이 cuabar 허용, 기본 모드 auto")
        let bypass = try line(claude(PermissionReading(defaultMode: "bypassPermissions")))
        #expect(bypass.status == .ready && bypass.detail == "권한 확인을 건너뛰는 모드라 묻지 않아요" && bypass.commands.isEmpty)
        let asked = try line(claude(PermissionReading(userRule: .askedOrDenied)))
        #expect(asked.status == .ready && asked.detail == "사용자 설정의 cuabar 규칙대로 해요" && asked.commands.isEmpty)
    }

    @Test func rulesAndHooksForTheOldNamesAreAProblemThatNamesTheFilesButTheDiagnosisOnlyCountsThem() throws {
        let files = ["~/dev/a/.claude/settings.local.json", "~/dev/b/.claude/settings.local.json", "~/dev/c/.claude/settings.json"]
        let old = try line(claude(PermissionReading(oldRuleFiles: files, oldHookFiles: ["~/.claude/settings.json"])))
        #expect(old.status == .problem)
        #expect(old.detail == "옛 도구 이름이 적힌 설정이 있어요 — 지금 CUA에는 맞지 않아요")
        #expect(old.steps[0] == "옛 이름의 허락 규칙: ~/dev/a/.claude/settings.local.json, ~/dev/b/.claude/settings.local.json 외 1곳")
        #expect(old.steps[2] == "옛 이름의 훅: ~/.claude/settings.json")
        #expect(old.steps.last == CheckContent.allowRuleStep, "the one rule is offered too")
        #expect(old.commands.map(\.text) == ["mcp__cuabar"])
        #expect(old.diagnosisLine == "점검 허락 규칙: 문제 — 옛 이름 규칙 3곳, 옛 이름 훅 1곳, 사용자 설정에 cuabar 규칙 없음, 기본 모드 정하지 않음")
        #expect(!old.diagnosisLine.contains("~/"), "no paths in the copied diagnosis")

        // With CUA allowed, the old rules change nothing and are not told; a hook still is.
        let hooked = try line(claude(PermissionReading(userRule: .allowed, oldRuleFiles: files, oldHookFiles: ["~/.claude/settings.json"])))
        #expect(hooked.status == .problem)
        #expect(hooked.steps.count == 2 && hooked.steps[0] == "옛 이름의 훅: ~/.claude/settings.json")
        #expect(hooked.commands.isEmpty)
        let quiet = try line(claude(PermissionReading(userRule: .allowed, oldRuleFiles: files)))
        #expect(quiet.status == .ready)
    }

    @Test func thePermissionsLineWaitsForClaudeCodeButNotForCodex() throws {
        let unreadable = try line(claude(PermissionReading(unreadable: true)))
        #expect(unreadable.status == .unknown && unreadable.detail == "~/.claude/settings.json을 읽지 못했어요" && unreadable.commands.isEmpty)
        #expect(try line(claude(nil)).status == .unknown)
        let without = try #require(CheckFixtures.content(try status(), claude: .none).line(.permissions))
        #expect(without.status == .waiting && without.detail == "Claude Code가 생기면 연결해요")
        let noCodex = CheckFixtures.content(nil, error: .engineMissing, claude: claude(PermissionReading()), codexMissing: true)
        #expect(noCodex.line(.permissions)?.status == .advice, "it is about Claude Code's settings, not what the install puts in")
    }

    @Test func theOldServerAndTheOldPluginsAreToldOnTheMCPLineWithEveryCommand() throws {
        var state = CheckFixtures.claudeReady()
        state.oldServer = true
        let server = try line(state, .mcp)
        #expect(server.status == .problem && server.detail == OldName.serverNotice)
        #expect(server.steps == ["아래 명령으로 지워 주세요. 앱은 지우지 않아요"])
        #expect(server.commands.map(\.text) == ["claude mcp remove -s user cua"])
        #expect(server.commands.first?.copy.action == .copyCommand("claude mcp remove -s user cua", on: .mcp))
        #expect(server.diagnosisLine == "점검 MCP: 문제 — 옛 이름 cua MCP 있음")

        state.legacyPlugins = LegacyPlugin.ids
        let all = try line(state, .mcp)
        #expect(all.detail == LegacyPlugin.notice)
        #expect(all.steps == ["아래 명령으로 지워 주세요. 앱은 지우지 않아요", OldName.serverNotice + " — 아래 명령으로 지워 주세요. 앱은 지우지 않아요"])
        #expect(all.commands.map(\.text) == [
            "claude plugin uninstall cua@chenjing-plugins --scope user", "claude plugin uninstall cua@ubion --scope user",
            "claude mcp remove -s user cua",
        ])
        #expect(all.diagnosisLine == "점검 MCP: 문제 — 옛 cua 플러그인 있음, 옛 이름 cua MCP 있음")

        // Without Codex the line waits, and the old server is still told.
        var waiting = CheckFixtures.claudeReady()
        waiting.oldServer = true
        let noCodex = CheckFixtures.content(nil, error: .engineMissing, claude: waiting, codexMissing: true)
        #expect(noCodex.line(.mcp)?.detail == OldName.serverNotice)
        #expect(noCodex.line(.mcp)?.diagnosisLine == "점검 MCP: 문제 — 옛 이름 cua MCP 있음")
    }

    @Test func theOldSkillIsToldOnTheMcpLineAndAfterAProblemThatIsAlreadyThere() throws {
        // Since 0.8.10 there is no skill line: Claude Code's side is the MCP server, and the skills left are told there.
        var state = CheckFixtures.claudeReady()
        state.oldSkill = true
        let skill = try line(state, .mcp)
        #expect(skill.status == .problem && skill.detail == OldName.skillNotice)
        #expect(OldName.skillNotice == "0.8.0이 깐 옛 이름 cua 스킬이 남아 있어요 — 이제 MCP가 안내해요")
        #expect(skill.commands.map(\.text) == ["rm -rf ~/.claude/skills/cua"])
        #expect(skill.commands.first?.copy.action == .copyCommand("rm -rf ~/.claude/skills/cua", on: .mcp))
        state.mcp = .conflict
        let both = try line(state, .mcp)
        #expect(both.detail == "앱이 깔지 않은 cuabar MCP가 있어요 — 그대로 뒀어요", "the line's own problem stays first")
        #expect(both.steps.last == OldName.skillNotice + " — 아래 명령으로 지워 주세요. 앱은 지우지 않아요")
        #expect(both.commands.map(\.text) == ["claude mcp remove -s user cuabar", "rm -rf ~/.claude/skills/cua"])
        #expect(both.diagnosisLine == "점검 MCP: 문제 — 앱이 깔지 않은 cuabar MCP, 옛 이름 cua 스킬 있음")
    }

    @Test func theOldNamesAreNotOnTheCardOrTheIcon() throws {
        var state = CheckFixtures.claudeReady()
        state.oldServer = true
        state.oldSkill = true
        state.retiredSkill = true
        state.permissions = PermissionReading(oldHookFiles: ["~/.claude/settings.json"])
        let summary = StatusEvaluator.evaluate(try status(), appVersion: CheckFixtures.appVersion, facts: LocalFacts(claude: state))
        #expect(summary.problem == nil)
        #expect(summary.icon == .ready)
    }

    // MARK: The update's notification

    @Test func theUpdatesLineIsTheOldNamesOrTheRuleInAutoModeAndNothingElse() {
        #expect(UpdateAdvice.line(for: ClaudeSetupState()) == nil, "not read: nothing to say")
        #expect(UpdateAdvice.line(for: ClaudeSetupState(permissions: PermissionReading())) == nil, "no mode chosen: the tab is enough")
        #expect(UpdateAdvice.line(for: ClaudeSetupState(permissions: PermissionReading(defaultMode: "auto"))) == UpdateAdvice.allowRule)
        #expect(UpdateAdvice.line(for: ClaudeSetupState(permissions: PermissionReading(userRule: .allowed, defaultMode: "auto"))) == nil)
        #expect(UpdateAdvice.line(for: ClaudeSetupState(permissions: PermissionReading(unreadable: true, defaultMode: "auto"))) == nil)
        #expect(UpdateAdvice.line(for: ClaudeSetupState(oldSkill: true, permissions: PermissionReading(defaultMode: "auto"))) == UpdateAdvice.oldNames)
        #expect(UpdateAdvice.line(for: ClaudeSetupState(legacyPlugins: ["cua@ubion"])) == UpdateAdvice.oldNames)
        #expect(UpdateAdvice.line(for: ClaudeSetupState(permissions: PermissionReading(oldRuleFiles: ["a"]))) == UpdateAdvice.oldNames)
        #expect(UpdateAdvice.line(for: ClaudeSetupState(retiredSkill: true, permissions: PermissionReading(defaultMode: "auto"))) == UpdateAdvice.retiredSkill,
                "the skill 0.8.x put in, before the rule")
        #expect(UpdateAdvice.line(for: ClaudeSetupState(oldServer: true, retiredSkill: true)) == UpdateAdvice.oldNames, "the old names first")
        #expect(UpdateAdvice.oldNames == "Claude Code에 CUA의 옛 이름이 남아 있어요 — 점검 탭을 보세요")
        #expect(UpdateAdvice.retiredSkill == "0.8.9까지 깐 cuabar 스킬이 남아 있어요 — 점검 탭을 보세요")
        #expect(UpdateAdvice.allowRule == "auto 모드에서도 묻지 않게 하는 규칙 한 줄이 점검 탭에 있어요")
    }

    @Test func theUpdatesNotificationWithTheLineOpensTheCheckTab() {
        let version = VersionNumber(0, 8, 6)
        let note = AppNotification.updated(version, advice: UpdateAdvice.oldNames)
        #expect(note.kind == .updatedCheck)
        #expect(note.key == "updated-0.8.6", "still the one notice of the update")
        #expect(note.body == "새 Claude 대화부터 새 판이 쓰여요. Claude Code에 CUA의 옛 이름이 남아 있어요 — 점검 탭을 보세요")
        #expect(NotificationResponse.make(tap: .body, kind: .updatedCheck, key: note.key) == .openPopover(.check))
        #expect(NotificationResponse.make(tap: .dismissed, kind: .updatedCheck, key: note.key) == nil)
        #expect(AppNotification.updated(version) == AppNotification.updated(version, advice: nil))
        #expect(AppNotification.updated(version).kind == .updated)
        #expect(note.appending(probe: .failed).body.hasSuffix(". 연결 시험이 실패했어요 — 점검 탭을 보세요"))
    }

    @MainActor @Test func theInstallAfterAnUpdateAddsTheLineWhenTheOldNamesAreLeft() async throws {
        let rig = try LiveSystemActionsTests().rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        try rig.home.write("a skill\n", to: rig.home.url.appendingPathComponent(".claude/skills/cua/SKILL.md"))
        try rig.home.write(#"{"version": "0.8.0"}"#, to: rig.home.url.appendingPathComponent(".claude/skills/cua/.cua-bar.json"))
        let seven = VersionNumber(0, 7, 0)
        try rig.notice.leave(version: seven)
        #expect(await rig.actions.setUp() == InstallMessages.nothingToSay)
        #expect(rig.announcements.posted == [AppNotification.updated(seven, advice: UpdateAdvice.oldNames)])
        #expect(FileManager.default.fileExists(atPath: rig.home.url.appendingPathComponent(".claude/skills/cua/SKILL.md").path), "the app removes nothing")
    }

    @MainActor @Test func theInstallAfterAnUpdateAddsTheLineWhenTheSkill08xPutInIsLeft() async throws {
        // 0.8.10 installs no skill: the update that brings it tells of the cuabar skill 0.8.x put in, and removes nothing.
        for marked in [true, false] {
            let rig = try LiveSystemActionsTests().rig()
            defer { rig.home.remove() }
            try rig.home.installClaudeCode()
            try rig.home.addSkill(version: marked ? "0.8.9" : nil)
            let seven = VersionNumber(0, 7, 0)
            try rig.notice.leave(version: seven)
            #expect(await rig.actions.setUp() == InstallMessages.nothingToSay)
            // Without the mark the folder is the person's own, and nothing is said of it.
            #expect(rig.announcements.posted == [AppNotification.updated(seven, advice: marked ? UpdateAdvice.retiredSkill : nil)])
            #expect(FileManager.default.fileExists(atPath: rig.home.skillFolder.appendingPathComponent("SKILL.md").path), "the app removes nothing")
        }
    }

    @MainActor @Test func whereNotificationsAreOffTheBannerSaysTheRuleInAutoMode() async throws {
        let rig = try LiveSystemActionsTests().rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        try rig.home.write(#"{"permissions": {"defaultMode": "auto"}}"#, to: settings(rig.home))
        rig.announcements.setDelivering(false)
        try rig.notice.leave(version: VersionNumber(0, 7, 0))
        let said = await rig.actions.setUp()
        #expect(said == ActionOutcome(
            kind: .success,
            message: "CUA Bar를 0.7.0로 올렸어요. 새 Claude 대화부터 새 판이 쓰여요. auto 모드에서도 묻지 않게 하는 규칙 한 줄이 점검 탭에 있어요"))
        #expect(rig.announcements.posted.first?.kind == .updatedCheck, "it was tried as the notification first")
    }
}
