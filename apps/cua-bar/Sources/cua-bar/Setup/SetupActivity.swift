import Foundation

/// What the install waits for before it can do its work: the Codex app, Claude Code (where the MCP server and
/// the skill go), and an answer from the engine. The app looks again after a status read and installs once
/// what it waited for has come.
enum SetupWait: Hashable, Sendable {
    case codex
    case claudeCode
    /// The engine could not be asked (its status ran out of time): the engine step waits for the first read
    /// that works. The MCP server and the skill do not wait for it.
    case status
}

/// What the app is doing about its install right now, shared by everything that can run it (the status
/// card's fix button, the automatic run at start-up, and the run that follows what was put off). Two runs
/// never overlap, and the card reads this to say "연결을 설정하는 중" instead of showing a problem while one
/// is going, and to remember that one failed.
@MainActor
final class SetupActivity {
    enum Phase: Equatable, Sendable {
        case idle
        /// An install is running.
        case running
        /// The last run failed; the status card offers 다시 하기 until the problem is gone.
        case failed
    }

    private(set) var phase: Phase = .idle {
        didSet { if oldValue != phase { onChange?() } }
    }

    /// The automatic run at start-up happens at most once per app run, whatever came of it.
    private(set) var automaticRunClaimed = false

    /// What the last run put off for lack of it. Looked at after each status read.
    private(set) var waitingFor: Set<SetupWait> = []

    /// The Mac has no developer tools (`xcode-select -p` fails): the engine's launcher needs them, so the
    /// install does nothing until the person presses the card's button.
    private(set) var developerToolsNeeded = false {
        didSet { if oldValue != developerToolsNeeded { onChange?() } }
    }

    private var catchingUp = false

    /// Called when `phase` or `developerToolsNeeded` changes, so the view model can say it on the card.
    var onChange: (() -> Void)?

    var isRunning: Bool { phase == .running }

    /// Takes the one slot; false when a run is already going.
    func begin() -> Bool {
        guard phase != .running else { return false }
        phase = .running
        return true
    }

    func end(succeeded: Bool) {
        phase = succeeded ? .idle : .failed
    }

    /// A failure is only worth remembering while the card still shows a setup problem.
    func forgetFailure() {
        if phase == .failed { phase = .idle }
    }

    /// True the first time only.
    func claimAutomaticRun() -> Bool {
        guard !automaticRunClaimed else { return false }
        automaticRunClaimed = true
        return true
    }

    /// What a finished run found that it cannot go on without.
    func record(waitingFor waiting: Set<SetupWait>, developerToolsNeeded needed: Bool) {
        waitingFor = waiting
        developerToolsNeeded = needed
    }

    /// One run for what was put off at a time; false while one is already on its way.
    func beginCatchUp() -> Bool {
        guard !catchingUp else { return false }
        catchingUp = true
        return true
    }

    func endCatchUp() {
        catchingUp = false
    }
}

/// The fixed lines setup says. None of them carries text a command printed.
enum SetupMessages {
    static let failed = "연결 설정에 실패했어요"
    /// The status card while an install runs.
    static let running = "연결을 설정하는 중"
}
