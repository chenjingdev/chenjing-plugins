import Foundation

extension StatusEvaluator {
    /// The card while a setup process runs: not a problem, just something being done.
    static let settingUp = StatusSummary(
        icon: .working, stateLabel: "설정 중", headline: SetupMessages.running,
        nextStep: "없음 — 몇 분 걸릴 수 있어요", warning: nil, problem: nil,
        tooltip: "CUA 설정 중 · \(SetupMessages.running)", accessibilityLabel: "CUA 설정 중")

    /// The card after a setup failed in this run: still the setup problem, with its one fixed
    /// line and a 다시 하기 button.
    static let setupFailed: StatusSummary = {
        let problem = Problem(
            kind: .setupIncomplete, title: SetupMessages.failed, nextStep: "다시 하기를 누르면 한 번 더 설정해요",
            warning: nil, fix: .runSetup, fixLabel: "다시 하기")
        return StatusSummary(
            icon: .problem, stateLabel: "문제", headline: problem.title, nextStep: problem.nextStep, warning: nil,
            problem: problem, tooltip: "CUA 문제 · \(problem.title)", accessibilityLabel: "CUA 문제: \(problem.title)")
    }()
}

extension EngineError {
    /// The command ran but failed or printed something unreadable: what an old plugin that does
    /// not know `status` does. (A timeout or a command that cannot start says nothing about versions.)
    var mayComeFromAnOldCommand: Bool {
        switch self {
        case .commandFailed, .invalidOutput: true
        default: false
        }
    }
}

/// Puts setup's own state over a status card that shows the setup problem: while a setup runs
/// (or an install or update that ends in one) the card says so instead of showing a problem,
/// and after a failure it offers 다시 하기. Any other card is left as it is.
enum SetupOverlay {
    static func apply(to summary: StatusSummary, setup: SetupActivity.Phase, flowRunning: Bool) -> StatusSummary {
        guard summary.problem?.kind == .setupIncomplete else { return summary }
        if setup == .running || flowRunning { return StatusEvaluator.settingUp }
        if setup == .failed { return StatusEvaluator.setupFailed }
        return summary
    }

    /// The actions that run a setup at some point.
    static func runsSetup(_ action: CUAAction) -> Bool {
        action == .runSetup || action == .installPlugin || action == .matchPluginVersion
    }
}
