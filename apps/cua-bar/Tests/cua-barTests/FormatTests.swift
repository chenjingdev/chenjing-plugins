import Foundation
import Testing
@testable import cua_bar

struct FormatTests {
    // MARK: Idle text (R16: more than 30 minutes without a call is resting; no record is unknown)

    @Test(arguments: [
        (ConnectionState.active, 0.0, "사용 중", StateDisplay.Kind.inUse),
        (.active, 2.0, "사용 중", .inUse),
        (.active, 1799.0, "사용 중", .inUse),
        (.active, 1800.0, "사용 중", .inUse),
        (.active, 1801.0, "쉼 30분", .resting),
        (.idle, 2520.0, "쉼 42분", .resting),
        (.idle, 3600.0, "쉼 1시간", .resting),
        (.idle, 3900.0, "쉼 1시간 5분", .resting),
        (.idle, 90_000.0, "쉼 1일 1시간", .resting),
        (.idle, 86_400.0, "쉼 1일", .resting),
        (.ended, 10.0, "끝남", .ended),
        (.ended, 99_999.0, "끝남", .ended),
    ])
    func connectionStateText(state: ConnectionState, idle: Double, text: String, kind: StateDisplay.Kind) {
        let display = StateDisplay.make(state: state, idleSeconds: idle)
        #expect(display.text == text)
        #expect(display.kind == kind)
    }

    @Test func noCallRecordMeansUnknown() {
        #expect(StateDisplay.make(state: .active, idleSeconds: nil) == StateDisplay(kind: .unknown, text: "알 수 없음"))
        #expect(StateDisplay.make(state: .unknown("x"), idleSeconds: nil) == StateDisplay(kind: .unknown, text: "알 수 없음"))
        #expect(StateDisplay.make(state: .ended, idleSeconds: nil) == StateDisplay(kind: .ended, text: "끝남"))
    }

    @Test func anIdleStateWithoutADurationIsStillResting() {
        #expect(StateDisplay.make(state: .idle, idleSeconds: nil) == StateDisplay(kind: .resting, text: "쉼"))
    }

    // MARK: Folder

    @Test(arguments: [
        ("/Users/chenjing/dev/x", "dev/x"),
        ("/Users/chenjing/dev/x/", "dev/x"),
        ("/Users/chenjing/dev//x", "dev/x"),
        ("/Users/chenjing", "Users/chenjing"),
        ("/x", "x"),
        ("/", "/"),
        ("relative/a/b", "a/b"),
        ("", "—"),
    ])
    func folderKeepsTheLastTwoComponents(path: String, expected: String) {
        #expect(Format.folder(path) == expected)
    }

    @Test func unknownFolderIsADash() {
        #expect(Format.folder(nil) == "—")
    }

    // MARK: Memory

    @Test(arguments: [
        (Int64(73_400_320), "70 MB"),
        (Int64(335_544_320), "320 MB"),
        (Int64(1_610_612_736), "1.5 GB"),
        (Int64(1_073_741_824), "1.0 GB"),
        (Int64(1_048_576), "1 MB"),
        (Int64(500_000), "1 MB 미만"),
        (Int64(0), "1 MB 미만"),
    ])
    func memoryIsShownInMegabytesUntilItReachesAGigabyte(bytes: Int64, expected: String) {
        #expect(Format.memory(bytes) == expected)
    }

    @Test func unknownMemoryIsADash() {
        #expect(Format.memory(nil) == "—")
    }

    // MARK: Times

    @Test func startTimeIsTheClockTimeToday() {
        let now = Fixtures.now // 2026-10-18 12:00 UTC
        let started = Date(timeIntervalSince1970: 1_792_316_340) // 2026-10-18 09:39:00 UTC
        #expect(Format.startTime(started, now: now, calendar: Fixtures.utc) == "09:39 시작")
    }

    @Test func startTimeCarriesTheDateWhenItIsNotToday() {
        let now = Fixtures.now
        let started = Date(timeIntervalSince1970: 1_792_253_460) // 2026-10-17 16:11:00 UTC
        #expect(Format.startTime(started, now: now, calendar: Fixtures.utc) == "10/17 16:11 시작")
    }

    @Test func unknownStartTime() {
        #expect(Format.startTime(nil, now: Fixtures.now, calendar: Fixtures.utc) == "시작 시각 알 수 없음")
    }

    @Test func clockTimeWithSeconds() {
        #expect(Format.clock(Fixtures.now, calendar: Fixtures.utc) == "12:00:00")
        #expect(Format.clock(nil, calendar: Fixtures.utc) == "—")
    }

    @Test(arguments: [
        (0.0, "방금"), (2.0, "방금"), (3.0, "3초 전"), (59.0, "59초 전"), (60.0, "1분 전"),
        (3599.0, "59분 전"), (3600.0, "1시간 전"), (86_399.0, "23시간 전"), (86_400.0, "1일 전"), (-5.0, "방금"),
    ])
    func relativeTime(secondsAgo: Double, expected: String) {
        let now = Fixtures.now
        #expect(Format.ago(now.addingTimeInterval(-secondsAgo), now: now) == expected)
    }

    @Test func unknownRelativeTime() {
        #expect(Format.ago(nil, now: Fixtures.now) == "—")
    }

    @Test(arguments: [
        (0, "0ms"), (87, "87ms"), (999, "999ms"), (1000, "1.0초"), (1234, "1.2초"), (9949, "9.9초"),
        (12_345, "12초"), (59_999, "59초"), (65_000, "1분 5초"), (120_000, "2분"),
    ])
    func durations(ms: Int, expected: String) {
        #expect(Format.milliseconds(ms) == expected)
    }

    @Test func unknownDuration() {
        #expect(Format.milliseconds(nil) == "—")
    }

    @Test(arguments: [("timeout", "시간 초과"), ("screen_locked", "화면 잠김"), ("error", nil), ("new word", nil)] as [(String, String?)])
    func whyACallFailed(word: String, expected: String?) {
        #expect(Format.failure(word) == expected)
    }

    @Test func whyACallFailedIsNothingWithoutAWord() {
        #expect(Format.failure(nil) == nil)
    }

    // MARK: Agent names

    @Test func agentLabels() {
        #expect(AgentKind.claude.label == "Claude")
        #expect(AgentKind.codex.label == "Codex")
        #expect(AgentKind.other("cmux-cua").label == "cmux-cua")
        #expect(AgentKind.other("").label == "AI")
        #expect(AgentKind(raw: "CLAUDE") == .claude)
        #expect(AgentKind(raw: nil) == .other(""))
    }
}
