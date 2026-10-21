import Foundation

extension StatusEvaluator {
    /// `codex-cua` is there but cannot answer `status`: it is an old command (one from before the app
    /// carried the engine does not know `status`) or a broken one. The app's install replaces it, so this
    /// is a setup problem, which also lets the card say so while setup runs and after it fails.
    static let staleCommandProblem = Problem(
        kind: .setupIncomplete, title: "연결 명령이 옛 판이거나 깨졌어요", nextStep: "고치기를 누르면 연결을 다시 설정해요",
        warning: nil, fix: .runSetup, fixLabel: "고치기")

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

/// Puts setup's own state over a status card that shows the setup problem: while an install runs
/// the card says so instead of showing a problem, and after a failure it offers 다시 하기. Any other
/// card is left as it is.
enum SetupOverlay {
    static func apply(to summary: StatusSummary, setup: SetupActivity.Phase, flowRunning: Bool) -> StatusSummary {
        guard summary.problem?.kind == .setupIncomplete else { return summary }
        if setup == .running || flowRunning { return StatusEvaluator.settingUp }
        if setup == .failed { return StatusEvaluator.setupFailed }
        return summary
    }

    /// The actions that run the install. (The developer tools' button only opens the system's installer, or,
    /// once the tools are there, runs 고치기 itself.)
    static func runsSetup(_ action: CUAAction) -> Bool {
        action == .runSetup
    }
}
