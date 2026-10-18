import Foundation
import Testing
@testable import cua_bar

/// A release list that answers from a script and counts how often it was asked. No network.
final class FakeFetcher: ReleaseFetching, @unchecked Sendable {
    private let lock = NSLock()
    private var answer: Result<Data, any Error>
    private var asked = 0

    init(_ data: Data) { answer = .success(data) }
    init(json: String) { answer = .success(Data(json.utf8)) }
    init(failing error: any Error) { answer = .failure(error) }

    var callCount: Int { lock.withLock { asked } }

    func set(json: String) { lock.withLock { answer = .success(Data(json.utf8)) } }
    func setFailing() { lock.withLock { answer = .failure(ReleaseFetchError.badResponse) } }

    func fetchReleaseList() async throws -> Data {
        try lock.withLock {
            asked += 1
            return try answer.get()
        }
    }

    /// A list with one stable app release.
    static func list(_ versions: String...) -> String {
        "[" + versions.map { #"{"tag_name": "cua-bar--v\#($0)", "draft": false, "prerelease": false, "html_url": "https://github.com/chenjingdev/chenjing-plugins/releases/tag/cua-bar--v\#($0)"}"# }.joined(separator: ",") + "]"
    }
}

/// A clock a test moves by hand.
final class ClockBox: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date
    init(_ start: Date) { current = start }
    var now: Date { lock.withLock { current } }
    func advance(hours: Double) { lock.withLock { current = current.addingTimeInterval(hours * 3600) } }
    var read: @Sendable () -> Date { { [self] in now } }
}

@MainActor
struct ReleaseCheckerTests {
    private let start = Date(timeIntervalSince1970: 1_792_000_000)

    private func checker(
        app: String? = "0.7.0", fetcher: FakeFetcher, suite: DefaultsSuite, clock: ClockBox, sleeper: ManualSleeper = ManualSleeper()
    ) -> ReleaseChecker {
        ReleaseChecker(appVersion: app, fetcher: fetcher, defaults: suite.defaults, clock: clock.read, sleep: sleeper.sleep)
    }

    /// Polls until `condition` holds; a passing test returns at once.
    private func waitUntil(_ timeout: Double = 30, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { try? await Task.sleep(for: .milliseconds(2)) }
        return condition()
    }

    // MARK: What the footer shows

    @Test func aNewerReleaseShowsTheButtonWithItsPage() async {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let checker = checker(fetcher: FakeFetcher(json: FakeFetcher.list("0.7.0", "0.8.0")), suite: suite, clock: ClockBox(start))
        #expect(checker.newRelease == nil, "nothing is claimed before a check")
        #expect(await checker.checkIfDue() == .checked)
        #expect(checker.newRelease?.version == VersionNumber(0, 8, 0))
        #expect(checker.newRelease?.buttonTitle == "새 버전 0.8.0")
        #expect(checker.newRelease?.url.absoluteString == "https://github.com/chenjingdev/chenjing-plugins/releases/tag/cua-bar--v0.8.0")
    }

    @Test func theSameOrAnOlderReleaseShowsNothing() async {
        for list in [FakeFetcher.list("0.7.0"), FakeFetcher.list("0.6.9", "0.5.0"), "[]"] {
            let suite = DefaultsSuite()
            defer { suite.remove() }
            let checker = checker(fetcher: FakeFetcher(json: list), suite: suite, clock: ClockBox(start))
            #expect(await checker.checkIfDue() == .checked)
            #expect(checker.newRelease == nil, "list \(list)")
        }
    }

    @Test func versionsAreComparedAsNumbers() async {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let checker = checker(app: "0.9.0", fetcher: FakeFetcher(json: FakeFetcher.list("0.10.0")), suite: suite, clock: ClockBox(start))
        await checker.checkIfDue()
        #expect(checker.newRelease?.version == VersionNumber(0, 10, 0), "0.10.0 is newer than 0.9.0")
    }

