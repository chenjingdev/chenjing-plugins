import Foundation

/// What a press comes to before anything runs.
enum PressGate: Equatable, Sendable {
    /// The click is its own consent.
    case run
    /// It does not run: what it answers or is aimed at is not on screen any more. This line says why.
    case refuse(String)
}

/// Nothing asks before it runs (the person's "이렇게 한번더 레이아웃 바꾸면서 재확인 받는게 맞는 방법인지 모르겠네",
/// "저런식으로 뜨는 ux가 하나가 아닐텐데"): a button says what it does, and what it cuts off is on screen before the
/// press. The card says it beside 다시 켜기; a working connection's 탭 풀기 and 앱 지우기 say it on hover, next to
/// the row's 사용 중. A press only runs against the status it was made from.
enum PressGates {
    /// An action that answers what the status says (a count, the row's state) while there is no status.
    static let readStatusFirst = "상태를 읽은 뒤 다시 눌러 주세요"
    static let targetGone = "그 연결은 이제 목록에 없어요"

    /// Whether a press runs. An action that answers the status does not run without one, and one aimed at a line of
    /// the list does not run once that line is gone.
    static func gate(for action: CUAAction, content: PopoverContent?) -> PressGate {
        switch action {
        case .restartCodex, .tidyAll:
            return content == nil ? .refuse(readStatusFirst) : .run
        case .releaseConnection(let id), .tidy(let id):
            guard content != nil else { return .refuse(readStatusFirst) }
            return targetExists(id, in: content) ? .run : .refuse(targetGone)
        default:
            return .run
        }
    }

    /// Whether the connection a press is about is still in the content. Every "is its target still there" check goes
    /// through here.
    static func targetExists(_ id: String, in content: PopoverContent?) -> Bool {
        // A cmux-cua connection is a line of 손볼 것 only while nobody owns it (R17).
        if ToolClient.isCmuxConnection(id: id) { return content?.connections.orphanRow(withID: id) != nil }
        return content?.connections.row(withID: id) != nil
    }
}
