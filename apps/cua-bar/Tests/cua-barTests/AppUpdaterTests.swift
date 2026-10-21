import Foundation
import Testing
@testable import cua_bar

/// The updater's own decisions (F4, R7, R8), with a transport and an installer that answer from scripts: when it looks,
/// when it goes ahead, when it waits, what a failure leaves. The update itself is `UpdateInstallerTests`.
@MainActor
struct AppUpdaterTests {
    /// What the updater was told to do, and what it says: how often the app ended, which versions it told about.
    @MainActor final class Heard {
        var quits = 0
        var failures: [String] = []
        /// Whether the popover is closed and nothing runs.
        var wayIsFree = true
    }

    struct Kit {
        var updater: AppUpdater
        var transport: FakeTransport
        var installer: FakeInstaller
        var suite: DefaultsSuite
        var sleeper: ManualSleeper
        var heard: Heard
        var clock: ClockBox
    }

    private let start = Date(timeIntervalSince1970: 1_792_000_000)
    private let offer = UpdateOffer(
        version: VersionNumber(0, 8, 0), file: "CUABar-v0.8.0-macos-arm64.dmg", sha256: String(repeating: "ab", count: 32), size: 1234)

    private func kit(
        app: String? = "0.7.0", site: String = versionDocument("0.8.0"), installer: FakeInstaller = FakeInstaller(.replaced),
        bundled: Bool = true, suite: DefaultsSuite = DefaultsSuite(), transport: FakeTransport? = nil, wayIsFree: Bool = true
    ) -> Kit {
        let transport = transport ?? FakeTransport(document: site)
        let heard = Heard()
        heard.wayIsFree = wayIsFree
        let sleeper = ManualSleeper()
        let clock = ClockBox(start)
        let updater = AppUpdater(
            appVersion: app, transport: transport, installer: bundled ? installer : nil, defaults: suite.defaults, clock: clock.read,
            sleep: sleeper.sleep, quit: { heard.quits += 1 })
        updater.onFailure = { heard.failures.append($0) }
        updater.canReplaceNow = { heard.wayIsFree }
        return Kit(updater: updater, transport: transport, installer: installer, suite: suite, sleeper: sleeper, heard: heard, clock: clock)
    }

    /// Polls until `condition` holds; a passing test returns at once.
    private func waitUntil(_ timeout: Double = 30, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { try? await Task.sleep(for: .milliseconds(2)) }
        return condition()
    }

    // MARK: When it goes ahead

    @Test func aHigherVersionIsInstalledAndThenTheAppEnds() async {
        let kit = kit()
        defer { kit.suite.remove() }
        await kit.updater.check()
        #expect(kit.transport.versionRequestCount == 1)
        #expect(kit.installer.offers == [offer])
        #expect(kit.heard.quits == 1, "the new one is opened by the helper once this one has ended")
        #expect(kit.updater.failure == nil)
        #expect(kit.heard.failures.isEmpty)
    }

    @Test func versionsAreComparedAsNumbers() async {
        let kit = kit(app: "0.9.0", site: versionDocument("0.10.0"))
        defer { kit.suite.remove() }
        await kit.updater.check()
        #expect(kit.installer.offers.map(\.version) == [VersionNumber(0, 10, 0)], "0.10.0 is newer than 0.9.0")
    }

    @Test(arguments: ["0.7.0", "0.6.9", "0.0.1"])
    func theSameOrALowerVersionIsLeftAlone(latest: String) async {
        let kit = kit(site: versionDocument(latest))
        defer { kit.suite.remove() }
        await kit.updater.check()
        #expect(kit.transport.versionRequestCount == 1)
        #expect(kit.installer.offers.isEmpty)
        #expect(kit.heard.quits == 0)
        #expect(kit.updater.failure == nil)
    }

