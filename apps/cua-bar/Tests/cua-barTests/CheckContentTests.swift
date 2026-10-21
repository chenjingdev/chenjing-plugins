import Foundation
import Testing
@testable import cua_bar

/// The inputs of the 점검 tab the way the model makes them: the card is what the evaluator says about the same
/// status and facts, so a test of the tab is also a test that the tab and the card judge alike.
enum CheckFixtures {
    static let appVersion = "0.7.0"
    static let claudePath = "/Users/x/.local/bin/claude"

    static func healthy() throws -> EngineStatus { try Fixtures.status("status-ready") }

    static func claudeReady() -> ClaudeSetupState {
        ClaudeSetupState(claudeCodeFound: true, claudeCodePath: claudePath, mcp: .ready, skill: .ready)
    }

    /// `codexMissing`: what the model knows when the engine cannot be asked (the app looked and there is no Codex), which
    /// puts the Codex card over the status card.
    static func input(
        _ status: EngineStatus?, error: EngineError? = nil, claude: ClaudeSetupState = claudeReady(), developerTools: Bool = false,
        codexMissing: Bool = false,
        loginItem: LoginItemReading? = LoginItemReading(.enabled, "켜짐"), login: LoginEnvironmentReading? = nil, fixTried: Bool = false,
        probe: ProbeRecord? = nil, probing: Bool = false, installing: Bool = false
    ) -> CheckInput {
        let facts = LocalFacts(claude: claude, developerToolsNeeded: developerTools, codexMissing: codexMissing)
        let card: Problem?
        if let status {
            card = StatusEvaluator.problem(in: status, appVersion: appVersion, facts: facts)
        } else if let error {
            card = StatusEvaluator.summary(for: error, facts: facts).problem
        } else {
            card = nil
        }
        return CheckInput(
            status: status, error: error, appVersion: appVersion, claude: claude, developerToolsNeeded: developerTools, card: card,
            loginItem: loginItem, login: login, fixTried: fixTried, probe: probe, probing: probing, installing: installing,
            now: Fixtures.now, calendar: Fixtures.utc, appLauncherValue: "/Users/x/.local/share/codex-cua/start-desktop-cli.sh")
    }

    static func content(
        _ status: EngineStatus?, error: EngineError? = nil, claude: ClaudeSetupState = claudeReady(), developerTools: Bool = false,
        codexMissing: Bool = false,
        loginItem: LoginItemReading? = LoginItemReading(.enabled, "켜짐"), login: LoginEnvironmentReading? = nil, fixTried: Bool = false,
        probe: ProbeRecord? = nil, probing: Bool = false, installing: Bool = false
    ) -> CheckContent {
        CheckContent(input(
            status, error: error, claude: claude, developerTools: developerTools, codexMissing: codexMissing, loginItem: loginItem,
            login: login, fixTried: fixTried, probe: probe, probing: probing, installing: installing))
    }

    /// The copied text without the lines of the 점검 tab, for tests that look at the rest of it.
    static func withoutCheckLines(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false).filter { !$0.hasPrefix("점검 ") }.joined(separator: "\n")
    }
}

struct CheckContentTests {
    private func status(_ change: (inout EngineStatus) -> Void) throws -> EngineStatus {
        var status = try CheckFixtures.healthy()
        status.engine.version = CheckFixtures.appVersion
        change(&status)
        return status
    }

    // MARK: Everything is fine