    @Test func anAppWithoutAVersionNeverHasANewerRelease() async {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let sleeper = ManualSleeper()
        let fetcher = FakeFetcher(json: FakeFetcher.list("9.9.9"))
        let checker = checker(app: nil, fetcher: fetcher, suite: suite, clock: ClockBox(start), sleeper: sleeper)
        await checker.checkIfDue()
        #expect(checker.newRelease == nil)
        // Run unbundled (swift run) it does not even ask: there is nothing to compare with.
        checker.start()
        await Task.yield()
        #expect(sleeper.requestedDurations.isEmpty)
        #expect(fetcher.callCount == 1, "only the explicit check above")
    }

    // MARK: Once a day

    @Test func itChecksOnceADayAndNotBefore() async {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let clock = ClockBox(start)
        let fetcher = FakeFetcher(json: FakeFetcher.list("0.8.0"))
        let checker = checker(fetcher: fetcher, suite: suite, clock: clock)
        #expect(await checker.checkIfDue() == .checked)
        #expect(fetcher.callCount == 1)
        clock.advance(hours: 23)
        #expect(await checker.checkIfDue() == .skipped(remaining: 3600))
        #expect(fetcher.callCount == 1, "23 hours is not a day")
        clock.advance(hours: 1)
        #expect(await checker.checkIfDue() == .checked)
        #expect(fetcher.callCount == 2)
        #expect(await checker.checkIfDue() == .skipped(remaining: 24 * 3600))
        #expect(fetcher.callCount == 2)
    }

    @Test func aNewCopyOfTheAppRemembersTheLastCheck() async {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let clock = ClockBox(start)
        let fetcher = FakeFetcher(json: FakeFetcher.list("0.8.0"))
        await checker(fetcher: fetcher, suite: suite, clock: clock).checkIfDue()
        clock.advance(hours: 5)
        let restarted = checker(fetcher: fetcher, suite: suite, clock: clock)
        #expect(await restarted.checkIfDue() == .skipped(remaining: 19 * 3600))
        #expect(fetcher.callCount == 1, "five hours after the last check: no new request")
        #expect(restarted.newRelease?.version == VersionNumber(0, 8, 0), "the stored result is shown at once, even offline")
        clock.advance(hours: 20)
        #expect(await restarted.checkIfDue() == .checked)
        #expect(fetcher.callCount == 2, "more than a day after the last check, at start")
    }

    @Test func aClockSetBackDoesNotSilenceTheCheckForever() async {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let clock = ClockBox(start)
        let fetcher = FakeFetcher(json: FakeFetcher.list("0.8.0"))
        let checker = checker(fetcher: fetcher, suite: suite, clock: clock)
        await checker.checkIfDue()
        clock.advance(hours: -48)
        #expect(await checker.checkIfDue() == .checked)
        #expect(fetcher.callCount == 2)
    }

    @Test func theLoopChecksAtStartAndThenEveryDayWhileRunning() async {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let clock = ClockBox(start)
        let sleeper = ManualSleeper()
        let fetcher = FakeFetcher(json: FakeFetcher.list("0.8.0"))
        let checker = checker(fetcher: fetcher, suite: suite, clock: clock, sleeper: sleeper)
        checker.start()
        #expect(await waitUntil { sleeper.requestedDurations.count == 1 })
        #expect(fetcher.callCount == 1, "nothing was ever checked: check at once")
        #expect(sleeper.requestedDurations == [.seconds(24 * 3600)])
        clock.advance(hours: 24)
        #expect(sleeper.releaseAll() == 1)
        #expect(await waitUntil { sleeper.requestedDurations.count == 2 })
        #expect(fetcher.callCount == 2)
        #expect(sleeper.requestedDurations == [.seconds(24 * 3600), .seconds(24 * 3600)])
        checker.stop()
    }

    @Test func theLoopWaitsOutTheRestOfTheDayWhenTheLastCheckIsRecent() async {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let clock = ClockBox(start)
        let fetcher = FakeFetcher(json: FakeFetcher.list("0.8.0"))
        await checker(fetcher: fetcher, suite: suite, clock: clock).checkIfDue()
        clock.advance(hours: 3)
        let sleeper = ManualSleeper()
        let restarted = checker(fetcher: fetcher, suite: suite, clock: clock, sleeper: sleeper)
        restarted.start()
        #expect(await waitUntil { sleeper.requestedDurations.count == 1 })
        #expect(fetcher.callCount == 1, "three hours after the last check: no request at start")
        #expect(sleeper.requestedDurations == [.seconds(21 * 3600)])
        restarted.stop()
    }