    @Test func aDevelopmentBuildNeverLooksAtAll() async {
        // Not run from an app bundle: there is nothing to replace.
        let unbundled = kit(bundled: false)
        defer { unbundled.suite.remove() }
        unbundled.updater.start()
        await unbundled.updater.check()
        await unbundled.updater.applyIfPossible()
        #expect(unbundled.transport.versionRequestCount == 0)
        #expect(unbundled.sleeper.requestedDurations.isEmpty)
        #expect(unbundled.heard.quits == 0)

        // No version of its own: nothing to compare the site's with.
        let versionless = kit(app: nil)
        defer { versionless.suite.remove() }
        versionless.updater.start()
        await versionless.updater.check()
        #expect(versionless.transport.versionRequestCount == 0)
        #expect(versionless.installer.offers.isEmpty)
        #expect(versionless.sleeper.requestedDurations.isEmpty)
    }

    // MARK: When the way is not free (R8)

    @Test func whileThePopoverIsOpenOrWorkRunsItWaitsAndGoesAheadWhenTheWayIsFree() async {
        let kit = kit(wayIsFree: false)
        defer { kit.suite.remove() }
        await kit.updater.check()
        #expect(kit.transport.versionRequestCount == 1, "it looked: only the replacing waits")
        #expect(kit.installer.offers.isEmpty, "not even fetched")
        #expect(kit.heard.quits == 0)
        #expect(kit.updater.failure == nil, "waiting is not failing")
        // Passes after each status read: nothing happens while the way is shut.
        await kit.updater.applyIfPossible()
        await kit.updater.applyIfPossible()
        #expect(kit.installer.offers.isEmpty)
        // The popover closes.
        kit.heard.wayIsFree = true
        await kit.updater.applyIfPossible()
        #expect(kit.installer.offers == [offer])
        #expect(kit.heard.quits == 1)
        // Once done there is nothing left waiting.
        await kit.updater.applyIfPossible()
        #expect(kit.installer.offers.count == 1)
    }

    @Test func aMomentThatPassesWhileFetchingIsNotAFailureAndIsTriedAgainAtTheNextPass() async {
        let kit = kit(installer: FakeInstaller(.deferred, .replaced))
        defer { kit.suite.remove() }
        await kit.updater.check()
        #expect(kit.installer.offers.count == 1)
        #expect(kit.heard.quits == 0)
        #expect(kit.updater.failure == nil)
        #expect(kit.heard.failures.isEmpty)
        await kit.updater.applyIfPossible()
        #expect(kit.installer.offers.count == 2)
        #expect(kit.heard.quits == 1)
    }

    @Test func thePassesAfterTheStatusReadsDoNotStartASecondInstallWhileOneRuns() async {
        let installer = FakeInstaller(.replaced)
        let gate = AsyncGate()
        installer.gate = gate
        let kit = kit(installer: installer)
        defer { kit.suite.remove() }
        let checking = Task { await kit.updater.check() }
        #expect(await waitUntil { installer.offers.count == 1 })
        await kit.updater.applyIfPossible()
        await kit.updater.applyIfPossible()
        #expect(installer.offers.count == 1)
        gate.open()
        await checking.value
        #expect(kit.heard.quits == 1)
    }

    @Test func theMomentTheInstallerAsksBeforeReplacingIsTheOneAtThatTimeNotTheOneAtTheStart() async {
        let installer = FakeInstaller(.replaced)
        installer.asksTheMoment = true
        let gate = AsyncGate()
        installer.gate = gate
        let kit = kit(installer: installer)
        defer { kit.suite.remove() }
        let checking = Task { await kit.updater.check() }
        #expect(await waitUntil { installer.offers.count == 1 })
        kit.heard.wayIsFree = false // the popover opens while the file is being fetched
        gate.open()
        await checking.value
        #expect(installer.momentsAsked == [false])
        #expect(kit.heard.quits == 0, "nothing was replaced under someone's eyes")
        #expect(kit.updater.failure == nil)
        kit.heard.wayIsFree = true // and closes again
        await kit.updater.applyIfPossible()
        #expect(installer.momentsAsked == [false, true])
        #expect(kit.heard.quits == 1)
    }

    // MARK: Failure

