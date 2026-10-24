import Foundation

/// What a finished action tells the person, in one line.
struct ActionOutcome: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case success
        /// Nothing to do, nothing wrong.
        case info
        /// Partly done, or done without a confirmation.
        case warning
        case failure
    }

    /// A button that goes with the message (열기 after a failed relaunch).
    struct FollowUp: Equatable, Sendable {
        var title: String
        var action: CUAAction
    }

    var kind: Kind
    var message: String
    var followUp: FollowUp?
}

/// What one 정리 came to: a connection stopped (the engine released its tabs first), only its tabs
/// released because the app may not stop it, or nothing.
struct TidyStep: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case cleaned
        /// The engine will not let the app stop this one: its tabs were released and that is all.
        case tabsOnly
        case failed
    }

    var kind: Kind
    /// The normal stop ran out of time, so the connection was stopped by force.
    var forced = false
    /// It was cleaned, but something is left to say: the tabs may still be held.
    var caution: String?
    /// The engine's reason word behind a failure.
    var reason: String?

    var isDone: Bool { kind != .failed }

    static func failed(_ reason: String?) -> TidyStep { TidyStep(kind: .failed, reason: reason) }

    /// `stop --connection`. `releasesTabs` is false for cmux-cua, which has no tabs to release: its
    /// `released: false` with no reason is a plain stop, never "the release is unknown".
    init(stop result: StopResult, forced: Bool, releasesTabs: Bool) {
        if result.stopped {
            self.init(kind: .cleaned, forced: forced, caution: Self.caution(after: result, releasesTabs: releasesTabs))
        } else {
            self.init(kind: .failed, forced: forced, reason: result.reason)
        }
    }

    /// `release --connection` alone. Nothing to release is not a failure: the tabs are free either way (P4).
    init(release result: ReleaseResult) {
        if result.ok, result.released || result.reason == "no_trusted_scope" {
            self.init(kind: .tabsOnly)
        } else {
            self.init(kind: .failed, reason: result.reason)
        }
    }

    /// `release-session` without `--user`: a leftover lease of a Claude conversation.
    init(session result: SessionReleaseResult) {
        if result.ok, result.released {
            self.init(kind: .cleaned)
        } else {
            self.init(kind: .failed, reason: result.reason)
        }
    }

    init(kind: Kind, forced: Bool = false, caution: String? = nil, reason: String? = nil) {
        self.kind = kind
        self.forced = forced
        self.caution = caution
        self.reason = reason
    }

    /// A stopped connection whose tabs may still be held. A tab that stays shows up as a lease line
    /// on the next read (R15).
    private static func caution(after result: StopResult, releasesTabs: Bool) -> String? {
        guard releasesTabs else { return result.ok ? nil : "마무리는 확인되지 않았어요" }
        if result.released { return result.ok ? nil : "마무리는 확인되지 않았어요" }
        // Nothing to release is not "not released" (P4).
        if result.reason == "no_trusted_scope" { return nil }
        if result.reason == "request_in_flight" {
            return "도구 호출이 끝나지 않아 탭은 못 풀었어요. 연결이 끝날 때 한 번 더 풀고, 남으면 목록에 점유로 보여요"
        }
        return "탭을 풀었는지는 확인되지 않았어요. 남았으면 목록에 점유로 보여요"
    }
}

/// Plain Korean for what the engine answered. Nothing here shows text the command printed: the
/// only words that reach the person are these.
enum ActionMessages {
    static let unknownReason = "확인되지 않음"

    /// One line per reason of the contract (and its later additions); anything else is unknown.
    static func reason(_ raw: String?) -> String {
        switch raw {
        case "request_in_flight": "도구 호출이 아직 끝나지 않았어요"
        case "not_found": "대상을 찾지 못했어요"
        case "no_trusted_scope": "풀 점유가 없어요"
        case "cleanup_not_confirmed": "정리가 확인되지 않았어요"
        case "relay_unavailable": "중계기를 쓸 수 없어요"
        case "unsupported": "하나만 골라 풀 방법이 없어요. 목록 맨 아래 안내를 보세요"
        case "quit_cancelled": "Codex가 종료를 취소했어요"
        case "quit_pending": "Codex가 아직 꺼지는 중이에요"
        case "not_running": "Codex가 켜져 있지 않아요"
        case "relaunch_failed": "Codex를 다시 열지 못했어요"
        case "timeout": "시간이 너무 오래 걸렸어요"
        case "needs_user": "Codex 대화의 점유는 직접 눌러야 풀 수 있어요"
        case "session_live": "살아 있는 연결이 아직 이 세션을 쓰고 있어요"
        case "unattributed": "주인을 몰라 건드리지 않았어요"
        case "protected": "앱이 건드리지 않는 프로세스예요"
        case "unverified": "프로세스가 바뀌었거나 확인되지 않아 건드리지 않았어요"
        case "permission_denied": "종료할 권한이 없어요"
        default: unknownReason
        }
    }

    /// The reason behind a failure. `no_trusted_scope` there is P4's "nobody to ask at all" (`ok: false`), never "nothing
    /// to release", which is not a failure: it is said as 탭 풀기 says it.
    static func failureReason(_ raw: String?) -> String {
        raw == "no_trusted_scope" ? noWayToRelease : reason(raw)
    }

