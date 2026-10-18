import AppKit
import Foundation
import Testing
@testable import cua_bar

/// The decision whether a second copy leaves. Asking the system who is running is a thin layer
/// over this and is not run here (it would look at the real apps on this Mac).
struct SingleInstanceTests {
    private let t0 = Date(timeIntervalSince1970: 1_792_000_000)

    private func instance(_ pid: Int32, launched seconds: Double? = 0, terminated: Bool = false) -> SingleInstance.Instance {
        SingleInstance.Instance(pid: pid, launchDate: seconds.map { t0.addingTimeInterval($0) }, isTerminated: terminated)
    }

    @Test func aCopyAloneStays() {
        #expect(!SingleInstance.shouldExit(me: instance(100), others: []))
        // The system lists this copy too; it is not "another".
        #expect(!SingleInstance.shouldExit(me: instance(100), others: [instance(100)]))
    }

    @Test func aCopyThatStartedEarlierMakesThisOneLeave() {
        #expect(SingleInstance.shouldExit(me: instance(200, launched: 60), others: [instance(100, launched: 0), instance(200, launched: 60)]))
    }

    @Test func aCopyThatIsAlreadyQuittingDoesNotCount() {
        #expect(!SingleInstance.shouldExit(me: instance(200, launched: 60), others: [instance(100, launched: 0, terminated: true)]))
    }

    @Test func twoCopiesOpenedTogetherDoNotBothLeave() {
        let first = instance(100, launched: 5)
        let second = instance(101, launched: 5)
        #expect(!SingleInstance.shouldExit(me: first, others: [first, second]), "the lower pid stays")
        #expect(SingleInstance.shouldExit(me: second, others: [first, second]), "the higher pid leaves")
        let early = instance(300, launched: 1)
        let late = instance(200, launched: 2)
        #expect(!SingleInstance.shouldExit(me: early, others: [early, late]), "the earlier launch stays whatever the pids")
        #expect(SingleInstance.shouldExit(me: late, others: [early, late]))
    }

    @Test func aCopyWithoutALaunchDateIsTakenToBeAlreadyRunning() {
        #expect(SingleInstance.shouldExit(me: instance(200, launched: 60), others: [instance(100, launched: nil)]))
        // And this copy without one is the newcomer.
        #expect(SingleInstance.shouldExit(me: instance(200, launched: nil), others: [instance(100, launched: 60)]))
    }

    @Test func theBundleIdentifierIsTheAppsOwn() {
        #expect(SingleInstance.bundleIdentifier == "dev.chenjing.cua-bar")
    }

    @Test func aCopyRunUnbundledNeverLeavesBecauseOfTheInstalledApp() {
        // `swift test` runs inside a test bundle's host, whose identifier is not the app's.
        #expect(Bundle.main.bundleIdentifier != SingleInstance.bundleIdentifier)
        #expect(!SingleInstance.anotherCopyIsRunning())
    }

    // MARK: What the system lists

    @Test func thisCopyIsFoundByItsProcessIdAmongWhatTheSystemLists() {
        let mine = instance(100, launched: 60)
        let older = instance(50, launched: 0)
        let newer = instance(200, launched: 120)
        #expect(!SingleInstance.shouldExit(running: [], myProcessIdentifier: 100), "not even listed yet: alone")
        #expect(!SingleInstance.shouldExit(running: [mine], myProcessIdentifier: 100))
        #expect(SingleInstance.shouldExit(running: [older, mine], myProcessIdentifier: 100))
        #expect(!SingleInstance.shouldExit(running: [mine, newer], myProcessIdentifier: 100), "the newer one is the one that leaves")
        #expect(SingleInstance.shouldExit(running: [older], myProcessIdentifier: 100), "listed copy, this one not registered yet: the newcomer")
        #expect(!SingleInstance.shouldExit(running: [newer, mine], myProcessIdentifier: 100))
    }

    @Test func theRealSystemQueryFindsNobodyElseForAnIdentifierNothingRuns() {
        // The real lookup by identifier, made the way the app makes it. Nothing runs under this
        // identifier, so nobody else is found and the copy stays.
        let unused = "dev.chenjing.cua-bar.test-\(UUID().uuidString)"
        #expect(NSRunningApplication.runningApplications(withBundleIdentifier: unused).isEmpty)
        #expect(!SingleInstance.anotherCopyIsRunning(bundleIdentifier: unused, mainBundleIdentifier: unused))
    }
}
