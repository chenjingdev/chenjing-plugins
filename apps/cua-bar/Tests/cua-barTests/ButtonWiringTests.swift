import Foundation
import Testing
@testable import cua_bar

/// Every button the popover draws is a `ButtonSpec`; these tests check what each one is aimed
/// at and that pressing it really reaches the engine, without needing a window. A row has the one
/// button its state calls for (F3): 탭 풀기 while its AI is alive, 정리 once it is gone.
@MainActor
struct ButtonWiringTests {
    private func content(_ fixture: String) throws -> PopoverContent {
        PopoverContent(status: try Fixtures.status(fixture), now: Fixtures.now, calendar: Fixtures.utc)
    }

    private func liveRow(_ id: String, in content: PopoverContent) throws -> ConnectionRow {
        try #require(content.connections.groups.flatMap(\.rows).first { $0.id == id })
    }

    // MARK: What each button is

    @Test func everyLiveRowOffersOneTabReleaseAimedAtItsOwnConnection() throws {
        let content = try content("status-problem")
        for id in ["claude-12345-1792320000", "codex-15888-1792319000"] {
            let row = try liveRow(id, in: content)
            #expect(row.button.title == "탭 풀기")
            #expect(row.button.action == .releaseConnection(id))
            #expect(row.button.isDestructive == false)
        }
    }

    @Test func anEndedRowOffersTidyAimedAtItsOwnConnectionAndNothingElse() throws {
        let content = try content("status-problem")
        let ended = try #require(content.connections.tidy?.rows.compactMap(\.endedRow).first)
        #expect(ended.id == "claude-4001-1792300000")
        #expect(ended.button.title == "정리")
        #expect(ended.button.action == .tidy("claude-4001-1792300000"))
        #expect(ended.button.isDestructive == false)
    }

    @Test func noRowOffersStopForceStopOrAGroupButton() throws {
        // The old buttons are gone from every row of every fixture.
        for fixture in ["status-problem", "status-cmux", "status-ready", "status-working"] {
            let content = try content(fixture)
            var specs: [ButtonSpec] = content.connections.groups.flatMap(\.rows).flatMap { [$0.button, $0.retryButton] }
            let tidyRows = content.connections.tidy?.rows ?? []
            specs += tidyRows.compactMap(\.endedRow).map(\.button)
            specs += tidyRows.compactMap(\.leaseRow).compactMap(\.releaseButton)
            specs += tidyRows.compactMap(\.orphanRow).compactMap(\.button)
            specs += content.connections.tools.flatMap(\.clients).compactMap(\.button)
            specs += content.connections.tidy?.tidyAllButton.map { [$0] } ?? []
            #expect(Set(specs.map(\.title)).isSubset(of: ["탭 풀기", "정리", "모두 정리"]), "\(fixture): \(specs.map(\.title))")
            for spec in specs {
                switch spec.action {
                case .releaseConnection, .retryRelease, .releaseSession, .tidy, .tidyAll: break
                default: Issue.record("\(fixture): \(spec.title) does \(spec.action)")
                }
            }
        }
    }

    @Test func rowButtonsFollowWhatTheEngineSaysItCanDo() throws {
        let content = try content("status-problem")
        // can_release true
        #expect(try liveRow("claude-12345-1792320000", in: content).button.isEnabled)
        // can_release false (no verified control endpoint)
        #expect(try liveRow("codex-15888-1792319000", in: content).button.isEnabled == false)
        // Nothing known: nothing may be offered.
        var nulls = try Fixtures.status("status-nulls")
        nulls.connections[0].busy = true // on its first call, so it is listed
        let unknown = PopoverContent(status: nulls, now: Fixtures.now, calendar: Fixtures.utc).connections.groups.flatMap(\.rows).map(\.button)
        #expect(!unknown.isEmpty)
        #expect(unknown.allSatisfy { !$0.isEnabled })
    }

    @Test func aButtonThatIsOffSaysWhyInsteadOfSayingWhatItWouldDo() throws {
        let content = try content("status-problem")
        let codex = try liveRow("codex-15888-1792319000", in: content) // can_release false
        let claude = try liveRow("claude-12345-1792320000", in: content)
        #expect(codex.button.isEnabled == false)
        #expect(codex.button.help == "탭을 풀 길이 확인되지 않은 연결이에요. 중계기가 없거나 기록이 없을 때 그래요")
        #expect(codex.button.help != claude.button.help)
    }

