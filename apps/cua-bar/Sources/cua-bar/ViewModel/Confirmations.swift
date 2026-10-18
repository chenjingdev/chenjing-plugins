import Foundation

/// A question the popover asks before it does something. The view model holds at most one.
struct PendingConfirmation: Equatable, Identifiable, Sendable {
    enum Kind: Equatable, Sendable {
        /// Asked because of what the action does: stopping several or by force (R17), restarting
        /// Codex (F1), releasing a connection that may still be working.
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

/// Which actions ask first, and what they ask. Everything else is a click that is its own consent:
/// a single normal stop, releasing an idle or ended connection, 끝난 연결 놓아주기, 콕 집어 풀기.
enum Confirmations {
    static let forceWarning = "하던 작업이 끊겨요"
    static let forceDetail = "탭을 놓아준 뒤에도 안 꺼지면 강제로 끝내요."
    static let restartWarning = "하던 Codex 작업이 끊겨요"
    static let activeReleaseWarning = "이 대화가 아직 일하는 중이면 하던 브라우저 작업이 끊겨요"

    /// nil when the action needs no question (or there is nothing for it to act on).
    static func prompt(for action: CUAAction, content: PopoverContent?) -> ConfirmationPrompt? {
        switch action {
        case .restartCodex:
            return ConfirmationPrompt(
                title: "Codex를 다시 켤까요?", detail: "정상 종료한 뒤 다시 켜요. 강제로 끄지 않아요.",
                warning: restartWarning, confirmTitle: "다시 켜기", isDestructive: false)

        case .stopGroup(let group, let force):
            guard let counts = content?.connections.stopCounts, counts.count(for: group) > 0 else { return nil }
            let count = counts.count(for: group)
            let label = group == .all ? "연결" : "\(group == .claude ? "Claude" : "Codex") 연결"
            if force {
                return ConfirmationPrompt(
                    title: "\(label) \(count)개를 강제로 끌까요?", detail: forceDetail, warning: forceWarning,
                    confirmTitle: "강제 종료", isDestructive: true)
            }
            let detail: String
            switch group {
            case .all: detail = "Claude와 Codex 연결만 꺼요. cmux-cua 같은 다른 도구는 그대로 둬요. 끄기 전에 탭을 놓아줘요."
            case .claude: detail = "Claude 대화에 붙은 연결만 꺼요. 끄기 전에 탭을 놓아줘요."
            case .codex:
                detail = counts.unattributedCodex > 0
                    ? "세션을 아는 Codex 연결만 꺼요. 주인을 모르는 \(counts.unattributedCodex)개는 빠져요. 끄기 전에 탭을 놓아줘요."
                    : "Codex 연결만 꺼요. 끄기 전에 탭을 놓아줘요."
            }
            let confirmTitle = group == .all ? "전체 끄기" : "\(group == .claude ? "Claude" : "Codex")만 끄기"
            return ConfirmationPrompt(
                title: "\(label) \(count)개를 끌까요?", detail: detail, warning: nil,
                confirmTitle: confirmTitle, isDestructive: false)

        case .stopConnection(let id, force: true):
            let who = row(id, in: content).map(describe) ?? "이 연결"
            return ConfirmationPrompt(
                title: "\(who) 연결 1개를 강제로 끌까요?", detail: forceDetail, warning: forceWarning,
                confirmTitle: "강제 종료", isDestructive: true)

        case .stopEnded:
            let count = content?.connections.endedStoppableCount ?? 0
            guard count > 0 else { return nil }
            return ConfirmationPrompt(
                title: "끝난 연결 \(count)개를 끌까요?",
                detail: "놓아줄 길이 없는 연결이라 하나씩 정상 종료해요. 끄기 전에 점유를 놓아 봐요.", warning: nil,
                confirmTitle: "끝난 연결 끄기", isDestructive: false)

        case .releaseConnection(let id):
            // Decided on the contract's state, not on how the row reads: an active connection whose
            // idle time is unknown reads 알 수 없음 and may still be working.
            guard let row = row(id, in: content) else { return nil }
            switch row.contractState {
            case .idle, .ended: return nil
            case .active, .unknown:
                return ConfirmationPrompt(
                    title: "\(describe(row))의 점유를 놓을까요?", detail: "이 연결이 잡고 있는 브라우저 탭을 놓아줘요.",
                    warning: activeReleaseWarning, confirmTitle: "놓아주기", isDestructive: false)
            }

        default:
            return nil
        }
    }

    /// R15: the engine refused the release because a tool call had not finished.
    static let retryPrompt = ConfirmationPrompt(
        title: "AI가 하던 조작이 아직 안 끝났어요. 한 번 더 놓아 볼까요?",
        detail: "한 번 더 안 되면 줄에서 다시 하기나 강제 종료를 고를 수 있어요.", warning: nil,
        confirmTitle: "한 번 더 놓기", cancelTitle: "그만두기", isDestructive: false)

    private static func row(_ id: String, in content: PopoverContent?) -> ConnectionRow? {
        content?.connections.groups.flatMap(\.rows).first { $0.id == id }
    }

    /// `Claude · dev/x`, or just `Claude` when the folder is unknown.
    private static func describe(_ row: ConnectionRow) -> String {
        row.path == nil ? row.agent.label : "\(row.agent.label) · \(row.folder)"
    }
}
