import Foundation

/// A question the popover asks before it does something. The view model holds at most one.
struct PendingConfirmation: Equatable, Identifiable, Sendable {
    enum Kind: Equatable, Sendable {
        /// Asked because of what the action does: restarting Codex (F1), releasing the tabs of a
        /// connection that may still be working.
        case standard
        /// R15: the engine refused a release once; ask whether to try once more.
        case retryRelease
    }

    let id = UUID()
    var action: CUAAction
    var kind: Kind
}

/// What the confirmation says: a question with the count in it, what will happen, and the
/// consequence in a warning color.
struct ConfirmationPrompt: Equatable, Sendable {
    var title: String
    var detail: String?
    var warning: String?
    var confirmTitle: String
    var cancelTitle = "취소"
    var isDestructive: Bool
}

/// What a press comes to before anything runs.
enum PressGate: Equatable, Sendable {
    /// Ask this first; run only on yes.
    case ask(ConfirmationPrompt)
    /// The click is its own consent.
    case run
    /// Neither: an action that has to ask cannot ask now. It does not run; this line says why.
    case refuse(String)
}

/// Which actions ask first, and what they ask. Everything else is a click that is its own consent:
/// 정리 and 모두 정리 (no live AI is cut off), 탭 풀기 on an idle connection or a leftover lease.
enum Confirmations {
    static let restartWarning = "하던 Codex 작업이 끊겨요"
    static let activeReleaseWarning = "이 대화가 아직 일하는 중이면 하던 브라우저 작업이 끊겨요"
    /// An action that asks from the status (a count, the row's state) while there is no status.
    static let readStatusFirst = "상태를 읽은 뒤 다시 눌러 주세요"
    static let targetGone = "그 연결은 이제 목록에 없어요"

    /// Whether a press asks, runs, or does neither. An action whose question comes from the status
    /// never runs without that question: with no status, or with its target gone, it does not run
    /// at all. 정리 does not ask, but it is aimed at one line of the status and so needs it too.
    static func gate(for action: CUAAction, content: PopoverContent?) -> PressGate {
        switch action {
        case .restartCodex, .releaseConnection, .tidy, .tidyAll:
            guard content != nil else { return .refuse(readStatusFirst) }
        default:
            return .run
        }
        if let prompt = prompt(for: action, content: content) { return .ask(prompt) }
        switch action {
        case .releaseConnection(let id), .tidy(let id):
            guard targetExists(id, in: content) else { return .refuse(targetGone) }
            return .run // releasing the tabs of an idle connection, or tidying
        default:
            return .run
        }
    }

    /// Whether the connection a question is about is still in the content. Every "is its target
    /// still there" check goes through here.
    static func targetExists(_ id: String, in content: PopoverContent?) -> Bool {
        // A cmux-cua connection is a line of 손볼 것 only while nobody owns it (R17).
        if ToolClient.isCmuxConnection(id: id) { return content?.connections.orphanRow(withID: id) != nil }
        return content?.connections.row(withID: id) != nil
    }

    /// The question, or nil when the action asks none now (it needs none, or there is nothing for
    /// it to act on: see `gate` for which of the two).
    static func prompt(for action: CUAAction, content: PopoverContent?) -> ConfirmationPrompt? {
        switch action {
        case .restartCodex:
            return ConfirmationPrompt(
                title: "Codex를 다시 켤까요?", detail: "정상 종료한 뒤 다시 켜요. 강제로 끄지 않아요.",
                warning: restartWarning, confirmTitle: "다시 켜기", isDestructive: false)

        case .releaseConnection(let id):
            // Decided on the contract's state, not on how the row reads: an active connection whose
            // idle time is unknown reads 알 수 없음 and may still be working.
            guard let row = content?.connections.row(withID: id) else { return nil }
            switch row.contractState {
            case .idle, .ended: return nil
            case .active, .unknown:
                return ConfirmationPrompt(
                    title: "\(describe(row))의 탭을 풀까요?", detail: "이 연결이 잡고 있는 브라우저 탭만 풀어요. 연결은 그대로예요.",
                    warning: activeReleaseWarning, confirmTitle: "탭 풀기", isDestructive: false)
            }

        default:
            return nil
        }
    }

    /// R15: the engine refused the release because a tool call had not finished.
    static let retryPrompt = ConfirmationPrompt(
        title: "AI가 하던 조작이 아직 안 끝났어요. 한 번 더 풀어 볼까요?",
        detail: "한 번 더 안 되면 줄에서 탭 풀기를 다시 누를 수 있어요.", warning: nil,
        confirmTitle: "한 번 더 풀기", cancelTitle: "그만두기", isDestructive: false)

    /// `Claude · dev/x`, or just `Claude` when the folder is unknown.
    private static func describe(_ row: ConnectionRow) -> String {
        row.path == nil ? row.agent.label : "\(row.agent.label) · \(row.folder)"
    }
}