    @Test func aLeftoverWithASessionOffersTabReleaseAndOneWithoutOffersAReasonInstead() throws {
        let rows = try #require(try content("status-problem").connections.tidy).rows.compactMap(\.leaseRow)
        #expect(rows[0].releaseButton == ButtonSpec(
            title: "탭 풀기", action: .releaseSession("019a1b2c-0009", user: true), help: "이 대화가 남긴 점유만 풀어요 (세션 019a1b2c)"))
        #expect(rows[1].releaseButton == nil)
        #expect(rows[1].hint == "풀 방법이 없어요 — 아래 안내를 따라 주세요")
    }

    @Test func tidyAllIsOneButtonInTheHeadOfTheTidyListAndNowhereElse() throws {
        let tidy = try #require(try content("status-problem").connections.tidy)
        #expect(tidy.title == "손볼 것 3개")
        let button = try #require(tidy.tidyAllButton)
        #expect(button.title == "모두 정리")
        #expect(button.action == .tidyAll)
        #expect(button.isEnabled)
        #expect(button.help == "끝난 연결과 남은 점유를 한 번에 정리해요")
    }

    @Test func theActivityTabOffersTheDiagnosisCopy() throws {
        let button = try content("status-problem").activity.copyButton
        #expect(button.title == "진단 복사")
        #expect(button.action == .copyDiagnosis)
        #expect(button.isEnabled)
    }

    @Test(arguments: ["status-problem", "status-cmux"])
    func everyButtonHasAHelpText(fixture: String) throws {
        #expect(!(try everyButton(fixture, onlyEnabled: false)).isEmpty)
        #expect(try everyButton(fixture, onlyEnabled: false).allSatisfy { !$0.help.isEmpty })
    }

    // MARK: Pressing them reaches the engine

    /// Every button of the popover for a fixture, with the card's fix button.
    private func everyButton(_ fixture: String, onlyEnabled: Bool = true) throws -> [ButtonSpec] {
        let status = try Fixtures.status(fixture)
        let content = PopoverContent(status: status, now: Fixtures.now, calendar: Fixtures.utc)
        let connections = content.connections
        var specs = connections.groups.flatMap(\.rows).map(\.button)
        let tidyRows = connections.tidy?.rows ?? []
        specs += tidyRows.compactMap(\.endedRow).map(\.button)
        specs += tidyRows.compactMap(\.leaseRow).compactMap(\.releaseButton)
        specs += tidyRows.compactMap(\.orphanRow).compactMap(\.button)
        specs += connections.tidy?.tidyAllButton.map { [$0] } ?? []
        specs.append(content.activity.copyButton)
        let summary = StatusEvaluator.evaluate(status, appVersion: "0.7.0")
        if let fix = summary.fix, let label = summary.fixLabel {
            specs.append(ButtonSpec(title: label, action: fix, help: "the card's fix"))
        }
        return onlyEnabled ? specs.filter(\.isEnabled) : specs
    }

    @Test(arguments: ["status-problem", "status-cmux"])
    func noButtonIsDead(fixture: String) async throws {
        let specs = try everyButton(fixture)
        #expect(specs.count >= 4)
        for spec in specs {
            let engine = FakeEngineClient(status: try Fixtures.status(fixture))
            let model = CUABarViewModel(
                engine: engine, appVersion: "0.7.0", pasteboard: RecordingPasteboard(),
                clock: { Fixtures.now }, calendar: Fixtures.utc, sleep: ManualSleeper().sleep)
            await model.refresh()
            // This fixture has an ended connection the app releases by itself (F5); let that finish first.
            await model.waitForBackgroundWork()
            let before = engine.calls.count
            await model.perform(spec.action)
            let calls = Array(engine.calls.dropFirst(before))
            // 모두 정리 is several calls, each button else exactly one; all of them read the status afterwards.
            #expect(calls.count == (spec.action == .tidyAll ? calls.count : 2) && calls.count >= 2, "\(spec.title) made \(calls)")
            #expect(calls.first != .status, "\(spec.title) only re-read the status")
            #expect(calls.last == .status, "\(spec.title) did not read the status afterwards")
        }
    }

    @Test func theButtonsPressedGoToTheRightEngineCalls() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-problem"))
        let model = CUABarViewModel(
            engine: engine, appVersion: "0.7.0", pasteboard: RecordingPasteboard(),
            clock: { Fixtures.now }, calendar: Fixtures.utc, sleep: ManualSleeper().sleep)
        await model.refresh()
        await model.waitForBackgroundWork()
        let baseline = engine.calls.count
        let connections = try #require(model.content?.connections)
        let tidy = try #require(connections.tidy)
        let ended = try #require(tidy.rows.compactMap(\.endedRow).first)
        #expect(ended.id == "claude-4001-1792300000")
        await model.perform(ended.button.action)
        await model.perform(try #require(connections.groups.first?.rows.first).button.action)
        await model.perform(try #require(tidy.rows.compactMap(\.leaseRow).first?.releaseButton).action)
        await model.perform(try #require(tidy.tidyAllButton).action)
        await model.perform(model.activityContent.copyButton.action)
        await model.perform(try #require(model.summary.fix))
        let actionCalls = engine.calls.dropFirst(baseline).filter { $0 != .status }
        #expect(actionCalls == [
            .stopConnection("claude-4001-1792300000", force: false),
            .releaseConnection("claude-12345-1792320000"),
            .releaseSession("019a1b2c-0009", user: true),
            // 모두 정리: the ended connection, then the Claude session without `--user`.
            .stopConnection("claude-4001-1792300000", force: false),
            .releaseSession("019a1b2c-0009", user: false),
            .diagnose,
            .restartCodex,
        ])
    }

    @Test func theCardsFixButtonIsTheProblemsFixAndNothingElse() throws {
        for fixture in ["status-ready", "status-working", "status-problem"] {
            let summary = StatusEvaluator.evaluate(try Fixtures.status(fixture), appVersion: "0.7.0")
            #expect((summary.fix != nil) == (summary.icon == .problem), "\(fixture): a fix button only when there is a problem")
            #expect((summary.fixLabel != nil) == (summary.fix != nil))
        }
    }
}
