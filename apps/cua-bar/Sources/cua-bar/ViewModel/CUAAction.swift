import Foundation

/// The groups the engine can stop at once (`codex-cua stop --group <raw value>`).
enum StopGroup: String, CaseIterable, Hashable, Sendable {
    case all, claude, codex
}

/// Everything a button in the popover can ask for. `CUABarViewModel.send(_:)` asks first when the
/// action needs a confirmation, and `perform(_:)` runs it.
enum CUAAction: Hashable, Sendable {
    // Engine actions (contract: "Actions").
    case releaseConnection(String)
    case releaseEnded
    /// `user` is true for a button press; a Codex thread's session is released only then.
    case releaseSession(String, user: Bool)
    case stopConnection(String, force: Bool)
    case stopGroup(StopGroup, force: Bool)
    case restartCodex
    case copyDiagnosis

    // Fix buttons that are more than one engine call, or not an engine call at all.
    case runSetup
    /// The status card's 놓아주기 for leftover leases: `release-session` (without `--user`) for
    /// every Claude session the engine can aim at. Codex chat sessions are released only by a click
    /// on their own row.
    case releaseLeftover
    /// 끝난 연결 끄기: `stop --connection` for every ended connection the engine may stop. The fix
    /// when no ended connection has a control endpoint to release through.
    case stopEnded
    /// 다시 하기: release one connection again after the engine refused (R15). Never asks again.
    case retryRelease(String)
    /// 안내 보기: select the 브라우저 점유 tab and open its guidance.
    case showLeaseGuidance
    /// 점유 보기: select the 브라우저 점유 tab only (Codex chats are released from their own rows).
    case showLeases
    /// Codex 열기, after a restart whose relaunch failed. Opens the app the person just chose to open.
    case openCodex
    /// TODO(A3): open the page where Codex is downloaded.
    case openCodexDownload
    /// TODO(A3): install the Claude plugin (`cua@chenjing-plugins`).
    case installPlugin
    /// TODO(A3): install or update whichever side is older so app and plugin versions match.
    case matchPluginVersion
    /// Read the status again now.
    case refresh

    /// The connection the action is aimed at, so its row's buttons can wait for it.
    var connectionID: String? {
        switch self {
        case .releaseConnection(let id), .retryRelease(let id), .stopConnection(let id, _): id
        default: nil
        }
    }

    /// Actions that touch several connections or Codex itself; every row waits for them.
    var isWide: Bool {
        switch self {
        case .releaseEnded, .stopGroup, .stopEnded, .restartCodex, .releaseLeftover, .runSetup: true
        default: false
        }
    }
}