    @Test(arguments: [UpdateStep.place, .download, .checksum, .image, .signature, .team, .version, .replace, .relaunch])
    func aFailureAtAnyStepLeavesTheAppShowsTheButtonAndTellsOnce(step: UpdateStep) async {
        let kit = kit(installer: FakeInstaller(.failed(step)))
        defer { kit.suite.remove() }
        await kit.updater.check()
        #expect(kit.heard.quits == 0, "the running app stays")
        let failure = kit.updater.failure
        #expect(failure == UpdateFailure(version: VersionNumber(0, 8, 0), step: step, at: start))
        #expect(failure?.buttonTitle == "새 버전 0.8.0")
        #expect(kit.updater.diagnosisLine == "업데이트 실패: 새 버전 0.8.0 — \(step.reason)")
        #expect(kit.heard.failures == ["0.8.0"])
    }

    @Test func everyStepHasItsOwnFixedLine() {
        let steps: [UpdateStep] = [.offer, .place, .download, .checksum, .image, .signature, .team, .version, .replace, .relaunch]
        #expect(Set(steps.map(\.reason)).count == steps.count)
        // Nothing a command or the site printed is ever part of it.
        #expect(steps.allSatisfy { !$0.reason.isEmpty && !$0.reason.contains("/") })
    }

    @Test func theNotificationIsOncePerVersionEvenWhenItFailsAgain() async {
        let kit = kit(installer: FakeInstaller(.failed(.checksum)))
        defer { kit.suite.remove() }
        await kit.updater.check()
        await kit.updater.check() // the next check: the same version, the same failure
        #expect(kit.heard.failures == ["0.8.0"])
        // Another version that fails is another notification.
        kit.transport.set(document: versionDocument("0.8.1"))
        await kit.updater.check()
        #expect(kit.heard.failures == ["0.8.0", "0.8.1"])
        #expect(kit.updater.failure?.version == VersionNumber(0, 8, 1))
    }

    @Test func aNewRunDoesNotTellAgainButShowsTheButtonAtOnce() async {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let first = kit(installer: FakeInstaller(.failed(.checksum)), suite: suite)
        await first.updater.check()
        #expect(first.heard.failures == ["0.8.0"])

        let second = kit(installer: FakeInstaller(.failed(.checksum)), suite: suite)
        #expect(second.updater.failure == UpdateFailure(version: VersionNumber(0, 8, 0), step: .checksum, at: start), "before any look has an answer")
        await second.updater.check()
        #expect(second.heard.failures.isEmpty, "that version was told about")
    }

    @Test func aBuildThatDoesNotUpdateShowsNoButtonWhateverAnInstalledAppLeftBehind() async {
        // A local build signed ad hoc has the app's identifier, so it reads the same preferences.
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let installed = kit(installer: FakeInstaller(.failed(.checksum)), suite: suite)
        await installed.updater.check()
        #expect(installed.updater.failure != nil)

        let local = kit(bundled: false, suite: suite)
        #expect(local.updater.failure == nil, "like a development build: no check and no button")
        local.updater.start()
        await local.updater.check()
        #expect(local.transport.versionRequestCount == 0)
        #expect(local.updater.failure == nil)

        // What the installed app left is still there for the installed app.
        let again = kit(installer: FakeInstaller(.replaced), suite: suite)
        #expect(again.updater.failure == UpdateFailure(version: VersionNumber(0, 8, 0), step: .checksum, at: start))
    }

    @Test func theButtonGoesWhenTheAppHasCaughtUpWithThatVersion() async {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let first = kit(installer: FakeInstaller(.failed(.team)), suite: suite)
        await first.updater.check()
        #expect(first.updater.failure != nil)
        // The person got 0.8.0 by hand.
        let caughtUp = kit(app: "0.8.0", suite: suite)
        #expect(caughtUp.updater.failure == nil)
        let later = kit(app: "0.8.0", suite: suite)
        #expect(later.updater.failure == nil, "and it stays gone")
    }

