import Foundation

/// The groups the engine can stop at once (`codex-cua stop --group <raw value>`). The popover no
/// longer offers a group stop, but the engine client still speaks the command.
enum StopGroup: String, CaseIterable, Hashable, Sendable {
    case all, claude, codex
}

/// Where the answer to a button is told: next to that button, so the eyes need not leave it. A place that
/// is gone (the line left the list) has its answer in the banner under the status card instead.
enum ResultPlace: Hashable, Sendable {
    /// The line of a connection: 탭 풀기 or 정리 on it.
    case connection(String)
    /// The line of a leftover lease: 탭 풀기 on it.
    case session(String)
    /// Under the head of 손볼 것: 모두 정리.
    case tidyAll
    /// At the bottom of 기록, right above its buttons: 진단 복사.
    case diagnosis
    /// A line of 점검: 연결 시험 or the copy button of a command.
    case check(CheckItem)
}

/// Everything a button in the popover can ask for. A row has one button for its state: 탭 풀기 on a
/// connection whose AI is alive and on a leftover lease, 정리 on an ended connection or a cmux-cua
/// connection nobody owns any more. `CUABarViewModel.send(_:)` asks first when the action needs a
/// confirmation, and `perform(_:)` runs it.
enum CUAAction: Hashable, Sendable {
    // Engine actions (contract: "Actions").
    /// 탭 풀기 on a live connection: `release --connection`. Only the browser tabs it holds are
    /// released; the connection stays.
    case releaseConnection(String)
    /// 탭 풀기 again after the engine refused (R15). Never asks again.
    case retryRelease(String)
    /// 탭 풀기 on a leftover lease, by session id. `user` is true for a button press; a Codex
    /// thread's session is released only then.
    case releaseSession(String, user: Bool)
    /// 정리 of one ended connection, or of one cmux-cua connection nobody owns: release the tabs and
    /// stop what is left, by force when it does not stop in time. Asks nothing: no AI is cut off.
    case tidy(String)
    /// 모두 정리: every 정리 the list offers at once, with the leftover leases of Claude conversations.
    case tidyAll
    case restartCodex
    case copyDiagnosis

    // Fix buttons that are more than one engine call, or not an engine call at all.
    /// 고치기: the whole install again (engine, then Claude Code's MCP server and skill).
    case runSetup
    /// Codex 열기, after a restart whose relaunch failed. Opens the app the person just chose to open.
    case openCodex
    /// Open the page where Codex is downloaded.
    case openCodexDownload
    /// 설치 on the card that asks for the developer tools: opens the system's installer, or runs the whole
    /// install when the tools have come since.
    case installDeveloperTools
    /// Read the status again now.
    case refresh
    /// 연결 시험 on the 점검 tab: one `cua.getState()` against a Codex host that is ready, on a thread of its own.
    case runProbe
    /// 복사 on a command of the 점검 tab. The app hands the command over and never runs it.
    case copyCommand(String, on: CheckItem)

    /// Where its answer is told; nil for the actions that answer under the status card, whose buttons are there.
    var resultPlace: ResultPlace? {
        switch self {
        case .releaseConnection(let id), .retryRelease(let id), .tidy(let id): .connection(id)
        case .releaseSession(let id, _): .session(id)
        case .tidyAll: .tidyAll
        case .copyDiagnosis: .diagnosis
        case .runProbe: .check(.host)
        case .copyCommand(_, let item): .check(item)
        default: nil
        }
    }

    /// The connection the action is aimed at, so its row's buttons can wait for it.
    var connectionID: String? {
        switch self {
        case .releaseConnection(let id), .retryRelease(let id), .tidy(let id): id
        default: nil
        }
    }

    /// Actions that touch several rows or Codex itself; a row the status does not list waits for them.
    var isWide: Bool {
        switch self {
        case .tidyAll, .restartCodex, .runSetup: true
        default: false
        }
    }

    /// Whether running it touches `connection`, so that row's button waits for it. 모두 정리 touches
    /// only the ended ones, and a restart or a setup touches every row.
    func touches(_ connection: Connection) -> Bool {
        switch self {
        case .releaseConnection(let id), .retryRelease(let id), .tidy(let id): id == connection.id
        case .tidyAll: connection.state == .ended
        case .restartCodex, .runSetup: true
        default: false
        }
    }
}