    /// The reasons behind several failures in one phrase: each distinct reason once, at most two.
    static func why(_ reasons: [String?]) -> String {
        var distinct: [String] = []
        for raw in reasons {
            let text = failureReason(raw)
            if !distinct.contains(text) { distinct.append(text) }
        }
        switch distinct.count {
        case 0: return unknownReason
        case 1: return distinct[0]
        case 2: return distinct[0] + ", " + distinct[1]
        default: return distinct[0] + ", " + distinct[1] + " 외"
        }
    }

    // MARK: 탭 풀기

    /// `no_trusted_scope` is "nothing to release", not a failure. `ok` tells the two answers apart
    /// (P4): a verified writer that holds nothing (`ok: true`), or nobody to ask at all (`ok: false`).
    static func releaseConnection(_ result: ReleaseResult) -> ActionOutcome {
        if result.ok, result.released { return ActionOutcome(kind: .success, message: "탭을 풀었어요") }
        if result.reason == "no_trusted_scope" {
            return result.ok
                ? ActionOutcome(kind: .success, message: reason(result.reason))
                : ActionOutcome(kind: .warning, message: noWayToRelease)
        }
        return ActionOutcome(kind: .failure, message: "탭을 풀지 못했어요 — \(reason(result.reason))")
    }

    /// `release --connection` found nobody to ask: the runtime may still hold tabs.
    static let noWayToRelease = "탭을 풀 길을 확인하지 못했어요"

    /// `release-session`: the engine counts the tabs it just released; that is a result, not a
    /// guess at what is left.
    static func releaseSession(_ result: SessionReleaseResult) -> ActionOutcome {
        if result.ok, result.released {
            return ActionOutcome(kind: .success, message: result.tabCount.map { "탭 \($0)개를 풀었어요" } ?? "탭을 풀었어요")
        }
        return ActionOutcome(kind: .failure, message: "탭을 풀지 못했어요 — \(reason(result.reason))")
    }

    // MARK: 정리

    /// Nothing for 모두 정리 to do.
    static let nothingToTidy = "정리할 것이 없어요"
    /// A 정리 pressed on a connection the app can neither stop nor release.
    static let cannotTidy = "앱이 정리할 수 없는 연결이에요"

    /// One 정리. A failure reads as the other failures do: what failed, then why.
    static func tidy(_ step: TidyStep) -> ActionOutcome {
        switch step.kind {
        case .failed:
            return ActionOutcome(kind: .failure, message: "정리하지 못했어요 — \(failureReason(step.reason))")
        case .tabsOnly:
            return ActionOutcome(kind: .success, message: "탭만 풀었어요 — 이 연결은 앱이 끌 수 없어요")
        case .cleaned:
            var message = "정리했어요"
            if step.forced { message += " — 제때 안 꺼져서 강제로 껐어요" }
            guard let caution = step.caution else { return ActionOutcome(kind: .success, message: message) }
            return ActionOutcome(kind: .warning, message: message + (step.forced ? ". " : " — ") + caution)
        }
    }

    /// 모두 정리: how many went and, if some did not, why. The numbers count what the app tried
    /// (connections and sessions), never leases (R14).
    static func tidyAll(_ steps: [TidyStep]) -> ActionOutcome {
        guard !steps.isEmpty else { return ActionOutcome(kind: .info, message: nothingToTidy) }
        let done = steps.filter(\.isDone).count
        let failed = steps.filter { !$0.isDone }
        guard !failed.isEmpty else { return ActionOutcome(kind: .success, message: "\(done)개 정리했어요") }
        let why = why(failed.map(\.reason))
        if done == 0 {
            return ActionOutcome(
                kind: .failure,
                message: failed.count == 1 ? "정리하지 못했어요 — \(why)" : "\(failed.count)개를 정리하지 못했어요 — \(why)")
        }
        return ActionOutcome(kind: .warning, message: "\(done)개 정리, \(failed.count)개는 못 했어요 — \(why)")
    }

    // MARK: Restart

    /// `quit_cancelled` ends there (nothing else happens); `quit_pending` is a quit Codex took and is
    /// still finishing: the app opens it again once it is gone. `relaunch_failed` offers the one click
    /// that opens Codex (R1: only on the person's click).
    static func restartCodex(_ result: RestartResult) -> ActionOutcome {
        if result.ok { return ActionOutcome(kind: .success, message: restarted) }
        switch result.reason {
        case "quit_cancelled":
            return ActionOutcome(kind: .info, message: reason(result.reason))
        case "quit_pending":
            return ActionOutcome(kind: .info, message: "Codex가 아직 꺼지는 중이에요 — 꺼지면 다시 켤게요")
        case "relaunch_failed":
            // The quit worked; only opening it again did not.
            return relaunchFailed
        default:
            return ActionOutcome(kind: .failure, message: "Codex를 다시 켜지 못했어요 — \(reason(result.reason))")
        }
    }

    static let restarted = "Codex를 다시 켰어요"

    static let relaunchFailed = ActionOutcome(
        kind: .failure, message: "Codex를 껐지만 다시 열지 못했어요", followUp: .init(title: "Codex 열기", action: .openCodex))

    // MARK: The command itself

    /// The engine could not be asked at all: the lead-in and one fixed line, never what it printed.
    static func failure(of what: String, error: EngineError) -> ActionOutcome {
        ActionOutcome(kind: .failure, message: "\(what) — \(error.message)")
    }
}