    @Test func afterAFailureTheStatusReadsDoNotTryAgainButTheNextCheckDoes() async {
        let kit = kit(installer: FakeInstaller(.failed(.download), .replaced))
        defer { kit.suite.remove() }
        await kit.updater.check()
        #expect(kit.installer.offers.count == 1)
        await kit.updater.applyIfPossible()
        await kit.updater.applyIfPossible()
        #expect(kit.installer.offers.count == 1, "not at every status read")
        // The next check, a day later or at the next start.
        await kit.updater.check()
        #expect(kit.installer.offers.count == 2)
        #expect(kit.heard.quits == 1)
        #expect(kit.updater.failure == nil, "an update that worked leaves no button")
    }

    @Test func theNextRunTriesAgainAndNeedsNoMemoryOfTheFailure() async {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let first = kit(installer: FakeInstaller(.failed(.download)), suite: suite)
        await first.updater.check()
        let second = kit(installer: FakeInstaller(.replaced), suite: suite)
        second.updater.start()
        #expect(await waitUntil { second.heard.quits == 1 })
        #expect(second.installer.offers == [offer])
        second.updater.stop()
    }

    @Test func aNewerVersionThanTheFailedOneDropsTheOldButtonEvenBeforeItIsInstalled() async {
        let kit = kit(installer: FakeInstaller(.failed(.checksum), .deferred))
        defer { kit.suite.remove() }
        await kit.updater.check()
        #expect(kit.updater.failure?.version == VersionNumber(0, 8, 0))
        kit.transport.set(document: versionDocument("0.9.0"))
        await kit.updater.check()
        #expect(kit.updater.failure == nil, "'새 버전 0.8.0' would name the wrong one")
        #expect(kit.installer.offers.map(\.version) == [VersionNumber(0, 8, 0), VersionNumber(0, 9, 0)])
    }

    @Test func whenTheSiteNoLongerHasAnythingNewerTheButtonGoes() async {
        let kit = kit(installer: FakeInstaller(.failed(.checksum)))
        defer { kit.suite.remove() }
        await kit.updater.check()
        #expect(kit.updater.failure != nil)
        kit.transport.set(document: versionDocument("0.7.0"))
        await kit.updater.check()
        #expect(kit.updater.failure == nil)
    }

    @Test func aDocumentThatNamesANewerVersionButCannotBeUsedIsAFailureOfTheOfferStep() async {
        let kit = kit(site: versionDocument("0.8.0", file: "../evil.dmg"))
        defer { kit.suite.remove() }
        await kit.updater.check()
        #expect(kit.installer.offers.isEmpty, "nothing is fetched on such a document")
        #expect(kit.updater.failure == UpdateFailure(version: VersionNumber(0, 8, 0), step: .offer, at: start))
        #expect(kit.heard.failures == ["0.8.0"])
        #expect(kit.heard.quits == 0)
    }

    @Test(arguments: [
        versionDocument("0.7.0", sha256: "nope"), versionDocument("0.6.0", file: "x.dmg"), versionDocument("0.8", file: "x.dmg"),
        "not json", "[]", "{}", "",
    ])
    func aDocumentThatCannotBeUsedAndNamesNothingNewerChangesNothing(document: String) async {
        let kit = kit(site: document)
        defer { kit.suite.remove() }
        await kit.updater.check()
        #expect(kit.installer.offers.isEmpty)
        #expect(kit.updater.failure == nil)
        #expect(kit.heard.failures.isEmpty)
    }

    @Test func aLookThatFailsChangesNothingAndSaysNothing() async {
        let kit = kit(installer: FakeInstaller(.failed(.checksum)))
        defer { kit.suite.remove() }
        await kit.updater.check()
        let before = kit.updater.failure
        kit.transport.setDocumentFailing()
        await kit.updater.check() // offline
        #expect(kit.updater.failure == before, "the button stays")
        #expect(kit.heard.failures == ["0.8.0"])
        #expect(kit.installer.offers.count == 1)
        let fresh = FakeTransport(failing: UpdateTransportError.badResponse)
        let offline = self.kit(transport: fresh)
        defer { offline.suite.remove() }
        await offline.updater.check()
        #expect(offline.updater.failure == nil)
        #expect(offline.heard.failures.isEmpty)
    }

