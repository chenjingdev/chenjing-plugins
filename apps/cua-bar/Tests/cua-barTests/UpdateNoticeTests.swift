import Foundation
import Testing
@testable import cua_bar

/// The one notice after an update (F4): the mark the update leaves, and the install routine that tells it instead of its own line.
struct UpdateNoticeTests {
    private let seven = VersionNumber(0, 7, 0)

    // MARK: The mark

    @Test func theMarkIsOneSmallFileInTheAppsSupportFolderAndComesBackAsTheVersion() throws {
        let home = try TempHome()
        defer { home.remove() }
        let notice = UpdateNotice(home: home.url)
        #expect(notice.file.path == home.url.path + "/Library/Application Support/CUABar/update-pending.json")
        #expect(notice.pendingVersion == nil)
        try notice.leave(version: VersionNumber(0, 8, 1))
        #expect(notice.pendingVersion == VersionNumber(0, 8, 1))
        try notice.leave(version: VersionNumber(0, 9, 0))
        #expect(notice.pendingVersion == VersionNumber(0, 9, 0), "a later update replaces it")
        notice.clear()
        #expect(notice.pendingVersion == nil)
        notice.clear() // nothing there: no trouble
    }

    @Test func aMarkThatIsNotAVersionIsNothing() throws {
        let home = try TempHome()
        defer { home.remove() }
        let notice = UpdateNotice(home: home.url)
        for text in ["", "not json", "[]", #"{"version": 8}"#, #"{"version": "0.8"}"#, #"{"other": "0.8.0"}"#] {
            try home.write(text, to: notice.file)
            #expect(notice.pendingVersion == nil, "\(text)")
        }
    }

    @Test func theLineSaysTheVersionAndWhereTheNewOneIsUsed() {
        #expect(UpdateNotice.line(for: VersionNumber(0, 8, 1)) == "CUA Bar를 0.8.1로 올렸어요. 새 Claude 대화부터 새 판이 쓰여요")
        #expect(UpdateNotice.headline(for: VersionNumber(0, 8, 1)) == "CUA Bar를 0.8.1로 올렸어요")
        #expect(UpdateNotice.consequence == "새 Claude 대화부터 새 판이 쓰여요")
    }

    @Test func theLineIsToldOnlyToTheAppOfTheVersionTheUpdateWasTo() throws {
        let home = try TempHome()
        defer { home.remove() }
        let notice = UpdateNotice(home: home.url)
        #expect(notice.lineIfJustUpdated(to: seven) == nil, "no mark, no line")
        try notice.leave(version: VersionNumber(0, 8, 0))
        #expect(notice.lineIfJustUpdated(to: VersionNumber(0, 8, 0)) == "CUA Bar를 0.8.0로 올렸어요. 새 Claude 대화부터 새 판이 쓰여요")
        #expect(notice.lineIfJustUpdated(to: nil) == nil, "an app without a version has nothing to compare")
        // The update that is under way is the mark of an app this one is about to give way to: it is not touched.
        #expect(notice.lineIfJustUpdated(to: seven) == nil)
        #expect(notice.pendingVersion == VersionNumber(0, 8, 0))
        // A mark older than the running app is long past, and goes.
        #expect(notice.lineIfJustUpdated(to: VersionNumber(0, 9, 0)) == nil)
        #expect(notice.pendingVersion == nil)
    }

    // MARK: The install routine tells it

    @MainActor
    private func install(_ rig: LiveSystemActionsTests.Rig) async -> ActionOutcome {
        await rig.actions.setUp()
    }

    private let installed = ActionOutcome(kind: .success, message: "새 Claude 대화부터 CUA가 붙어요")
    /// Nothing for the banner: what there was to say went out as a notification.
    private let nothingForTheBanner = InstallMessages.nothingToSay
    private let updatedLine = "CUA Bar를 0.7.0로 올렸어요. 새 Claude 대화부터 새 판이 쓰여요"