    @Test func everythingFineGivesNineReadyLinesInTheOrderOfTheSpec() throws {
        let content = CheckFixtures.content(try status { _ in })
        #expect(content.lines.map(\.item) == [.claudeCode, .mcp, .skill, .engine, .python, .wrapper, .relay, .loginItem, .host])
        #expect(content.lines.map(\.title) == [
            "Claude Code", "MCP", "스킬", "엔진", "파이썬 환경", "Codex 래퍼와 로그인 설정", "중계기", "앱 로그인 항목", "Codex 호스트와 연결 시험",
        ])
        #expect(content.lines.map(\.status) == Array(repeating: .ready, count: 9))
        #expect(content.problemCount == 0)
        #expect(content.headline == "점검 결과")
        #expect(content.lines.allSatisfy { !$0.detail.isEmpty })
        #expect(content.lines.allSatisfy { $0.steps.isEmpty && $0.commands.isEmpty })
        // The only button of a fine tab is the connection test.
        #expect(content.lines.compactMap(\.button).map(\.title) == ["연결 시험"])
    }

    @Test func aLineIsAStateAndOneShortSentence() throws {
        let content = CheckFixtures.content(try status { _ in })
        for line in content.lines {
            #expect(!line.detail.contains("\n"))
            #expect(line.detail.count < 60, "\(line.title): \(line.detail)")
        }
    }

    // MARK: A broken line the card carries

    @Test func aBrokenLineTheCardCarriesSaysOnlyFixItOnTheCard() throws {
        var claude = CheckFixtures.claudeReady()
        claude.mcp = .missing
        claude.skill = .outdated
        let broken = try status { status in
            status.engine.version = "0.6.0"
            status.setup.dependencies = "missing"
            status.setup.wrapper = "broken"
            status.setup.relay = "unavailable"
        }
        let input = CheckFixtures.input(broken, claude: claude)
        #expect(input.card?.kind == .setupIncomplete, "the card carries all of them: one 고치기")
        let content = CheckContent(input)
        for item in [CheckItem.mcp, .skill, .engine, .python, .wrapper, .relay] {
            let line = try #require(content.line(item))
            #expect(line.status == .problem, "\(item)")
            #expect(line.detail == "위 카드에서 고쳐요", "\(item)")
            #expect(line.button == nil && line.commands.isEmpty, "\(item): the fix is on the card, not here")
            #expect(line.facts != nil, "\(item): the copied diagnosis still says what is wrong")
        }
        #expect(content.line(.claudeCode)?.status == .ready)
        #expect(content.line(.loginItem)?.status == .ready)
        #expect(content.problemCount == 6)
        #expect(content.headline == "점검 결과 · 문제 6개")
    }

    @Test func theTabAndTheCardJudgeFromTheSameList() throws {
        // Each broken part the evaluator lists is exactly a line that says to fix it on the card.
        var claude = CheckFixtures.claudeReady()
        claude.skill = .missing
        let broken = try status { $0.setup.relay = "unavailable"; $0.setup.loginEnvironment = "stale" }
        let input = CheckFixtures.input(broken, claude: claude)
        let listed = Set((StatusEvaluator.setupIssues(in: broken.setup) + StatusEvaluator.claudeIssues(in: claude)).map(\.item))
        #expect(listed == [.relay, .wrapper, .skill])
        let content = CheckContent(input)
        let carried = Set(content.lines.filter { $0.detail == "위 카드에서 고쳐요" }.map(\.item))
        #expect(carried == listed)
        #expect(StatusEvaluator.itemsOnCard(status: broken, error: nil, appVersion: "0.7.0", claude: claude, card: input.card) == listed)
    }

    @Test func withoutTheCodexAppOnlyTheCodexLineIsAProblemAndWhatTheInstallWouldPutRightWaits() throws {
        var claude = CheckFixtures.claudeReady()
        claude.mcp = .missing
        claude.skill = .missing
        let broken = try status {
            $0.codex.installed = false; $0.codex.running = false; $0.host.state = .missing
            $0.engine.version = "0.6.0"; $0.setup.dependencies = "missing"; $0.setup.relay = "unavailable"
        }
        let input = CheckFixtures.input(broken, claude: claude)
        #expect(input.card?.kind == .codexMissing, "the card says only that")
        let content = CheckContent(input)
        let host = try #require(content.line(.host))
        #expect(host.status == .problem && host.detail == "위 카드에서 고쳐요" && host.facts == "Codex 앱이 없어요")
        // F1: the install is put off until there is a Codex, so no line promises a fix or shows a problem nobody can fix.
        for item in [CheckItem.engine, .mcp, .skill, .python, .wrapper, .relay] {
            let line = try #require(content.line(item))
            #expect(line.status == .waiting && line.detail == "Codex가 생기면 맞춰요", "\(item)")
            #expect(line.steps.isEmpty && line.commands.isEmpty && line.button == nil, "\(item)")
        }
        #expect(content.line(.claudeCode)?.status == .ready, "what does not depend on Codex says what it has to say")
        #expect(content.line(.loginItem)?.status == .ready)
        #expect(content.problemCount == 1)
        #expect(content.headline == "점검 결과 · 문제 1개")
    }

    @Test func withoutTheCodexAppAndNoStatusToReadTheHeadIsStillOneProblem() throws {
        // The install does nothing without Codex, so the engine is never unpacked and the status is always `engineMissing`.
        for developerTools in [false, true] {
            var claude = CheckFixtures.claudeReady()
            claude.mcp = .missing
            let input = CheckFixtures.input(nil, error: .engineMissing, claude: claude, developerTools: developerTools, codexMissing: true)
            #expect(input.card?.kind == .codexMissing)
            let content = CheckContent(input)
            let host = try #require(content.line(.host))
            #expect(host.status == .problem && host.detail == "위 카드에서 고쳐요", "Codex's line, not 모름")
            #expect(host.facts == "Codex 앱이 없어요")
            for item in [CheckItem.engine, .mcp, .skill, .python, .wrapper, .relay] {
                #expect(content.line(item)?.status == .waiting && content.line(item)?.detail == "Codex가 생기면 맞춰요", "\(item)")
            }
            #expect(content.problemCount == 1)
            #expect(content.diagnosisLines.count == 9)
        }
    }

    @Test func withoutCodexAndWithoutClaudeCodeBothLinesWaitAndTheOldPluginIsStillTold() throws {
        var claude = ClaudeSetupState.none
        let content = CheckFixtures.content(nil, error: .engineMissing, claude: claude, codexMissing: true)
        #expect(content.line(.claudeCode)?.status == .waiting)
        #expect(content.line(.host)?.detail == "위 카드에서 고쳐요")
        #expect(content.problemCount == 1)
        claude.legacyPlugin = true
        let withPlugin = CheckFixtures.content(nil, error: .engineMissing, claude: claude, codexMissing: true)
        #expect(withPlugin.line(.mcp)?.detail == LegacyPlugin.notice, "a leftover with its own fix on the line is still told")
        #expect(withPlugin.problemCount == 2)
    }

    // MARK: When there is no status, the card still carries what its button does

    @Test func theLinesOfClaudeCodesPartsAreFixedOnTheCardWhenTheEngineIsMissingAndTheCardInstallsEverything() throws {
        var claude = CheckFixtures.claudeReady()
        claude.mcp = .missing
        claude.skill = .outdated
        let input = CheckFixtures.input(nil, error: .engineMissing, claude: claude)
        #expect(input.card?.kind == .setupIncomplete && input.card?.fix == .runSetup)
        let content = CheckContent(input)
        for item in [CheckItem.engine, .mcp, .skill] {
            let line = try #require(content.line(item))
            #expect(line.status == .problem && line.detail == "위 카드에서 고쳐요", "\(item)")
            #expect(line.commands.isEmpty && line.button == nil, "\(item)")
        }
        #expect(content.line(.python)?.status == .unknown, "what needs the engine's answer cannot be told")
        // A part that is fine is not claimed by the card.
        claude.skill = .ready
        let mcpOnly = CheckFixtures.content(nil, error: .engineMissing, claude: claude)
        #expect(mcpOnly.line(.skill)?.status == .ready && mcpOnly.line(.mcp)?.detail == "위 카드에서 고쳐요")
    }

    @Test func theDeveloperToolsCardAlsoCarriesTheLinesOfWhatItInstalls() throws {
        var claude = CheckFixtures.claudeReady()
        claude.mcp = .missing
        claude.skill = .missing
        let input = CheckFixtures.input(nil, error: .engineMissing, claude: claude, developerTools: true)
        #expect(input.card?.kind == .developerToolsNeeded && input.card?.fix == .installDeveloperTools)
        let content = CheckContent(input)
        for item in [CheckItem.engine, .python, .mcp, .skill] {
            let line = try #require(content.line(item))
            #expect(line.status == .problem && line.detail == "위 카드에서 고쳐요", "\(item)")
            #expect(line.button == nil, "\(item): the one button is the card's")
        }
        #expect(StatusEvaluator.itemsOnCard(status: nil, error: .engineMissing, appVersion: "0.7.0", claude: claude, card: input.card) == [.engine, .python, .mcp, .skill])
    }

    @Test func withoutClaudeCodeTheCardsInstallLeavesTheMcpAndSkillLinesWaiting() throws {
        let content = CheckFixtures.content(nil, error: .engineMissing, claude: .none)
        #expect(content.line(.engine)?.detail == "위 카드에서 고쳐요")
        #expect(content.line(.mcp)?.status == .waiting && content.line(.skill)?.status == .waiting)
    }

    @Test func aSlowEngineHasNoCardForTheLinesToPointAt() throws {
        var claude = CheckFixtures.claudeReady()
        claude.mcp = .missing
        let content = CheckFixtures.content(nil, error: .timeout, claude: claude)
        #expect(content.line(.mcp)?.detail == "Claude Code에 CUA가 연결되지 않았어요", "the card is 다시 읽기, not the install")
        #expect(content.line(.engine)?.status == .unknown)
    }

    // MARK: A broken line the card does not carry

    @Test func developerToolsWithNothingElseToInstallAreAButtonOnThePythonLine() throws {
        let content = CheckFixtures.content(try status { _ in }, developerTools: true)
        let line = try #require(content.line(.python))
        #expect(line.status == .problem)
        #expect(line.detail == "개발자 도구 필요")
        let button = try #require(line.button)
        #expect(button.title == "설치" && button.action == .installDeveloperTools && button.isEnabled)
        #expect(StatusEvaluator.problem(in: try status { _ in }, appVersion: "0.7.0", facts: LocalFacts(claude: CheckFixtures.claudeReady(), developerToolsNeeded: true)) == nil, "the card does not carry it")
    }

    @Test func developerToolsTheCardAsksForAreFixedOnTheCard() throws {
        var claude = CheckFixtures.claudeReady()
        claude.mcp = .missing
        let content = CheckFixtures.content(try status { _ in }, claude: claude, developerTools: true)
        let line = try #require(content.line(.python))
        #expect(line.detail == "위 카드에서 고쳐요")
        #expect(line.button == nil)
        #expect(line.facts == "개발자 도구 필요")
    }

    @Test func aCuaMcpServerTheAppDidNotPutThereIsToldWithTheCommandThatRemovesIt() throws {
        var claude = CheckFixtures.claudeReady()
        claude.mcp = .conflict
        let content = CheckFixtures.content(try status { _ in }, claude: claude)
        let line = try #require(content.line(.mcp))
        #expect(line.status == .problem)
        #expect(line.detail == "앱이 깔지 않은 cua MCP가 있어요 — 그대로 뒀어요")
        #expect(line.commands.map(\.text) == ["claude mcp remove -s user cua"])
        // The command is handed over to copy, never run by the app.
        #expect(line.commands.first?.copy.action == .copyCommand("claude mcp remove -s user cua", on: .mcp))
        #expect(line.button == nil)
        #expect(content.problemCount == 1)
    }

    @Test func aCuaSkillTheAppDidNotPutThereIsToldWithTheWayToRemoveIt() throws {
        var claude = CheckFixtures.claudeReady()
        claude.skill = .conflict
        let line = try #require(CheckFixtures.content(try status { _ in }, claude: claude).line(.skill))
        #expect(line.status == .problem)
        #expect(line.detail == "앱이 깔지 않은 cua 스킬이 있어요 — 그대로 뒀어요")
        // Moved out of the skills folder (another name in there would be read as a skill), never removed, and not by the app.
        #expect(line.commands.map(\.text) == ["mv ~/.claude/skills/cua ~/cua-skill-backup"])
        #expect(line.commands.first?.copy.action == .copyCommand("mv ~/.claude/skills/cua ~/cua-skill-backup", on: .skill))
        #expect(line.steps.first?.contains("옮겨 두세요") == true)
        #expect(!line.steps.joined().contains("지워 주세요") && !line.commands.map(\.text).joined().contains("rm "))
        #expect(line.steps.joined().contains("앱은 옮기거나 지우지 않아요"))
    }

    @Test func theOldPluginIsTwoCuasAndTheLineGivesTheCommandThatRemovesIt() throws {
        var claude = CheckFixtures.claudeReady()
        claude.legacyPlugin = true
        let line = try #require(CheckFixtures.content(try status { _ in }, claude: claude).line(.mcp))
        #expect(line.status == .problem)
        #expect(line.detail == LegacyPlugin.notice)
        #expect(line.commands.map(\.text) == [LegacyPlugin.removeCommand])
        #expect(line.commands.first?.copy.action == .copyCommand(LegacyPlugin.removeCommand, on: .mcp))
        // Both a conflicting server and the old plugin: both are told.
        claude.mcp = .conflict
        let both = try #require(CheckFixtures.content(try status { _ in }, claude: claude).line(.mcp))
        #expect(both.commands.map(\.text) == ["claude mcp remove -s user cua", LegacyPlugin.removeCommand])
    }

    // MARK: Claude Code

    @Test func withoutClaudeCodeOnlyItsLineSaysSoAndTheCardStaysQuiet() throws {
        let ready = try status { _ in }
        let claude = ClaudeSetupState.none
        let content = CheckFixtures.content(ready, claude: claude)
        let line = try #require(content.line(.claudeCode))
        #expect(line.status == .waiting && line.detail == "찾지 못했어요")
        #expect(line.commands.map(\.text) == ["curl -fsSL https://claude.ai/install.sh | bash"])
        #expect(line.steps.count == 1, "how to get it, in one line")
        #expect(content.line(.mcp)?.status == .waiting && content.line(.skill)?.status == .waiting)
        #expect(content.line(.mcp)?.detail == "Claude Code가 생기면 연결해요")
        // R12: no problem on the card or the icon for this.
        let summary = StatusEvaluator.evaluate(ready, appVersion: "0.7.0", facts: LocalFacts(claude: claude))
        #expect(summary.problem == nil && summary.icon == .ready)
    }

    @Test func aClaudeCodeThatCannotStartNamesItsPathAndAsksToTryItInTheTerminal() throws {
        var claude = CheckFixtures.claudeReady()
        claude.claudeCodeUnusable = true
        claude.mcp = .unknown
        claude.skill = .unknown
        let content = CheckFixtures.content(try status { _ in }, claude: claude)
        let line = try #require(content.line(.claudeCode))
        #expect(line.status == .problem && line.detail == "찾았지만 시작하지 못했어요")
        #expect(line.steps == ["/Users/x/.local/bin/claude — 터미널에서 그 claude가 도는지 확인해 주세요"])
        #expect(line.diagnosisLine.contains("/Users/x/.local/bin/claude"))
        #expect(content.line(.mcp)?.status == .waiting)
        #expect(StatusEvaluator.claudeIssues(in: claude).isEmpty, "and the card says nothing about it")
    }

    @Test func aClaudeCodeThatIsThereNamesItsPath() throws {
        let line = try #require(CheckFixtures.content(try status { _ in }).line(.claudeCode))
        #expect(line.status == .ready && line.detail.contains(CheckFixtures.claudePath))
    }

    // MARK: Codex, the host and the connection test

    @Test func withCodexOffTheTestIsSkippedAndTheLineSaysWhenItTurnsOn() throws {
        let off = try status { $0.codex.running = false; $0.codex.pids = []; $0.host.state = .closed }
        let line = try #require(CheckFixtures.content(off, probe: ProbeRecord(outcome: .checked, at: Fixtures.now)).line(.host))
        #expect(line.status == .waiting)
        #expect(line.detail == "Claude 대화를 열면 켜져요")
        #expect(line.button == nil, "no test button while there is no host: nothing is started for a test")
        #expect(line.facts?.contains("건너뜀") == true)
        #expect(!line.detail.contains("통과"), "an old result is not shown for a Codex that is off")
    }

    @Test func aHostThatIsReadyShowsTheLastResultItsTimeAndTheTestButton() throws {
        let ready = try status { _ in }
        let none = try #require(CheckFixtures.content(ready).line(.host))
        #expect(none.status == .ready && none.detail == "연결됐어요 — 아직 시험하지 않았어요")
        #expect(none.button == ButtonSpec(title: "연결 시험", action: .runProbe, isEnabled: true, help: none.button?.help ?? ""))

        let at = Fixtures.now.addingTimeInterval(-300)
        let passed = try #require(CheckFixtures.content(ready, probe: ProbeRecord(outcome: .checked, at: at)).line(.host))
        #expect(passed.status == .ready)
        #expect(passed.detail == "연결 시험을 통과했어요 · 11:55")
        #expect(passed.button?.isEnabled == true)
    }

    @Test func aTestThatFailedTimedOutOrCouldNotRunIsAProblemOnTheLine() throws {
        let ready = try status { _ in }
        let expected: [(ProbeOutcome, String)] = [
            (.failed, "연결 시험이 실패했어요"), (.timeout, "연결 시험이 시간 안에 끝나지 않았어요"),
            (.approvalRequired, "Codex에서 승인이 필요해요"), (.cleanupUnconfirmed, "시험은 됐지만 뒷정리를 확인하지 못했어요"),
            (.couldNotRun, "연결 시험을 실행하지 못했어요"),
        ]
        for (outcome, sentence) in expected {
            let line = try #require(CheckFixtures.content(ready, probe: ProbeRecord(outcome: outcome, at: Fixtures.now)).line(.host))
            #expect(line.status == .problem, "\(outcome)")
            #expect(line.detail == sentence + " · 12:00", "\(outcome)")
            #expect(line.button?.action == .runProbe, "\(outcome): and it can be tried again")
        }
    }

    @Test func theButtonWaitsWhileATestRuns() throws {
        let line = try #require(CheckFixtures.content(try status { _ in }, probing: true).line(.host))
        #expect(line.detail == "연결 시험을 하는 중이에요…")
        #expect(line.button?.isEnabled == false, "pressing it again would start another test")
    }

    @Test func aHostThatIsStartingOrStoppingHasNoTestButton() throws {
        for (state, sentence) in [(HostState.starting, "Codex가 켜지는 중이에요 — 켜지면 시험할 수 있어요"), (.stopping, "Codex가 꺼지는 중이에요")] {
            let line = try #require(CheckFixtures.content(try status { $0.host.state = state }).line(.host))
            #expect(line.status == .waiting && line.detail == sentence && line.button == nil)
        }
    }

    @Test func codexRunningWithoutItsHostIsFixedOnTheCard() throws {
        let content = CheckFixtures.content(try status { $0.host.state = .closed })
        let line = try #require(content.line(.host))
        #expect(line.status == .problem && line.detail == "위 카드에서 고쳐요" && line.button == nil)
    }

    @Test func codexRunningWhoseHostStateTheEngineDidNotSayIsTheSameProblemAsTheCardSays() throws {
        let unsaid = try status { $0.host.state = .unknown("") }
        let input = CheckFixtures.input(unsaid)
        #expect(input.card?.kind == .codexWithoutHost && input.card?.fix == .restartCodex)
        let line = try #require(CheckContent(input).line(.host))
        #expect(line.status == .problem && line.detail == "위 카드에서 고쳐요" && line.button == nil)
        // A Codex that is off with the same empty state is simply off.
        let off = try status { $0.host.state = .unknown(""); $0.codex.running = false; $0.codex.pids = [] }
        #expect(CheckFixtures.content(off).line(.host)?.detail == "Claude 대화를 열면 켜져요")
    }

    @Test func theTestButtonWaitsWhileTheInstallRuns() throws {
        let ready = try status { _ in }
        let line = try #require(CheckFixtures.content(ready, installing: true).line(.host))
        #expect(line.button?.title == "연결 시험" && line.button?.isEnabled == false)
        #expect(line.button?.help == "설정하는 중이에요. 끝나면 시험할 수 있어요")
        #expect(CheckFixtures.content(ready, installing: false).line(.host)?.button?.isEnabled == true)
        // While a test runs, that is what the line says.
        let both = try #require(CheckFixtures.content(ready, probing: true, installing: true).line(.host))
        #expect(both.detail == "연결 시험을 하는 중이에요…" && both.button?.isEnabled == false)
    }

    @Test func aHostStartedByAnOlderLauncherSaysThatRestartingAppliesTheSetup() throws {
        let line = try #require(CheckFixtures.content(try status { $0.host.startedBeforeSetup = true; $0.host.engineVersion = "0.6.0" }).line(.host))
        #expect(line.status == .ready)
        #expect(line.steps == [StatusEvaluator.restartAppliesStep])
        #expect(line.facts?.contains("엔진 0.6.0로 켜짐") == true)
    }

    // MARK: The login environment

    @Test func aLoginEnvironmentThatIsSomebodyElsesAgentFileIsToldWithTheFileToMove() throws {
        let conflict = try status { $0.setup.loginEnvironment = "conflict" }
        let line = try #require(CheckFixtures.content(conflict, login: LoginEnvironmentReading(agentLabel: "com.other.thing", launchdValue: nil)).line(.wrapper))
        #expect(line.status == .problem)
        #expect(line.detail == "로그인 설정이 다른 값과 겹쳐요")
        #expect(line.steps.first?.contains("com.chenjingdev.codex-cua.env.plist") == true)
        #expect(line.steps.first?.contains("com.other.thing") == true)
        #expect(line.steps.joined().contains("다른 곳으로 옮긴 뒤"))
        #expect(line.commands.isEmpty && line.button == nil)
    }

    @Test func aWrapperThatIsBrokenBesideALoginConflictIsToldOnTheLineAndKeptInTheDiagnosis() throws {
        let both = try status { $0.setup.loginEnvironment = "conflict"; $0.setup.wrapper = "broken" }
        let input = CheckFixtures.input(both, login: LoginEnvironmentReading(agentLabel: nil, launchdValue: "/opt/other/codex-wrapper.sh"))
        #expect(input.card?.kind == .setupIncomplete, "the wrapper has the card; the conflict has the line")
        let line = try #require(CheckContent(input).line(.wrapper))
        #expect(line.detail == "로그인 설정이 다른 값과 겹쳐요")
        #expect(line.steps.contains("Codex 연결용 래퍼가 깨졌어요 — 위 카드에서 고쳐요"))
        #expect(line.steps.first == "launchd의 CODEX_CLI_PATH가 다른 값이에요: /opt/other/codex-wrapper.sh")
        #expect(line.diagnosisLine.contains("Codex 연결용 래퍼가 깨졌어요"))
        #expect(line.diagnosisLine.contains("CODEX_CLI_PATH=/opt/other/codex-wrapper.sh"))

        // A wrapper that is missing, with the card not carrying it (no Codex app: the card says only that): said without the pointer.
        var noCard = input
        noCard.card = nil
        let plain = try #require(CheckContent(noCard).line(.wrapper))
        #expect(plain.steps.contains("Codex 연결용 래퍼가 깨졌어요"))
        // Only a conflict: nothing is added.
        let only = try status { $0.setup.loginEnvironment = "conflict" }
        #expect(CheckFixtures.content(only, login: LoginEnvironmentReading(agentLabel: nil, launchdValue: "/x/y")).line(.wrapper)?.steps.count == 2)
    }

    @Test func aWrapperProblemBesideAStaleLoginThatTheFixLeftIsToldToo() throws {
        let stale = try status { $0.setup.loginEnvironment = "stale"; $0.setup.wrapper = "missing" }
        let login = LoginEnvironmentReading(agentLabel: nil, launchdValue: "/opt/other/codex-wrapper.sh")
        let line = try #require(CheckFixtures.content(stale, login: login, fixTried: true).line(.wrapper))
        #expect(line.detail == "로그인 설정이 옛 값이고, 고치기로는 바뀌지 않았어요")
        #expect(line.steps.contains("Codex 연결용 래퍼가 없어요 — 위 카드에서 고쳐요"))
        #expect(line.diagnosisLine.contains("Codex 연결용 래퍼가 없어요"))
        #expect(!line.steps.contains("로그인 환경이 옛 설정이에요"), "the stale login is the line itself, not said twice")
    }

    @Test func aLabelSomebodyElseChoseIsShownAndKeptInTheDiagnosisOnlyWhenItIsPlain() throws {
        let conflict = try status { $0.setup.loginEnvironment = "conflict" }
        let plain = try #require(CheckFixtures.content(conflict, login: LoginEnvironmentReading(agentLabel: "com.other.Thing_2-x", launchdValue: nil)).line(.wrapper))
        #expect(plain.steps.first?.contains("(라벨 com.other.Thing_2-x)") == true)
        #expect(plain.diagnosisLine.contains("남의 로그인 에이전트 라벨 com.other.Thing_2-x"))
        let long = String(repeating: "a", count: 101)
        for label in ["has space", "new\nline", "token=abc123", "한글라벨", long, "", "semi;colon", "a/b"] {
            let line = try #require(CheckFixtures.content(conflict, login: LoginEnvironmentReading(agentLabel: label, launchdValue: nil)).line(.wrapper))
            if !label.isEmpty { #expect(!line.diagnosisLine.contains(label), "\(label.prefix(12))") }
            #expect(!line.diagnosisLine.contains("라벨 "), "an unplain label is not named: \(label.prefix(12))")
            #expect(line.diagnosisLine.contains("남의 로그인 에이전트"), "but that it is somebody else's still is")
            #expect(line.steps.first?.contains("(라벨") == false)
            #expect(!line.diagnosisLine.contains("\n"))
        }
    }

    @Test func aLaunchdValueSomebodyElseSetIsShownWithAnUnsetCommandToCopy() throws {
        let conflict = try status { $0.setup.loginEnvironment = "conflict" }
        let login = LoginEnvironmentReading(agentLabel: nil, launchdValue: "/opt/other/codex-wrapper.sh")
        let line = try #require(CheckFixtures.content(conflict, login: login).line(.wrapper))
        #expect(line.steps.first == "launchd의 CODEX_CLI_PATH가 다른 값이에요: /opt/other/codex-wrapper.sh")
        #expect(line.steps.joined().contains("고치기를 눌러 주세요"))
        #expect(line.commands.map(\.text) == ["launchctl unsetenv CODEX_CLI_PATH"])
        #expect(line.commands.first?.copy.action == .copyCommand("launchctl unsetenv CODEX_CLI_PATH", on: .wrapper))
        // The card has no button for it and sends the person here.
        let card = StatusEvaluator.problem(in: conflict, appVersion: "0.7.0", facts: LocalFacts(claude: CheckFixtures.claudeReady()))
        #expect(card?.kind == .loginEnvironmentConflict && card?.fix == nil)
        #expect(card?.nextStep == "점검 탭에서 겹치는 값과 치우는 방법을 보세요")
    }

    @Test func aStaleLoginEnvironmentIsFixedOnTheCardUntilTheFixLeavesItAndTheValueIsNotTheApps() throws {
        let stale = try status { $0.setup.loginEnvironment = "stale" }
        let foreign = LoginEnvironmentReading(agentLabel: nil, launchdValue: "/opt/other/codex-wrapper.sh")
        // Before a fix was tried, or with the app's own value: the card fixes it.
        for (tried, login) in [(false, foreign), (true, LoginEnvironmentReading(agentLabel: nil, launchdValue: "/Users/x/.local/share/codex-cua/start-desktop-cli.sh")), (true, LoginEnvironmentReading(agentLabel: nil, launchdValue: nil))] {
            let line = try #require(CheckFixtures.content(stale, login: login, fixTried: tried).line(.wrapper))
            #expect(line.detail == "위 카드에서 고쳐요" && line.commands.isEmpty)
        }
        // After the fix, still stale, and launchd holds a value that is not the app's: the same guide as a conflict.
        let line = try #require(CheckFixtures.content(stale, login: foreign, fixTried: true).line(.wrapper))
        #expect(line.status == .problem)
        #expect(line.steps.first == "launchd의 CODEX_CLI_PATH가 다른 값이에요: /opt/other/codex-wrapper.sh")
        #expect(line.commands.map(\.text) == ["launchctl unsetenv CODEX_CLI_PATH"])
    }

    // MARK: The login item and the unreadable engine

    @Test func theLoginItemLineFollowsWhatBecameOfIt() throws {
        let ready = try status { _ in }
        let cases: [(LoginItemReading, CheckStatus)] = [
            (LoginItemReading(.enabled, "켜짐"), .ready),
            (LoginItemReading(.requiresApproval, "승인이 필요해요"), .problem),
            (LoginItemReading(.failed, "등록하지 못했어요"), .problem),
            (LoginItemReading(.notRegistered, "등록 안 함"), .waiting),
            (LoginItemReading(.turnedOff, "꺼짐"), .waiting),
        ]
        for (reading, expected) in cases {
            let line = try #require(CheckFixtures.content(ready, loginItem: reading).line(.loginItem))
            #expect(line.status == expected && line.detail == reading.detail, "\(reading.health)")
        }
        #expect(CheckFixtures.content(ready, loginItem: nil).line(.loginItem)?.status == .unknown)
    }

    @Test func whenTheEngineCannotBeReadTheLinesThatNeedItAreUnknownAndTheEngineIsFixedOnTheCard() throws {
        let missing = CheckFixtures.content(nil, error: .engineMissing)
        #expect(missing.line(.engine)?.detail == "위 카드에서 고쳐요")
        #expect(missing.line(.python)?.status == .unknown && missing.line(.wrapper)?.status == .unknown)
        #expect(missing.line(.relay)?.status == .unknown && missing.line(.host)?.status == .unknown)
        #expect(missing.line(.claudeCode)?.status == .ready, "what the app reads itself still shows")

        let slow = CheckFixtures.content(nil, error: .timeout)
        #expect(slow.line(.engine)?.status == .unknown)
        #expect(slow.line(.engine)?.detail == "응답이 없어 확인하지 못했어요")

        let loading = CheckFixtures.content(nil)
        #expect(loading.lines.filter { $0.item != .claudeCode && $0.item != .loginItem && $0.item != .mcp && $0.item != .skill }.allSatisfy { $0.status == .unknown && $0.detail == "확인하는 중이에요" })
    }

    @Test func anEngineOfAnotherVersionNamesBothVersionsInTheDiagnosis() throws {
        let line = try #require(CheckFixtures.content(try status { $0.engine.version = "0.6.0" }).line(.engine))
        #expect(line.detail == "위 카드에서 고쳐요")
        #expect(line.diagnosisLine == "점검 엔진: 문제 — 연결 엔진이 앱과 판이 달라요 (엔진 0.6.0, 앱 0.7.0)")
    }

    // MARK: The diagnosis

    @Test func theDiagnosisHasOneLineForEachLineWithNamesVersionsPathsAndStatesOnly() throws {
        var claude = CheckFixtures.claudeReady()
        claude.mcp = .conflict
        let content = CheckFixtures.content(
            try status { $0.setup.loginEnvironment = "conflict" }, claude: claude,
            login: LoginEnvironmentReading(agentLabel: nil, launchdValue: "/opt/other/codex-wrapper.sh"),
            probe: ProbeRecord(outcome: .timeout, at: Fixtures.now))
        let lines = content.diagnosisLines
        #expect(lines.count == 9)
        #expect(lines.map { $0.components(separatedBy: ":").first } == CheckItem.allCases.map { "점검 \($0.title)" })
        #expect(lines.allSatisfy { !$0.contains("\n") })
        #expect(lines[0] == "점검 Claude Code: 정상 — 경로 /Users/x/.local/bin/claude")
        #expect(lines[1].hasPrefix("점검 MCP: 문제"))
        #expect(lines[5].contains("CODEX_CLI_PATH=/opt/other/codex-wrapper.sh"))
        #expect(lines[8] == "점검 Codex 호스트와 연결 시험: 문제 — 켜져 있음, 연결 시험 timeout 12:00")
    }

    @Test func aValueThatIsNotOnePlainPathStaysOutOfTheDiagnosis() throws {
        let conflict = try status { $0.setup.loginEnvironment = "conflict" }
        for value in ["token=abc 123", "relative/path", "/with space/x", "/a\nb"] {
            let content = CheckFixtures.content(conflict, login: LoginEnvironmentReading(agentLabel: nil, launchdValue: value))
            #expect(content.line(.wrapper)?.diagnosisLine.contains("CODEX_CLI_PATH=") == false, "\(value)")
        }
    }
}