    // MARK: Once a day

    @Test func itLooksAtStartAndThenEveryDayWhileTheAppRuns() async {
        let kit = kit(site: versionDocument("0.7.0"))
        defer { kit.suite.remove() }
        kit.updater.start()
        #expect(await waitUntil { kit.sleeper.requestedDurations.count == 1 })
        #expect(kit.transport.versionRequestCount == 1, "at start, whatever the last look was")
        #expect(kit.sleeper.requestedDurations == [.seconds(24 * 3600)])
        #expect(kit.sleeper.releaseAll() == 1)
        #expect(await waitUntil { kit.sleeper.requestedDurations.count == 2 })
        #expect(kit.transport.versionRequestCount == 2)
        kit.updater.stop()
    }

    @Test func atStartItTidiesUpWhatAnEarlierRunLeftOnceAndBeforeTheFirstLook() async {
        let installer = FakeInstaller(.replaced)
        let kit = kit(site: versionDocument("0.7.0"), installer: installer)
        defer { kit.suite.remove() }
        let looks = LooksSeen()
        installer.onClearLeftovers = { [transport = kit.transport] in looks.record(transport.versionRequestCount) }
        kit.updater.start()
        #expect(await waitUntil { kit.sleeper.requestedDurations.count == 1 })
        #expect(installer.leftoversCleared == 1)
        #expect(looks.values == [0], "before the app has looked at anything")
        // The daily look does not tidy again; an install does, by itself.
        #expect(kit.sleeper.releaseAll() == 1)
        #expect(await waitUntil { kit.sleeper.requestedDurations.count == 2 })
        #expect(kit.transport.versionRequestCount == 2)
        #expect(installer.leftoversCleared == 1)
        kit.updater.stop()
    }

    final class LooksSeen: @unchecked Sendable {
        private let lock = NSLock()
        private var recorded: [Int] = []
        var values: [Int] { lock.withLock { recorded } }
        func record(_ value: Int) { lock.withLock { recorded.append(value) } }
    }

    @Test func aBuildThatDoesNotUpdateSaysSoInTheDiagnosis() async {
        // No installer: a development build, or a local build that is not signed as the official one is.
        let off = kit(bundled: false)
        defer { off.suite.remove() }
        off.updater.start()
        await off.updater.check()
        #expect(off.updater.diagnosisLine == "업데이트: 꺼짐(정식 서명 판이 아님)")
        #expect(AppUpdater.offLine == "업데이트: 꺼짐(정식 서명 판이 아님)")
    }

    @Test func theDiagnosisSaysNothingWhileTheUpdatesWorkAndTheFailureWhenOneFailed() async {
        let working = kit()
        defer { working.suite.remove() }
        #expect(working.updater.diagnosisLine == nil)
        let failing = kit(installer: FakeInstaller(.failed(.team)))
        defer { failing.suite.remove() }
        await failing.updater.check()
        #expect(failing.updater.diagnosisLine == "업데이트 실패: 새 버전 0.8.0 — \(UpdateStep.team.reason)")
    }