    @Test func startingTwiceStartsOneLoopAndStoppingEndsIt() async {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let sleeper = ManualSleeper()
        let fetcher = FakeFetcher(json: FakeFetcher.list("0.8.0"))
        let checker = checker(fetcher: fetcher, suite: suite, clock: ClockBox(start), sleeper: sleeper)
        checker.start()
        checker.start()
        #expect(await waitUntil { sleeper.requestedDurations.count == 1 })
        checker.stop()
        #expect(await waitUntil { sleeper.pendingDurations.isEmpty })
        #expect(fetcher.callCount == 1)
        #expect(sleeper.requestedDurations.count == 1)
    }

    // MARK: Failures are silent

    @Test func aFailedCheckChangesNothingAndSaysNothing() async {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let clock = ClockBox(start)
        let fetcher = FakeFetcher(json: FakeFetcher.list("0.8.0"))
        let checker = checker(fetcher: fetcher, suite: suite, clock: clock)
        await checker.checkIfDue()
        let checkedAt = checker.lastCheckedAt
        clock.advance(hours: 30)
        fetcher.setFailing()
        #expect(await checker.checkIfDue() == .failed)
        #expect(checker.newRelease?.version == VersionNumber(0, 8, 0), "the last result is kept")
        #expect(checker.lastCheckedAt == checkedAt, "a failed check is not a check")
        // The next try is as soon as anyone asks, because the last good check is still old.
        fetcher.set(json: FakeFetcher.list("0.9.0"))
        #expect(await checker.checkIfDue() == .checked)
        #expect(checker.newRelease?.version == VersionNumber(0, 9, 0))
    }

