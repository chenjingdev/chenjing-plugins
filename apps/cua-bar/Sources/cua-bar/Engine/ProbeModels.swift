import Foundation

/// How the connection test ended: `doctor --probe --json` reads one `cua.getState()` on a thread of its own, against
/// a Codex host that is ready, and says what became of it in `probe.status`. The words are the engine's.
enum ProbeOutcome: Equatable, Sendable {
    /// The host answered the read.
    case checked
    /// It answered, but with an error (or could not be reached).
    case failed
    /// The host did not answer in time.
    case timeout
    /// Codex waits for the person's approval before it lets the test through.
    case approvalRequired
    /// The read worked, but the test thread could not be shown to be gone.
    case cleanupUnconfirmed
    /// The host is not ready: nothing was run, and nothing was started.
    case hostUnavailable
    /// The Python environment is not ready: nothing was run.
    case dependenciesMissing
    /// The app could not run the command or read what it printed.
    case couldNotRun
    /// A word this app does not know yet.
    case other(String)

    init(word: String) {
        switch word {
        case "checked": self = .checked
        case "failed": self = .failed
        case "timeout": self = .timeout
        case "approval_required": self = .approvalRequired
        case "cleanup_unconfirmed": self = .cleanupUnconfirmed
        case "host_unavailable": self = .hostUnavailable
        case "dependencies_missing": self = .dependenciesMissing
        default: self = .other(word)
        }
    }

    /// The word for the copied diagnosis: names and states only.
    var word: String {
        switch self {
        case .checked: "checked"
        case .failed: "failed"
        case .timeout: "timeout"
        case .approvalRequired: "approval_required"
        case .cleanupUnconfirmed: "cleanup_unconfirmed"
        case .hostUnavailable: "host_unavailable"
        case .dependenciesMissing: "dependencies_missing"
        case .couldNotRun: "could_not_run"
        case .other: "unknown"
        }
    }

    var isSuccess: Bool { self == .checked }

    /// A test that was run and did not pass. (A host that was not ready was not tested at all.)
    var isFailure: Bool {
        switch self {
        case .checked, .hostUnavailable: false
        default: true
        }
    }

    /// One short line for the check tab.
    var summary: String {
        switch self {
        case .checked: "연결 시험을 통과했어요"
        case .failed: "연결 시험이 실패했어요"
        case .timeout: "연결 시험이 시간 안에 끝나지 않았어요"
        case .approvalRequired: "Codex에서 승인이 필요해요"
        case .cleanupUnconfirmed: "시험은 됐지만 뒷정리를 확인하지 못했어요"
        case .hostUnavailable: "Codex가 준비되지 않아 시험하지 않았어요"
        case .dependenciesMissing: "파이썬 환경이 준비되지 않아 시험하지 않았어요"
        case .couldNotRun: "연결 시험을 실행하지 못했어요"
        case .other: "연결 시험이 알 수 없는 결과로 끝났어요"
        }
    }
}

/// The last connection test: what came of it and when. Kept in memory for the run; nothing of the host's
/// answer (tool names, replies) is kept, only how it ended.
struct ProbeRecord: Equatable, Sendable {
    var outcome: ProbeOutcome
    var at: Date
}

enum ProbeParsing {
    /// `probe.status` of what `doctor --probe --json` printed. The command exits 1 when the test did not pass but
    /// still prints the report, so the exit code does not decide; nil when there is no such word.
    static func outcome(in stdout: Data) -> ProbeOutcome? {
        guard
            let root = (try? JSONSerialization.jsonObject(with: stdout)) as? [String: Any],
            let probe = root["probe"] as? [String: Any],
            let word = probe["status"] as? String, !word.isEmpty
        else { return nil }
        return ProbeOutcome(word: word)
    }
}

/// What the test adds to the line an install says (or to a notification): nothing when it passed or was not run,
/// one sentence when it failed.
enum ProbeMessages {
    static let failedSentence = "연결 시험이 실패했어요 — 점검 탭을 보세요"

    /// `text` with the failure sentence after it when the test failed. A test that passed, or that was not run
    /// (nil), leaves the text as it is.
    static func attach(_ outcome: ProbeOutcome?, to text: String) -> String {
        guard let outcome, outcome.isFailure else { return text }
        return text.isEmpty ? failedSentence : text + ". " + failedSentence
    }

    /// The same for an install's answer: the sentence goes after its message; an answer with no message says only
    /// the failure, and is a warning.
    static func attach(_ outcome: ProbeOutcome?, to answer: ActionOutcome) -> ActionOutcome {
        guard let outcome, outcome.isFailure else { return answer }
        var changed = answer
        changed.message = attach(outcome, to: answer.message)
        if changed.kind == .success || changed.kind == .info { changed.kind = .warning }
        return changed
    }
}

extension AppNotification {
    /// The same notification with the failure sentence after its body when the test failed. For the one that says
    /// an update is done: the test ran before it, and it is told after.
    func appending(probe outcome: ProbeOutcome?) -> AppNotification {
        var changed = self
        changed.body = ProbeMessages.attach(outcome, to: body)
        return changed
    }
}