    @MainActor @Test func theInstallAfterAnUpdateAnnouncesTheUpdateInsteadOfItsOwnLineAndOnlyOnce() async throws {
        let rig = try LiveSystemActionsTests().rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        try rig.notice.leave(version: seven)
        #expect(await install(rig) == nothingForTheBanner, "the same words are not said twice, nor 'CUA가 붙어요' after them")
        // One notification, with the update's words, that opens the popover when it is clicked.
        let posted = rig.announcements.posted
        #expect(posted == [AppNotification.updated(seven)])
        let note = try #require(posted.first)
        #expect(note.kind == .updated)
        #expect(note.key == "updated-0.7.0")
        #expect(note.title + ". " + note.body == updatedLine)
        #expect(note.buttons.isEmpty)
        #expect(rig.notice.pendingVersion == nil, "told once: the mark is taken away")

        // The engine is the app's now. The same routine again finds nothing to change and says nothing at all.
        rig.engine.setStatus(try LiveSystemActionsTests().currentEngine(rig.home).get())
        #expect(await install(rig).message.isEmpty)
        #expect(rig.announcements.posted.count == 1, "the next run posts nothing")
        // And a later change is the routine's own line again, in the banner.
        try FileManager.default.removeItem(at: rig.home.skillFolder)
        #expect(await install(rig) == installed)
        #expect(rig.announcements.posted.count == 1)
    }

    @MainActor @Test func withoutAMarkTheInstallSaysItsOwnLineAndPostsNothing() async throws {
        let rig = try LiveSystemActionsTests().rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        #expect(await install(rig) == installed)
        #expect(rig.announcements.posted.isEmpty)
    }

    @MainActor @Test func whereNotificationsAreOffTheLineIsTheBannersAndTheMarkIsStillTakenAway() async throws {
        let rig = try LiveSystemActionsTests().rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        rig.announcements.setDelivering(false)
        try rig.notice.leave(version: seven)
        #expect(await install(rig) == ActionOutcome(kind: .success, message: updatedLine), "the one place left to say it")
        #expect(rig.announcements.posted.count == 1, "it was tried")
        #expect(rig.notice.pendingVersion == nil)
    }

    @MainActor @Test func aFailedTestAfterTheUpdateIsSaidInTheOneNotificationAndNotAgainInTheBanner() async throws {
        let rig = try LiveSystemActionsTests().rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        try rig.notice.leave(version: seven)
        rig.actions.setAfterChange { .failed }
        #expect(await install(rig) == nothingForTheBanner)
        let posted = rig.announcements.posted
        #expect(posted == [AppNotification.updated(seven).appending(probe: .failed)])
        #expect(posted.first?.body == "새 Claude 대화부터 새 판이 쓰여요. 연결 시험이 실패했어요 — 점검 탭을 보세요")
        #expect(posted.first?.key == "updated-0.7.0")
    }

    @MainActor @Test func aTestThatPassedAfterTheUpdateLeavesTheNotificationAsItIs() async throws {
        let rig = try LiveSystemActionsTests().rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        try rig.notice.leave(version: seven)
        rig.actions.setAfterChange { .checked }
        #expect(await install(rig) == nothingForTheBanner)
        #expect(rig.announcements.posted == [AppNotification.updated(seven)])
    }

    @MainActor @Test func whereNotificationsAreOffAFailedTestAfterTheUpdateGoesAfterTheBannersLine() async throws {
        let rig = try LiveSystemActionsTests().rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        rig.announcements.setDelivering(false)
        try rig.notice.leave(version: seven)
        rig.actions.setAfterChange { .timeout }
        let said = await install(rig)
        #expect(said == ActionOutcome(kind: .warning, message: updatedLine + ". 연결 시험이 실패했어요 — 점검 탭을 보세요"))
        #expect(rig.notice.pendingVersion == nil)
    }

    @MainActor @Test func aMarkOfAnotherVersionChangesNothingInTheInstallLine() async throws {
        let rig = try LiveSystemActionsTests().rig(appVersion: "0.7.0")
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        try rig.notice.leave(version: VersionNumber(0, 8, 0)) // an update that is under way
        #expect(await install(rig) == installed)
        #expect(rig.announcements.posted.isEmpty)
        #expect(rig.notice.pendingVersion == VersionNumber(0, 8, 0), "left for the app that is to start")
    }

    @MainActor @Test func aMarkOlderThanTheAppIsDroppedAndTheInstallSaysItsOwnLine() async throws {
        let rig = try LiveSystemActionsTests().rig(appVersion: "0.9.0")
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        try rig.notice.leave(version: VersionNumber(0, 8, 0))
        #expect(await install(rig) == installed)
        #expect(rig.announcements.posted.isEmpty)
        #expect(rig.notice.pendingVersion == nil)
    }

