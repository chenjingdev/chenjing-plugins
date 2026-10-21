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
    private let updated = ActionOutcome(kind: .success, message: "CUA Bar를 0.7.0로 올렸어요. 새 Claude 대화부터 새 판이 쓰여요")

    @MainActor @Test func theInstallAfterAnUpdateSaysTheUpdateLineInsteadOfItsOwnAndOnlyOnce() async throws {
        let rig = try LiveSystemActionsTests().rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        try rig.notice.leave(version: seven)
        #expect(await install(rig) == updated, "one notice, not 'CUA가 붙어요' and then another")
        #expect(rig.notice.pendingVersion == nil, "told once: the mark is taken away")
        // The engine is the app's now. The same routine again finds nothing to change and says nothing.
        rig.engine.setStatus(try LiveSystemActionsTests().currentEngine(rig.home).get())
        #expect(await install(rig).message.isEmpty)
        // And a later change is the routine's own line again.
        try FileManager.default.removeItem(at: rig.home.skillFolder)
        #expect(await install(rig) == installed)
    }

    @MainActor @Test func withoutAMarkTheInstallSaysItsOwnLine() async throws {
        let rig = try LiveSystemActionsTests().rig()
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        #expect(await install(rig) == installed)
    }

    @MainActor @Test func aMarkOfAnotherVersionChangesNothingInTheInstallLine() async throws {
        let rig = try LiveSystemActionsTests().rig(appVersion: "0.7.0")
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        try rig.notice.leave(version: VersionNumber(0, 8, 0)) // an update that is under way
        #expect(await install(rig) == installed)
        #expect(rig.notice.pendingVersion == VersionNumber(0, 8, 0), "left for the app that is to start")
    }

    @MainActor @Test func aMarkOlderThanTheAppIsDroppedAndTheInstallSaysItsOwnLine() async throws {
        let rig = try LiveSystemActionsTests().rig(appVersion: "0.9.0")
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        try rig.notice.leave(version: VersionNumber(0, 8, 0))
        #expect(await install(rig) == installed)
        #expect(rig.notice.pendingVersion == nil)
    }

    @MainActor @Test func anInstallThatCouldNotFinishLeavesTheMarkForTheOneThatDoes() async throws {
        // No Codex yet: the install is put off and says nothing; the mark waits.
        let rig = try LiveSystemActionsTests().rig(codexInstalled: false)
        defer { rig.home.remove() }
        try rig.home.installClaudeCode()
        try rig.notice.leave(version: seven)
        #expect(await install(rig).message.isEmpty)
        #expect(rig.notice.pendingVersion == seven)
        rig.codex.isThere = true
        #expect(await install(rig) == updated, "the run that does the install tells it")
        #expect(rig.notice.pendingVersion == nil)
    }

    @MainActor @Test func anInstallThatFailsLeavesTheMarkAndSaysItsFailure() async throws {
        let rig = try LiveSystemActionsTests().rig(responses: { call in call.isInstallEngine ? StepRunner.failed() : nil })
        defer { rig.home.remove() }
        try rig.notice.leave(version: seven)
        let outcome = await install(rig)
        #expect(outcome == ActionOutcome(kind: .failure, message: InstallMessages.engineFailed))
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
        #expect(rig.notice.pendingVersion == seven)
    }

    @MainActor @Test func withoutClaudeCodeTheEngineOnlyLineStaysAndTheMarkGoesWithIt() async throws {
        // There is no Claude conversation to tell about, so the update line has nothing to say here; and it would be
        // out of place on the day Claude Code arrives, so the mark goes.
        let rig = try LiveSystemActionsTests().rig(claudeInstalled: false)
        defer { rig.home.remove() }
        try rig.notice.leave(version: seven)
        #expect(await install(rig) == ActionOutcome(kind: .success, message: LiveSystemActions.engineOnly))
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
}
