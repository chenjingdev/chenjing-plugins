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

    var kind: Kind
    var message: String
}

enum ActionMessages {
    /// Plain text for the engine's `reason` (contract: "Reasons the app must handle").
    static func reason(_ raw: String?) -> String {
        switch raw {
        case "request_in_flight": "도구 호출이 아직 끝나지 않았어요"
        case "not_found": "대상을 찾지 못했어요"
        case "no_trusted_scope": "놓을 점유가 없어요"
        case "cleanup_not_confirmed": "정리가 확인되지 않았어요"
        case "relay_unavailable": "중계기를 쓸 수 없어요"
        case "unsupported": "하나만 골라 풀 방법이 없어요. 확장 초기화 안내를 보세요"
        case "quit_cancelled": "Codex가 종료되지 않았어요 (종료를 취소했을 수 있어요)"
        case "not_running": "켜져 있지 않아요"
        case "relaunch_failed": "다시 열지 못했어요"
        case "timeout": "시간이 너무 오래 걸렸어요"
        default: "확인되지 않음"
        }
    }

    static func releaseConnection(_ result: ReleaseResult) -> ActionOutcome {
        if result.ok, result.released { return ActionOutcome(kind: .success, message: "놓아줬어요") }
        if result.ok, result.reason == "no_trusted_scope" { return ActionOutcome(kind: .info, message: reason(result.reason)) }
        return ActionOutcome(kind: .failure, message: "놓지 못했어요 — \(reason(result.reason))")
    }

    static func releaseEnded(_ result: ReleaseEndedResult) -> ActionOutcome {
        let total = result.results.count
        guard total > 0 else { return ActionOutcome(kind: .info, message: "끝난 연결이 없어요") }
        let released = result.results.filter(\.released).count
        if released == total { return ActionOutcome(kind: .success, message: "끝난 연결 \(total)개를 놓아줬어요") }
        let why = reason(result.results.first { !$0.released }?.reason)
        if released == 0 { return ActionOutcome(kind: .failure, message: "끝난 연결 \(total)개를 놓지 못했어요 — \(why)") }
        return ActionOutcome(kind: .warning, message: "끝난 연결 \(total)개 중 \(released)개를 놓아줬어요 — \(why)")
    }

    static func releaseSession(_ result: ReleaseResult) -> ActionOutcome {
        if result.ok, result.released { return ActionOutcome(kind: .success, message: "점유를 풀었어요") }
        return ActionOutcome(kind: .failure, message: "풀지 못했어요 — \(reason(result.reason))")
    }

    static func stopConnection(_ result: StopResult, force: Bool) -> ActionOutcome {
        let how = force ? "강제로 껐" : "껐"
        guard result.ok, result.stopped else {
            return ActionOutcome(kind: .failure, message: "끄지 못했어요 — \(reason(result.reason))")
        }
        // Stopped but the tabs were not confirmed released: they show up under 브라우저 점유 (F4).
        if !result.released {
            return ActionOutcome(kind: .warning, message: "\(how)지만 점유를 놓았는지는 확인되지 않았어요 — 브라우저 점유 탭을 보세요")
        }
        return ActionOutcome(kind: .success, message: "\(how)어요")
    }

    static func stopGroup(_ result: GroupStopResult, group: StopGroup, force: Bool) -> ActionOutcome {
        let label = group == .all ? "연결" : "\(group == .claude ? "Claude" : "Codex") 연결"
        let how = force ? "강제로 껐" : "껐"
        switch (result.stopped, result.failed) {
        case (0, 0): return ActionOutcome(kind: .info, message: "끌 연결이 없어요")
        case (let stopped, 0): return ActionOutcome(kind: .success, message: "\(label) \(stopped)개를 \(how)어요")
        case (0, let failed): return ActionOutcome(kind: .failure, message: "\(label) \(failed)개를 모두 끄지 못했어요")
        case (let stopped, let failed): return ActionOutcome(kind: .warning, message: "\(label) \(stopped)개를 \(how)고 \(failed)개는 못 껐어요")
        }
    }

    /// The status card's 놓아주기 for leftover leases: one `release-session` per lease it could aim at.
    static func releaseLeftovers(attempted: Int, released: Int, firstReason: String?) -> ActionOutcome {
        if released == attempted { return ActionOutcome(kind: .success, message: "점유 \(attempted)개를 풀었어요") }
        let why = reason(firstReason)
        if released == 0 { return ActionOutcome(kind: .failure, message: "점유 \(attempted)개를 풀지 못했어요 — \(why)") }
        return ActionOutcome(kind: .warning, message: "점유 \(attempted)개 중 \(released)개를 풀었어요 — \(why)")
    }

    static func restartCodex(_ result: RestartResult) -> ActionOutcome {
        if result.ok { return ActionOutcome(kind: .success, message: "Codex를 다시 켰어요") }
        return ActionOutcome(kind: .failure, message: "Codex를 다시 켜지 못했어요 — \(reason(result.reason))")
    }

    /// The engine could not be asked at all.
    static func failure(of what: String, error: EngineError) -> ActionOutcome {
        ActionOutcome(kind: .failure, message: "\(what) — \(error.message)")
    }
}