    @MainActor @Test func anInstallThatCouldNotFinishLeavesTheMarkForTheOneThatDoes() async throws {
        // No Codex yet: the install is put off and says nothing; the mark waits.
        let rig = try LiveSystemActionsTests().rig(codexInstalled: false)
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        try rig.notice.leave(version: seven)
        #expect(await install(rig).message.isEmpty)
        #expect(rig.announcements.posted.isEmpty)
        #expect(rig.notice.pendingVersion == seven)
        rig.codex.isThere = true
        #expect(await install(rig) == nothingForTheBanner, "the run that does the install tells it")
        #expect(rig.announcements.posted == [AppNotification.updated(seven)])
        #expect(rig.notice.pendingVersion == nil)
    }

    @MainActor @Test func anInstallThatFailsLeavesTheMarkAndSaysItsFailure() async throws {
        let rig = try LiveSystemActionsTests().rig(responses: { call in call.isInstallEngine ? StepRunner.failed() : nil })
        defer { rig.home.remove() }
        try rig.notice.leave(version: seven)
        let outcome = await install(rig)
        #expect(outcome == ActionOutcome(kind: .failure, message: InstallMessages.engineFailed))
        #expect(rig.announcements.posted.isEmpty)
        #expect(rig.notice.pendingVersion == seven)
    }

    @MainActor @Test func aConflictIsToldAsAConflictAndTheMarkStays() async throws {
        let rig = try LiveSystemActionsTests().rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        rig.engine.setStatus(try LiveSystemActionsTests().currentEngine(rig.home).get())
        try rig.home.addSkill(version: "0.7.0", body: rig.skillSourceBody)
        try rig.home.addMcp(command: "/Users/someone/.claude/plugins/cache/chenjing-plugins/cua/0.7.0/start-mcp.sh")
        try rig.notice.leave(version: seven)
        #expect(await install(rig) == ActionOutcome(kind: .warning, message: InstallMessages.conflict))
        #expect(rig.announcements.posted.isEmpty)
        #expect(rig.notice.pendingVersion == seven)
    }

    @MainActor @Test func withoutClaudeCodeTheEngineOnlyLineStaysAndTheMarkGoesWithItWithNoNotification() async throws {
        // There is no Claude conversation to tell about, so the update line has nothing to say here; and it would be
        // out of place on the day Claude Code arrives, so the mark goes.
        let rig = try LiveSystemActionsTests().rig(claudeInstalled: false)
        defer { rig.home.remove() }
        try rig.notice.leave(version: seven)
        #expect(await install(rig) == ActionOutcome(kind: .success, message: LiveSystemActions.engineOnly))
        #expect(rig.announcements.posted.isEmpty)
        #expect(rig.notice.pendingVersion == nil)
    }

    @MainActor @Test func aBuildThatLooksForNoMarkSaysItsOwnLine() async throws {
        // Previews and the tests that do not care: `updateNotice` is nil.
        let rig = try LiveSystemActionsTests().rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        try rig.notice.leave(version: seven)
        let without = LiveSystemActions(
            claude: rig.claude, engine: rig.engine, runner: rig.runner, opener: rig.opener, bundle: rig.bundle, appVersion: "0.7.0",
            setup: SetupActivity(), codex: CodexLocator(home: rig.home.url, environment: [:], isCodexBundle: { _ in true }))
        #expect(await without.setUp() == installed)
        #expect(rig.notice.pendingVersion == seven)
    }

    @MainActor @Test func aBuildWithNoWayToPostSaysTheUpdateLineInTheBanner() async throws {
        let rig = try LiveSystemActionsTests().rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        try rig.notice.leave(version: seven)
        let quiet = LiveSystemActions(
            claude: rig.claude, engine: rig.engine, runner: rig.runner, opener: rig.opener, bundle: rig.bundle, appVersion: "0.7.0",
            setup: SetupActivity(), codex: CodexLocator(home: rig.home.url, environment: [:], isCodexBundle: { _ in true }),
            updateNotice: rig.notice)
        #expect(await quiet.setUp() == ActionOutcome(kind: .success, message: updatedLine))
        #expect(rig.notice.pendingVersion == nil)
    }
}
