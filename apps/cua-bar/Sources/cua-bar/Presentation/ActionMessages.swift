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

/// One connection's part in a stop: an entry of a group stop's `results`, or one `stop --connection`.
struct StopItem: Equatable, Sendable {
    var stopped: Bool
    var released: Bool
    var reason: String?
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
        case "no_trusted_scope": "놓을 점유가 없어요"
        case "cleanup_not_confirmed": "정리가 확인되지 않았어요"
        case "relay_unavailable": "중계기를 쓸 수 없어요"
        case "unsupported": "하나만 골라 풀 방법이 없어요. 브라우저 점유 탭의 안내를 보세요"
        case "quit_cancelled": "Codex가 종료를 취소했어요"
        case "not_running": "Codex가 켜져 있지 않아요"
        case "relaunch_failed": "Codex를 다시 열지 못했어요"
        case "timeout": "시간이 너무 오래 걸렸어요"
        case "needs_user": "Codex 대화의 점유는 직접 눌러야 풀 수 있어요"
        case "session_live": "살아 있는 연결이 아직 이 세션을 쓰고 있어요"
        case "unattributed": "주인을 몰라 끄지 않았어요"
        case "protected": "앱이 건드리지 않는 프로세스예요"
        case "unverified": "프로세스가 바뀌었거나 확인되지 않아 건드리지 않았어요"
        case "permission_denied": "종료할 권한이 없어요"
        default: unknownReason
        }
    }

    /// The reasons behind several failures in one phrase: each distinct reason once, at most two.
    static func why(_ reasons: [String?]) -> String {
        var distinct: [String] = []
        for raw in reasons {
            let text = reason(raw)
            if !distinct.contains(text) { distinct.append(text) }
        }
        switch distinct.count {
        case 0: return unknownReason
        case 1: return distinct[0]
        case 2: return distinct[0] + ", " + distinct[1]
        default: return distinct[0] + ", " + distinct[1] + " 외"
        }
    }

    // MARK: Release

    /// `no_trusted_scope` is "nothing to release", not a failure. `ok` tells the two answers apart
    /// (P4): a verified writer that holds nothing (`ok: true`), or nobody to ask at all (`ok: false`).
    static func releaseConnection(_ result: ReleaseResult) -> ActionOutcome {
        if result.ok, result.released { return ActionOutcome(kind: .success, message: "놓았어요") }
        if result.reason == "no_trusted_scope" {
            return result.ok
                ? ActionOutcome(kind: .success, message: reason(result.reason))
                : ActionOutcome(kind: .warning, message: noWayToRelease)
        }
        return ActionOutcome(kind: .failure, message: "놓지 못했어요 — \(reason(result.reason))")
    }

    /// `release --connection` found nobody to ask: the runtime may still hold tabs.
    static let noWayToRelease = "놓아줄 길을 확인하지 못했어요"
    /// An item the engine had nothing to release for (`no_trusted_scope`).
    static let nothingToRelease = "놓을 점유 없음"

    /// Reads `ok` and every item: an `ok: false` answer with nothing in it is a failure, never
    /// "no ended connections". An item with nothing to release is not a failure. The engine also
    /// lists a live bridge whose sessions from before Codex restarted it released, under that
    /// bridge's own id (P4): with `status` (the one the release started from) those are told apart
    /// from the ended connections.
    static func releaseEnded(_ result: ReleaseEndedResult, in status: EngineStatus? = nil) -> ActionOutcome {
        let items = result.results
        guard !items.isEmpty else {
            return result.ok
                ? ActionOutcome(kind: .info, message: "끝난 연결이 없어요")
                : ActionOutcome(kind: .failure, message: "놓지 못했어요 — \(reason(result.reason))")
        }
        let isBeforeRestart = { (item: EndedRelease) in status?.isLive(connectionID: item.connectionID) ?? false }
        let groups = [
            (label: "끝난 연결", tally: ReleaseTally(items.filter { !isBeforeRestart($0) })),
            (label: "다시 연결되기 전 세션", tally: ReleaseTally(items.filter(isBeforeRestart))),
        ].filter { $0.tally.count > 0 }
        var parts = groups.map { $0.tally.phrase($0.label) }
        let failed = groups.map { $0.tally.failed }.reduce(0, +)
        if failed == 0 {
            guard result.ok else {
                parts.append("마무리는 확인되지 않았어요")
                return ActionOutcome(kind: .warning, message: parts.joined(separator: " · "))
            }
            return ActionOutcome(kind: .success, message: parts.joined(separator: " · "))
        }
        return ActionOutcome(kind: failed == items.count ? .failure : .warning, message: parts.joined(separator: " · "))
    }

    /// How the items of one `release --ended` group came out.
    private struct ReleaseTally {
        var released = 0
        var nothing = 0
        var failedReasons: [String?] = []

        init(_ items: [EndedRelease]) {
            for item in items {
                if item.released {
                    released += 1
                } else if item.reason == "no_trusted_scope" {
                    nothing += 1
                } else {
                    failedReasons.append(item.reason)
                }
            }
        }

        var failed: Int { failedReasons.count }
        var count: Int { released + nothing + failed }

        /// `끝난 연결 2개를 놓았어요`; with nothing to release for some, it says how many; with
        /// failures, how many went and why the rest did not.
        func phrase(_ label: String) -> String {
            let done = released + nothing
            if done == 0 { return "\(label) \(count)개를 놓지 못했어요 — \(ActionMessages.why(failedReasons))" }
            if released == 0 && failed == 0 { return "\(label) \(count)개 — \(ActionMessages.nothingToRelease)" }
            let empty = nothing > 0 ? " (\(nothing)개는 \(ActionMessages.nothingToRelease))" : ""
            if failed == 0 { return "\(label) \(count)개를 놓았어요\(empty)" }
            return "\(label) \(count)개 중 \(done)개를 놓았어요\(empty) — 나머지는 \(ActionMessages.why(failedReasons))"
        }
    }

    /// `release-session`: the engine counts the tabs it just released; that is a result, not a
    /// guess at what is left.
    static func releaseSession(_ result: SessionReleaseResult) -> ActionOutcome {
        if result.ok, result.released {
            return ActionOutcome(kind: .success, message: result.tabCount.map { "탭 \($0)개를 놓았어요" } ?? "놓았어요")
        }
        return ActionOutcome(kind: .failure, message: "풀지 못했어요 — \(reason(result.reason))")
    }

    /// The status card's 놓아주기 for leftover leases: one `release-session` per Claude session.
    /// The numbers count those sessions, never leases: with an unreadable lease list the app does
    /// not know how many leases there are (R14).
    static func releaseLeftovers(_ results: [SessionReleaseResult]) -> ActionOutcome {
        guard !results.isEmpty else {
            return ActionOutcome(kind: .info, message: "Claude 대화의 점유 중 놓을 수 있는 것이 없어요")
        }
        let done = results.filter { $0.ok && $0.released }
        let tabText = done.contains { $0.tabCount != nil } ? " (탭 \(done.compactMap(\.tabCount).reduce(0, +))개)" : ""
        if done.count == results.count {
            return ActionOutcome(kind: .success, message: "남은 세션 \(results.count)개의 점유를 놓았어요\(tabText)")
        }
        let why = why(results.filter { !($0.ok && $0.released) }.map(\.reason))
        if done.isEmpty {
            return ActionOutcome(kind: .failure, message: "남은 세션 \(results.count)개의 점유를 놓지 못했어요 — \(why)")
        }
        return ActionOutcome(kind: .warning, message: "남은 세션 \(results.count)개 중 \(done.count)개의 점유를 놓았어요\(tabText) — 나머지는 \(why)")
    }

    // MARK: Stop

    /// A normal stop is not blocked by a refused release (R15): the stop is reported as it is, and
    /// the tabs the plugin could not release show up as 주인 없는 점유 on the next refresh.
    static func stopConnection(_ result: StopResult, force: Bool) -> ActionOutcome {
        let how = force ? "강제로 " : ""
        guard result.stopped else {
            return ActionOutcome(kind: .failure, message: "끄지 못했어요 — \(reason(result.reason))")
        }
        // Nothing to release is not a failure: stopping was all there was to do (P4).
        if !result.released, result.reason == "no_trusted_scope" {
            return ActionOutcome(kind: .success, message: "\(how)껐어요")
        }
        if result.released {
            return result.ok
                ? ActionOutcome(kind: .success, message: "\(how)껐어요")
                : ActionOutcome(kind: .warning, message: "\(how)껐어요. 마무리는 확인되지 않았어요")
        }
        if result.reason == "request_in_flight" {
            return ActionOutcome(
                kind: .warning,
                message: "\(how)껐어요. 도구 호출이 끝나지 않아 점유는 못 놓았어요 — 플러그인이 끝날 때 한 번 더 놓고, 남으면 브라우저 점유 탭에 보여요")
        }
        return ActionOutcome(kind: .warning, message: "\(how)껐지만 점유를 놓았는지는 확인되지 않았어요 — 브라우저 점유 탭을 보세요")
    }

    /// Reads `ok` and every item (`stopped`, `released`, `reason`), says how many failed and why,
    /// and lists the connections the engine skipped for not knowing their owner on their own.
    static func stopGroup(_ result: GroupStopResult, group: StopGroup, force: Bool) -> ActionOutcome {
        let label = group == .all ? "연결" : "\(group == .claude ? "Claude" : "Codex") 연결"
        return stopSummary(
            label: label, force: force,
            items: result.results.map { StopItem(stopped: $0.stopped, released: $0.released, reason: $0.reason) },
            fallback: (stopped: result.stopped, failed: result.failed), ok: result.ok, topReason: result.reason)
    }

    /// 끝난 연결 끄기: the answers of one `stop --connection` per ended connection.
    static func stopEnded(_ results: [StopResult]) -> ActionOutcome {
        stopSummary(
            label: "끝난 연결", force: false,
            items: results.map { StopItem(stopped: $0.stopped, released: $0.released, reason: $0.reason) },
            fallback: (stopped: 0, failed: 0), ok: results.allSatisfy(\.ok), topReason: results.first { !$0.ok }?.reason)
    }

    private static func stopSummary(
        label: String, force: Bool, items: [StopItem], fallback: (stopped: Int, failed: Int), ok: Bool, topReason: String?
    ) -> ActionOutcome {
        let stopped: Int
        let failedReasons: [String?]
        let unattributed: Int
        let notReleased: Int
        if items.isEmpty {
            // An engine that only sends counts: use them, with no reasons to give.
            stopped = fallback.stopped
            failedReasons = Array(repeating: nil, count: fallback.failed)
            unattributed = 0
            notReleased = 0
        } else {
            stopped = items.filter(\.stopped).count
            unattributed = items.filter { !$0.stopped && $0.reason == "unattributed" }.count
            failedReasons = items.filter { !$0.stopped && $0.reason != "unattributed" }.map(\.reason)
            // A stopped one that had nothing to release (`no_trusted_scope`) is not "not released".
            notReleased = items.filter { $0.stopped && !$0.released && $0.reason != "no_trusted_scope" }.count
        }
        let failed = failedReasons.count
        if stopped == 0, failed == 0, unattributed == 0 {
            return ok
                ? ActionOutcome(kind: .info, message: "끌 연결이 없어요")
                : ActionOutcome(kind: .failure, message: "끄지 못했어요 — \(reason(topReason))")
        }
        let how = force ? "강제로 " : ""
        var parts: [String] = []
        if stopped > 0 { parts.append("\(label) \(stopped)개를 \(how)껐어요") }
        if failed > 0 {
            let why = why(failedReasons)
            parts.append(stopped > 0 ? "\(failed)개는 못 껐어요 — \(why)" : "\(label) \(failed)개를 끄지 못했어요 — \(why)")
        }
        if unattributed > 0 {
            parts.append("주인을 몰라 끄지 않음 \(unattributed)개 — 하나씩 끄거나 전체로 끌 수 있어요")
        }
        if notReleased > 0 {
            parts.append("점유를 놓았는지 확인되지 않은 연결 \(notReleased)개 — 브라우저 점유 탭을 보세요")
        }
        let clean = failed == 0 && unattributed == 0 && notReleased == 0
        if clean && !ok { parts.append("마무리는 확인되지 않았어요") }
        let kind: ActionOutcome.Kind = stopped == 0 && failed > 0 ? .failure : (clean && ok ? .success : .warning)
        return ActionOutcome(kind: kind, message: parts.joined(separator: " · "))
    }

    // MARK: Restart

    /// `quit_cancelled` ends there (nothing else happens); `relaunch_failed` offers the one click
    /// that opens Codex (R1: only on the person's click).
    static func restartCodex(_ result: RestartResult) -> ActionOutcome {
        if result.ok { return ActionOutcome(kind: .success, message: "Codex를 다시 켰어요") }
        switch result.reason {
        case "quit_cancelled":
            return ActionOutcome(kind: .info, message: reason(result.reason))
        case "relaunch_failed":
            // The quit worked; only opening it again did not.
            return ActionOutcome(
                kind: .failure, message: "Codex를 껐지만 다시 열지 못했어요",
                followUp: .init(title: "Codex 열기", action: .openCodex))
        default:
            return ActionOutcome(kind: .failure, message: "Codex를 다시 켜지 못했어요 — \(reason(result.reason))")
        }
    }

    // MARK: The command itself

    /// The engine could not be asked at all: the lead-in and one fixed line, never what it printed.
    static func failure(of what: String, error: EngineError) -> ActionOutcome {
        ActionOutcome(kind: .failure, message: "\(what) — \(error.message)")
    }
}