    @Test func theLinesTheAppAddsToTheCopiedDiagnosis() {
        let login = "로그인 때 자동 실행: 켜짐"
        #expect(DiagnosisPasteboard.appLines(appVersion: "0.8.0", loginItemLine: login, updateLine: nil) == "앱: CUA Bar 0.8.0\n로그인 때 자동 실행: 켜짐")
        #expect(
            DiagnosisPasteboard.appLines(appVersion: nil, loginItemLine: login, updateLine: AppUpdater.offLine)
                == "앱: CUA Bar 개발용\n로그인 때 자동 실행: 켜짐\n업데이트: 꺼짐(정식 서명 판이 아님)")
    }

    @Test func aLookThatFailedWaitsADayLikeAGoodOne() async {
        let kit = kit(transport: FakeTransport(failing: UpdateTransportError.badResponse))
        defer { kit.suite.remove() }
        kit.updater.start()
        #expect(await waitUntil { kit.sleeper.requestedDurations.count == 1 })
        #expect(kit.sleeper.requestedDurations == [.seconds(24 * 3600)], "no retry storm")
        kit.updater.stop()
    }

    @Test func startingTwiceStartsOneLoopAndStoppingEndsIt() async {
        let kit = kit(site: versionDocument("0.7.0"))
        defer { kit.suite.remove() }
        kit.updater.start()
        kit.updater.start()
        #expect(await waitUntil { kit.sleeper.requestedDurations.count == 1 })
        kit.updater.stop()
        #expect(await waitUntil { kit.sleeper.pendingDurations.isEmpty })
        #expect(kit.transport.versionRequestCount == 1)
        #expect(kit.sleeper.requestedDurations.count == 1)
    }

    @Test func atStartTheUpdateWaitsForTheInstallThatIsRunningThenGoesAhead() async {
        // The app just started: the install runs, the popover is shut. The look is done, the replacing waits.
        let kit = kit(wayIsFree: false)
        defer { kit.suite.remove() }
        kit.updater.start()
        #expect(await waitUntil { kit.sleeper.requestedDurations.count == 1 })
        #expect(kit.transport.versionRequestCount == 1)
        #expect(kit.installer.offers.isEmpty)
        kit.heard.wayIsFree = true // the install is done; the next status read passes by
        await kit.updater.applyIfPossible()
        #expect(kit.installer.offers == [offer])
        #expect(kit.heard.quits == 1)
        kit.updater.stop()
    }

    // MARK: What "the way is free" is made of

    @Test func theModelIsQuietForAnUpdateOnlyWhileNothingIsInTheWay() async throws {
        let engine = FakeEngineClient(status: try Fixtures.status("status-ready"))
        let activity = SetupActivity()
        let model = CUABarViewModel(
            engine: engine, appVersion: "0.7.0", pasteboard: RecordingPasteboard(), clock: { Fixtures.now }, calendar: Fixtures.utc,
            sleep: ManualSleeper().sleep, setupActivity: activity)
        await model.refresh()
        await model.waitForBackgroundWork()
        #expect(model.isQuietForUpdate)

        model.setPopoverOpen(true)
        #expect(!model.isQuietForUpdate, "someone is looking at it")
        model.setPopoverOpen(false)
        #expect(model.isQuietForUpdate)

        // A setup runs.
        #expect(activity.begin())
        #expect(!model.isQuietForUpdate)
        activity.end(succeeded: true)
        #expect(model.isQuietForUpdate)

        // A button's action is under way (here the diagnosis copy, held at a gate).
        let gate = AsyncGate()
        engine.configure { $0.actionGate = gate }
        let running = Task { await model.perform(.copyDiagnosis) }
        #expect(await yieldUntil { !model.isQuietForUpdate })
        gate.open()
        _ = await running.value
        await model.waitForBackgroundWork()
        #expect(model.isQuietForUpdate)
    }

    @Test func theRemovalIsRunningWhileItUndoesThingsAndWhenItHasFinishedButNotBefore() async throws {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let engine = FakeEngineClient()
        let sleeper = ManualSleeper()
        let registrar = LoginItemRegistrar(service: FakeLoginItem(status: .enabled), defaults: suite.defaults)
        let flow = RemovalFlow(engine: engine, loginItem: registrar, quit: {}, sleep: sleeper.sleep)
        #expect(!flow.isRunning)
        flow.ask()
        #expect(!flow.isRunning, "a question on screen is the popover being open, which has its own check")
        let gate = AsyncGate()
        engine.configure { $0.actionGate = gate }
        let confirming = Task { await flow.confirm() }
        #expect(await waitUntil { engine.calls.contains(.uninstall) })
        #expect(flow.isRunning)
        gate.open()
        #expect(await waitUntil { !sleeper.requestedDurations.isEmpty })
        #expect(flow.isRunning, "finished, and about to quit")
        sleeper.releaseAll()
        await confirming.value
    }
}
