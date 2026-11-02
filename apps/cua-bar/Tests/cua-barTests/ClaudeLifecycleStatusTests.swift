import Foundation
import Testing
@testable import cua_bar

struct ClaudeLifecycleStatusTests {
    @Test func hookStatusDecodesWithoutBreakingOlderOrMalformedEngineResponses() throws {
        for fields in ["", #""claude_hooks": null"#, #""claude_hooks": []"#, #""claude_hooks": true"#] {
            let status = try JSONDecoder().decode(EngineStatus.self, from: Data("{\"setup\":{\(fields)}}".utf8))
            #expect(status.setup.claudeHooks == nil)
            #expect(StatusEvaluator.claudeHooksIssue(in: status.setup) == nil)
        }
        let status = try JSONDecoder().decode(EngineStatus.self, from: Data(#"{"setup":{"claude_hooks":"ready"}}"#.utf8))
        #expect(status.setup.claudeHooks == "ready")
    }

    @Test(arguments: ["missing", "conflict", "failed", "disabled"])
    func brokenCleanupHooksAreARepairableProblemOnTheClaudeConnection(state: String) throws {
        var status = try CheckFixtures.healthy()
        status.setup.claudeHooks = state
        let input = CheckFixtures.input(status)
        #expect(input.card?.kind == .setupIncomplete)
        #expect(input.card?.fix == .runSetup)
        #expect(input.card?.title.contains("Claude 작업 종료") == true)
        let line = try #require(CheckContent(input).line(.mcp))
        #expect(line.status == .problem)
        #expect(line.detail == CheckContent.fixedOnCard)
        #expect(line.facts?.contains("Claude 작업 종료") == true)
        #expect(line.button == nil, "the existing card is the one place to repair the connection")
        if state == "disabled" { #expect(!line.steps.isEmpty) }
    }

    @Test func configuredCleanupHooksAreShownAsReadyAlongsideTheMcpConnection() throws {
        var status = try CheckFixtures.healthy()
        status.setup.claudeHooks = "ready"
        let input = CheckFixtures.input(status)
        #expect(input.card == nil)
        let line = try #require(CheckContent(input).line(.mcp))
        #expect(line.status == .ready)
        #expect(line.detail.contains("작업 종료 자동 처리"))
        #expect(line.steps.isEmpty && line.commands.isEmpty && line.button == nil)
    }

    @Test func noHooksForOlderEnginesOrMissingClaudeDoesNotInventAProblem() throws {
        let states: [String?] = [nil, "not_installed", "future-state"]
        for state in states {
            var status = try CheckFixtures.healthy()
            status.setup.claudeHooks = state
            #expect(StatusEvaluator.claudeHooksIssue(in: status.setup) == nil)
            #expect(CheckFixtures.input(status).card == nil)
            #expect(CheckFixtures.content(status).line(.mcp)?.status == .ready)
        }
    }
}