    @Test(arguments: ["not json", #"{"message": "rate limited"}"#, ""])
    func aListThatCannotBeReadIsAFailureToo(garbage: String) async {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let clock = ClockBox(start)
        let fetcher = FakeFetcher(json: FakeFetcher.list("0.8.0"))
        let checker = checker(fetcher: fetcher, suite: suite, clock: clock)
        await checker.checkIfDue()
        clock.advance(hours: 25)
        fetcher.set(json: garbage)
        #expect(await checker.checkIfDue() == .failed)
        #expect(checker.newRelease?.version == VersionNumber(0, 8, 0))
    }

    @Test func aFailureAtFirstLeavesNothingToShow() async {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let checker = checker(fetcher: FakeFetcher(failing: ReleaseFetchError.badResponse), suite: suite, clock: ClockBox(start))
        #expect(await checker.checkIfDue() == .failed)
        #expect(checker.newRelease == nil)
        #expect(checker.lastCheckedAt == nil)
    }

    @Test func theLoopAfterAFailureWaitsADayLikeAfterASuccess() async {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let sleeper = ManualSleeper()
        let checker = checker(fetcher: FakeFetcher(failing: ReleaseFetchError.badResponse), suite: suite, clock: ClockBox(start), sleeper: sleeper)
        checker.start()
        #expect(await waitUntil { sleeper.requestedDurations.count == 1 })
        #expect(sleeper.requestedDurations == [.seconds(24 * 3600)], "once a day is the promise: no retry storm")
        checker.stop()
    }

    // MARK: The stored result against the running app

    @Test func onceTheAppIsUpdatedTheStoredReleaseIsNoLongerNew() async {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let clock = ClockBox(start)
        let fetcher = FakeFetcher(json: FakeFetcher.list("0.8.0"))
        await checker(app: "0.7.0", fetcher: fetcher, suite: suite, clock: clock).checkIfDue()
        let updated = checker(app: "0.8.0", fetcher: fetcher, suite: suite, clock: clock)
        #expect(updated.newRelease == nil)
        let older = checker(app: "0.7.0", fetcher: fetcher, suite: suite, clock: clock)
        #expect(older.newRelease?.version == VersionNumber(0, 8, 0))
    }

    @Test func aReleaseThatDisappearsFromTheListNoLongerShows() async {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let clock = ClockBox(start)
        let fetcher = FakeFetcher(json: FakeFetcher.list("0.8.0"))
        let checker = checker(fetcher: fetcher, suite: suite, clock: clock)
        await checker.checkIfDue()
        #expect(checker.newRelease != nil)
        clock.advance(hours: 25)
        fetcher.set(json: FakeFetcher.list("0.7.0")) // the 0.8.0 release was withdrawn
        await checker.checkIfDue()
        #expect(checker.newRelease == nil)
    }

    // MARK: onNewVersion, once per version

    @Test func theClosureIsCalledOncePerVersion() async {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let clock = ClockBox(start)
        let fetcher = FakeFetcher(json: FakeFetcher.list("0.8.0"))
        var heard: [String] = []
        let checker = checker(fetcher: fetcher, suite: suite, clock: clock)
        checker.onNewVersion = { heard.append($0) }
        await checker.checkIfDue()
        #expect(heard == ["0.8.0"])
        clock.advance(hours: 25)
        await checker.checkIfDue() // the same release again
        #expect(heard == ["0.8.0"])
        clock.advance(hours: 25)
        fetcher.set(json: FakeFetcher.list("0.8.0", "0.8.1"))
        await checker.checkIfDue()
        #expect(heard == ["0.8.0", "0.8.1"])
    }

    @Test func theClosureCanBeGivenWhenTheCheckerIsMade() async {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        var heard: [String] = []
        let checker = ReleaseChecker(
            appVersion: "0.7.0", fetcher: FakeFetcher(json: FakeFetcher.list("0.8.0")), defaults: suite.defaults,
            clock: ClockBox(start).read, sleep: ManualSleeper().sleep, onNewVersion: { heard.append($0) })
        await checker.checkIfDue()
        #expect(heard == ["0.8.0"])
    }

    @Test func aRestartDoesNotTellAgain() async {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let clock = ClockBox(start)
        let fetcher = FakeFetcher(json: FakeFetcher.list("0.8.0"))
        var heard: [String] = []
        let first = checker(fetcher: fetcher, suite: suite, clock: clock)
        first.onNewVersion = { heard.append($0) }
        await first.checkIfDue()
        clock.advance(hours: 25)
        let second = checker(fetcher: fetcher, suite: suite, clock: clock)
        second.onNewVersion = { heard.append($0) }
        await second.checkIfDue()
        #expect(heard == ["0.8.0"])
        #expect(second.newRelease != nil, "the footer button still shows it")
    }

    @Test func noClosureCallWhenNothingIsNewer() async {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        var heard: [String] = []
        let checker = checker(fetcher: FakeFetcher(json: FakeFetcher.list("0.7.0")), suite: suite, clock: ClockBox(start))
        checker.onNewVersion = { heard.append($0) }
        await checker.checkIfDue()
        #expect(heard.isEmpty)
    }

    @Test func aClosureSetLaterStillGetsTheVersionAtTheNextCheck() async {
        let suite = DefaultsSuite()
        defer { suite.remove() }
        let clock = ClockBox(start)
        let fetcher = FakeFetcher(json: FakeFetcher.list("0.8.0"))
        let checker = checker(fetcher: fetcher, suite: suite, clock: clock)
        await checker.checkIfDue() // nobody is listening yet
        var heard: [String] = []
        checker.onNewVersion = { heard.append($0) }
        clock.advance(hours: 25)
        await checker.checkIfDue()
        #expect(heard == ["0.8.0"])
    }

    // MARK: The request itself

    @Test func theRequestIsOneAnonymousGetWithAFixedUserAgentAndTenSeconds() {
        let request = GitHubReleaseFetcher.request()
        #expect(request.url?.absoluteString == "https://api.github.com/repos/chenjingdev/chenjing-plugins/releases?per_page=50")
        #expect(request.httpMethod == "GET")
        #expect(request.timeoutInterval == 10)
        #expect(request.value(forHTTPHeaderField: "User-Agent") == "CUABar-update-check")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil, "no token")
        #expect(request.allHTTPHeaderFields?.keys.contains { $0.lowercased() == "cookie" } != true)
        #expect(request.httpShouldHandleCookies == false)
        #expect(request.httpBody == nil)
    }
}
