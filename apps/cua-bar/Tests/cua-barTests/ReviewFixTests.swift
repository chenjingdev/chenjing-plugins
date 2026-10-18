import AppKit
import SwiftUI
import Foundation
import Testing
@testable import cua_bar

/// What the review of the first task found: each fix has its own test here.
@MainActor
struct ReviewFixTests {
    // MARK: Disabled buttons look disabled

    private func darkness(of spec: ButtonSpec, waiting: Bool = false) throws -> Double {
        let view = SpecButton(spec: spec, waiting: waiting) { _ in }
            .padding(10)
            .background(Color.white)
        return Snapshot.meanDarkness(try #require(Snapshot.bitmap(of: view)))
    }

    @Test func aButtonThatCannotBePressedIsDrawnFarLighterThanOneThatCan() throws {
        let on = ButtonSpec(title: "놓아주기", action: .releaseEnded, isEnabled: true, help: "")
        let off = ButtonSpec(title: "놓아주기", action: .releaseEnded, isEnabled: false, help: "")
        let enabled = try darkness(of: on)
        #expect(enabled > 0.02, "the button is drawn at all")
        #expect(try darkness(of: off) < enabled * 0.75)
        // A button that is waiting for something to finish is dimmed the same way.
        #expect(try darkness(of: on, waiting: true) < enabled * 0.75)
    }

    @Test func aDestructiveButtonIsRedOnlyWhileItCanBePressed() throws {
        let on = ButtonSpec(title: "강제 종료", action: .stopConnection("x", force: true), isDestructive: true, isEnabled: true, help: "")
        let off = ButtonSpec(title: "강제 종료", action: .stopConnection("x", force: true), isDestructive: true, isEnabled: false, help: "")
        #expect(try darkness(of: off) < (try darkness(of: on)) * 0.75)
    }

    // MARK: The group rows belong to connections

    @Test func noConnectionsNoGroupRows() async throws {
        let rig = await Rig(EngineStatus())
        let connections = try #require(rig.model.content?.connections)
        #expect(connections.emptyText == "연결 없음")
        #expect(connections.showsGroupButtons == false)
    }

    // MARK: 진단 복사 is there when the status cannot be read

    @Test func theDiagnosisButtonStaysInTheActivityTabWhenTheStatusCannotBeRead() async throws {
        let engine = FakeEngineClient()
        engine.setStatusError(.timeout)
        let rig = await Rig(EngineStatus(), engine: engine)
        #expect(rig.model.content == nil)
        #expect(rig.model.summary.problem?.kind == .engineUnreadable)
        let activity = rig.model.activityContent
        #expect(activity.copyButton.title == "진단 복사")
        #expect(activity.copyButton.action == .copyDiagnosis)
        #expect(activity.copyButton.isEnabled)
        #expect(activity.emptyText == "상태를 읽지 못해서 기록을 보일 수 없어요")
        // And it works: the engine's own `diagnose` is what lands on the pasteboard.
        engine.configure { $0.diagnosis = "CUA diagnosis\nhost: unknown\n" }
        await rig.model.send(activity.copyButton.action)?.value
        #expect(rig.pasteboard.copied == ["CUA diagnosis\nhost: unknown\n"])
    }

    @Test func theActivityTabKeepsTheButtonWhileTheFirstReadIsStillPending() async throws {
        let rig = await Rig(EngineStatus(), refresh: false)
        #expect(rig.model.activityContent.emptyText == "불러오는 중…")
        #expect(rig.model.activityContent.copyButton.action == .copyDiagnosis)
    }

    @Test func withAStatusTheActivityTabIsTheRealOne() async throws {
        let rig = await Rig(try Fixtures.status("status-ready"))
        #expect(rig.model.activityContent.rows.count == 3)
    }

    @Test func theUnreadablePopoverStillDrawsTheActivityTab() async throws {
        let engine = FakeEngineClient()
        engine.setStatusError(.timeout)
        let rig = await Rig(EngineStatus(), engine: engine)
        // Over white: on a transparent background dark text has the same colour as the corner pixel
        // the measure compares with, and only the (identical) status card would count.
        rig.model.selectedTab = .activity
        let withTab = try #require(Snapshot.bitmap(of: PopoverView(model: rig.model, quit: {}).background(Color.white)))
        rig.model.selectedTab = .connections
        let withoutTab = try #require(Snapshot.bitmap(of: PopoverView(model: rig.model, quit: {}).background(Color.white)))
        if let directory = ProcessInfo.processInfo.environment["CUABAR_SNAPSHOT_EXTRA_DIR"] {
            try Snapshot.write(withTab, named: "unreadable-activity-tab", to: directory)
            try Snapshot.write(withoutTab, named: "unreadable-connections-tab", to: directory)
        }
        // The 진단 복사 row and its line are drawn on one and not on the other.
        #expect(Snapshot.inkRatio(withTab) != Snapshot.inkRatio(withoutTab))
        #expect(withTab.pixelsHigh == withoutTab.pixelsHigh, "the popover does not change height between tabs")
    }

    // MARK: 안내 보기

    @Test func theCardsGuidanceButtonSelectsTheLeaseTabAndOpensTheGuidance() async throws {
        var status = try Fixtures.status("status-ready")
        status.leases.maybeLeft = [LeftoverLease(sessionID: nil, agent: .codex, connectionID: nil, cwd: nil, endedAt: nil, releasable: false)]
        let rig = await Rig(status)
        let fix = try #require(rig.model.summary.fix)
        #expect(fix == .showLeaseGuidance)
        #expect(rig.model.summary.fixLabel == "안내 보기")
        rig.model.selectedTab = .activity
        rig.model.guidanceOpenByUser = false
        await rig.model.send(fix)?.value
        #expect(rig.model.selectedTab == .leases)
        #expect(rig.model.guidanceOpenByUser == true)
        #expect(rig.model.banner == nil)
        #expect(rig.model.pending == nil)
        #expect(rig.actionCalls.isEmpty, "it only moves the view")
    }

    // MARK: A command that cannot run: one fixed line

    @Test(arguments: [
        EngineError.commandFailed(exitCode: 70, message: "Traceback ... /Users/someone/secret/plugin.py"),
        .launchFailed("/Users/someone/secret/codex-cua: permission denied"),
        .invalidOutput("EngineStatus"),
        .timeout,
    ])
    func aBannerNeverShowsWhatTheCommandPrinted(error: EngineError) async throws {
        let rig = await Rig(try Fixtures.status("status-ready"))
        rig.engine.configure { $0.actionError = error }
        await rig.model.perform(.releaseEnded)
        let message = try #require(rig.model.banner?.outcome.message)
        #expect(message == "놓지 못했어요 — \(error.message)")
        #expect(!message.contains("secret"))
        #expect(!message.contains("Traceback"))
        #expect(!message.contains("70"))
    }

    @Test func theCardNeverShowsItEither() async throws {
        let engine = FakeEngineClient()
        engine.setStatusError(.commandFailed(exitCode: 70, message: "Traceback /Users/someone/secret"))
        let rig = await Rig(EngineStatus(), engine: engine)
        await rig.model.refresh() // a second failure in a row: now it shows
        #expect(rig.model.summary.problem?.kind == .engineUnreadable)
        #expect(rig.model.summary.warning == "명령이 오류로 끝났어요")
        #expect(rig.model.summary.tooltip == "CUA 문제 · 상태를 읽지 못했어요")
    }

    // MARK: A failed targeted release opens the guidance only when the extension reset can help

    @Test(arguments: ["unsupported", "cleanup_not_confirmed", "timeout"])
    func theseFailuresOpenTheGuidanceForThatRow(reason: String) async throws {
        let rig = await Rig(try Fixtures.status("status-problem"))
        rig.engine.configure { $0.releaseSession = SessionReleaseResult(ok: true, released: false, reason: reason) }
        rig.model.guidanceOpenByUser = false
        await rig.model.perform(.releaseSession("019a1b2c-0009", user: true))
        #expect(rig.model.failedSessionIDs == ["019a1b2c-0009"])
        #expect(rig.model.guidanceOpenByUser == nil, "the person's closing it is undone: it opens")
        #expect(rig.model.sessionResults["019a1b2c-0009"]?.kind == .failure)
        // Its row shows the guidance first the live connections a reset would cut.
        let guidance = try #require(rig.model.content?.leases.guidance)
        #expect(guidance.steps.first?.hasPrefix("막힌 탭이 있으면 그 탭을 닫아요") == true)
        #expect(guidance.steps.last?.contains("chrome://extensions") == true)
        #expect(guidance.liveConnections == ["Claude · dev/computer-use", "Codex · dev/new-chat"])
    }

    @Test(arguments: ["session_live", "needs_user", "not_found", "not_running", "relay_unavailable", "request_in_flight"])
    func otherFailuresGiveTheirReasonOnTheRowButDoNotPointAtTheExtension(reason: String) async throws {
        let rig = await Rig(try Fixtures.status("status-problem"))
        rig.engine.configure { $0.releaseSession = SessionReleaseResult(ok: false, released: false, reason: reason) }
        await rig.model.perform(.releaseSession("019a1b2c-0009", user: true))
        #expect(rig.model.failedSessionIDs.isEmpty)
        #expect(rig.model.sessionResults["019a1b2c-0009"] == ActionOutcome(kind: .failure, message: "풀지 못했어요 — \(ActionMessages.reason(reason))"))
    }

    @Test func aCommandThatTimedOutCountsAsTheTimeoutReason() async throws {
        let rig = await Rig(try Fixtures.status("status-problem"))
        rig.engine.configure { $0.actionError = .timeout }
        await rig.model.perform(.releaseSession("019a1b2c-0009", user: true))
        #expect(rig.model.failedSessionIDs == ["019a1b2c-0009"])
        #expect(rig.model.sessionResults["019a1b2c-0009"]?.message == "풀지 못했어요 — 응답이 없어 기다리다 멈췄어요")
    }

    @Test func aReleaseThatWorkedClearsTheRowsResultAndTheGuidanceReason() async throws {
        let rig = await Rig(try Fixtures.status("status-problem"))
        rig.engine.configure { $0.releaseSession = SessionReleaseResult(ok: true, released: false, reason: "unsupported") }
        await rig.model.perform(.releaseSession("019a1b2c-0009", user: true))
        rig.engine.configure { $0.releaseSession = SessionReleaseResult(ok: true, released: true, reason: nil, tabCount: 2) }
        await rig.model.perform(.releaseSession("019a1b2c-0009", user: true))
        #expect(rig.model.failedSessionIDs.isEmpty)
        #expect(rig.model.sessionResults["019a1b2c-0009"] == ActionOutcome(kind: .success, message: "탭 2개를 놓았어요"))
        #expect(rig.model.banner?.outcome.message == "탭 2개를 놓았어요")
    }

    @Test func aClickOnPinpointReleasePassesUserAndNeedsNoQuestion() async throws {
        let rig = await Rig(try Fixtures.status("status-problem"))
        let button = try #require(rig.model.content?.leases.rows.first?.releaseButton)
        #expect(button.action == .releaseSession("019a1b2c-0009", user: true))
        let started = rig.model.send(button.action)
        #expect(started != nil, "it runs at once")
        await started?.value
        #expect(rig.model.pending == nil)
        #expect(rig.actionCalls == [.releaseSession("019a1b2c-0009", user: true)])
    }

    @Test func aSessionsResultGoesWithTheSessionWhenItLeavesTheList() async throws {
        let rig = await Rig(try Fixtures.status("status-problem"))
        rig.engine.configure { $0.releaseSession = SessionReleaseResult(ok: true, released: false, reason: "unsupported") }
        await rig.model.perform(.releaseSession("019a1b2c-0009", user: true))
        #expect(rig.model.sessionResults.count == 1)
        var later = try Fixtures.status("status-problem")
        later.leases.maybeLeft.removeAll { $0.sessionID == "019a1b2c-0009" }
        rig.engine.setStatus(later)
        await rig.model.refresh()
        #expect(rig.model.sessionResults.isEmpty)
        #expect(rig.model.failedSessionIDs.isEmpty)
    }
}
