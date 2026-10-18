import Foundation

/// What the app is doing about the plugin's setup right now, shared by everything that can run
/// it (the status card's fix button, the automatic run at start-up, and the last step of an
/// install or an update). Two runs never overlap, and the card reads this to say "연결을 설정하는 중"
/// instead of showing a problem while one is going, and to remember that one failed.
@MainActor
final class SetupActivity {
    enum Phase: Equatable, Sendable {
        case idle
        /// A setup process is running.
        case running
        /// The last run failed; the status card offers 다시 하기 until the problem is gone.
        case failed
    }

    private(set) var phase: Phase = .idle {
        didSet { if oldValue != phase { onChange?() } }
    }

    /// The automatic run at start-up happens at most once per app run, whatever came of it.
    private(set) var automaticRunClaimed = false

    /// Called when `phase` changes, so the view model can say it on the card.
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

    /// Runs `operation` in the slot: a second caller gets "이미 하는 중이에요" instead of a second run,
    /// and a failure comes back as one fixed line, never as what the command printed.
    func run(_ operation: () async throws -> Void) async -> ActionOutcome {
        guard begin() else { return ActionOutcome(kind: .info, message: SetupMessages.busy) }
        do {
            try await operation()
            end(succeeded: true)
            return ActionOutcome(kind: .success, message: SetupMessages.done)
        } catch {
            end(succeeded: false)
            return ActionOutcome(kind: .failure, message: SetupMessages.failed)
        }
    }
}

/// The fixed lines setup says. None of them carries text a command printed.
enum SetupMessages {
    static let busy = "이미 하는 중이에요"
    static let done = "연결 설정을 마쳤어요"
    static let failed = "연결 설정에 실패했어요"
    /// The status card while a setup process runs.
    static let running = "연결을 설정하는 중"
}
