import Foundation
import Testing
@testable import cua_bar

/// Every button the popover draws is a `ButtonSpec`; these tests check what each one is aimed
/// at and that pressing it really reaches the engine, without needing a window.
@MainActor
struct ButtonWiringTests {
    private func content(_ fixture: String) throws -> PopoverContent {
        PopoverContent(status: try Fixtures.status(fixture), now: Fixtures.now, calendar: Fixtures.utc)
    }

    private func row(_ id: String, in content: PopoverContent) throws -> ConnectionRow {
        try #require(content.connections.groups.flatMap(\.rows).first { $0.id == id })
    }

    // MARK: What each button is

    @Test func everyConnectionRowOffersReleaseStopAndForceStopAimedAtItsOwnConnection() throws {
        let content = try content("status-problem")
        let ended = try row("claude-4001-1792300000", in: content)
        #expect(ended.buttons.map(\.title) == ["놓아주기", "끄기", "강제 종료"])
        #expect(ended.buttons.map(\.action) == [
            .releaseConnection("claude-4001-1792300000"),
            .stopConnection("claude-4001-1792300000", force: false),
            .stopConnection("claude-4001-1792300000", force: true),
        ])
        #expect(ended.buttons.map(\.isDestructive) == [false, false, true])

        let codex = try row("codex-15888-1792319000", in: content)
        #expect(codex.buttons.map(\.action) == [
            .releaseConnection("codex-15888-1792319000"),
            .stopConnection("codex-15888-1792319000", force: false),
            .stopConnection("codex-15888-1792319000", force: true),
        ])
    }

    @Test func rowButtonsFollowWhatTheEngineSaysItCanDo() throws {
        let content = try content("status-problem")
        // can_release true, can_stop true
        let claude = try row("claude-12345-1792320000", in: content)
        #expect(claude.buttons.map(\.isEnabled) == [true, true, true])
        // can_release false (no verified control endpoint), can_stop true
        let codex = try row("codex-15888-1792319000", in: content)
        #expect(codex.buttons.map(\.isEnabled) == [false, true, true])
        // Nothing known: nothing may be offered.
        let unknown = try self.content("status-nulls")
        let unknownButtons = unknown.connections.groups.flatMap(\.rows).flatMap(\.buttons)
        #expect(!unknownButtons.isEmpty)
        #expect(unknownButtons.allSatisfy { !$0.isEnabled })
    }

    @Test func aButtonThatIsOffSaysWhyInsteadOfSayingWhatItWouldDo() throws {
        let content = try content("status-problem")
        let codex = try row("codex-15888-1792319000", in: content) // can_release false, can_stop true
        let claude = try row("claude-12345-1792320000", in: content)
        #expect(codex.buttons[0].isEnabled == false)
        #expect(codex.buttons[0].help == "놓아줄 길이 확인되지 않은 연결이에요. 중계기가 없거나 기록이 없을 때 그래요")
        #expect(codex.buttons[0].help != claude.buttons[0].help)
        #expect(codex.buttons[1].help == claude.buttons[1].help, "an enabled button keeps its own help")
        let unknown = try self.content("status-nulls").connections.groups.flatMap(\.rows)
        let stopOff = try #require(unknown.first).buttons[1]
        #expect(stopOff.isEnabled == false)
        #expect(stopOff.help == "신원을 확인하지 못한 프로세스라 앱이 끌 수 없어요")
    }

    @Test func groupButtonsCarryTheirCountsAndTheirGroups() throws {
        let connections = try content("status-problem").connections
        #expect(connections.stopButtons.map(\.title) == ["전체 끄기 3", "Claude만 2", "Codex만 1"])
        #expect(connections.stopButtons.map(\.action) == [
            .stopGroup(.all, force: false), .stopGroup(.claude, force: false), .stopGroup(.codex, force: false),
        ])
        #expect(connections.stopButtons.allSatisfy { $0.isEnabled })
        #expect(connections.releaseEndedButton.title == "끝난 연결 놓아주기 1")
        #expect(connections.releaseEndedButton.action == .releaseEnded)
        #expect(connections.releaseEndedButton.isEnabled)
    }

    @Test func groupButtonsAreOffWhenThereIsNothingToTouch() throws {
        let connections = PopoverContent(status: EngineStatus(), now: Fixtures.now, calendar: Fixtures.utc).connections
        #expect(connections.stopButtons.map(\.title) == ["전체 끄기 0", "Claude만 0", "Codex만 0"])
        #expect(connections.stopButtons.allSatisfy { !$0.isEnabled })
        #expect(connections.releaseEndedButton.title == "끝난 연결 놓아주기 0")
        #expect(connections.releaseEndedButton.isEnabled == false)
    }

    @Test func aLeftoverWithASessionOffersAPinpointReleaseAndOneWithoutDoesNot() throws {
        let rows = try content("status-problem").leases.rows
        #expect(rows[0].releaseButton == ButtonSpec(
            title: "콕 집어 풀기", action: .releaseSession("019a1b2c-0009", user: true), help: "이 세션이 남긴 점유만 세션 ID로 풀어요"))
        #expect(rows[1].releaseButton == nil)
    }

    @Test func theActivityTabOffersTheDiagnosisCopy() throws {
        let button = try content("status-problem").activity.copyButton
        #expect(button.title == "진단 복사")
        #expect(button.action == .copyDiagnosis)
        #expect(button.isEnabled)
    }

    @Test func everyButtonHasAHelpText() throws {
        let content = try content("status-problem")
        var specs = content.connections.groups.flatMap(\.rows).flatMap(\.buttons)
        specs += content.connections.stopButtons + [content.connections.releaseEndedButton, content.activity.copyButton]
        specs += content.leases.rows.compactMap(\.releaseButton)
        #expect(!specs.isEmpty)
        #expect(specs.allSatisfy { !$0.help.isEmpty })
    }

    // MARK: Pressing them reaches the engine

    /// Every button of the popover for the problem fixture, with the card's fix button.
    private func everyButton() throws -> [ButtonSpec] {
        let status = try Fixtures.status("status-problem")
        let content = PopoverContent(status: status, now: Fixtures.now, calendar: Fixtures.utc)
        var specs = content.connections.groups.flatMap(\.rows).flatMap(\.buttons)
        specs += content.connections.stopButtons + [content.connections.releaseEndedButton]
        specs += content.leases.rows.compactMap(\.releaseButton)
        specs.append(content.activity.copyButton)
        let summary = StatusEvaluator.evaluate(status, appVersion: "0.7.0")
        if let fix = summary.fix, let label = summary.fixLabel {
            specs.append(ButtonSpec(title: label, action: fix, help: ""))
        }
        return specs.filter(\.isEnabled)
    }

    @Test func noButtonIsDead() async throws {
        let specs = try everyButton()
        #expect(specs.count >= 12)
        for spec in specs {
            let engine = FakeEngineClient(status: try Fixtures.status("status-problem"))
            let model = CUABarViewModel(
                engine: engine, appVersion: "0.7.0", pasteboard: RecordingPasteboard(),
                clock: { Fixtures.now }, calendar: Fixtures.utc, sleep: ManualSleeper().sleep)
            await model.refresh()
            let before = engine.calls.count
            await model.perform(spec.action)
            let calls = Array(engine.calls.dropFirst(before))
            #expect(calls.count == 2, "\(spec.title) made \(calls)")
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
        let content = try #require(model.content)
        let claudeEnded = try #require(content.connections.groups.first?.rows.first)
        #expect(claudeEnded.id == "claude-4001-1792300000")
        for button in claudeEnded.buttons { await model.perform(button.action) }
        for button in content.connections.stopButtons { await model.perform(button.action) }
        await model.perform(content.connections.releaseEndedButton.action)
        await model.perform(try #require(content.leases.rows[0].releaseButton).action)
        await model.perform(content.activity.copyButton.action)
        await model.perform(try #require(model.summary.fix))
        let actionCalls = engine.calls.filter { $0 != .status }
        #expect(actionCalls == [
            .releaseConnection("claude-4001-1792300000"),
            .stopConnection("claude-4001-1792300000", force: false),
            .stopConnection("claude-4001-1792300000", force: true),
            .stopGroup(.all, force: false),
            .stopGroup(.claude, force: false),
            .stopGroup(.codex, force: false),
            .releaseEnded,
            .releaseSession("019a1b2c-0009", user: true),
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
