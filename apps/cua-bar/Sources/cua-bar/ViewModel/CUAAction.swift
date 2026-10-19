import Foundation

/// The groups the engine can stop at once (`codex-cua stop --group <raw value>`). The popover no
/// longer offers a group stop, but the engine client still speaks the command.
enum StopGroup: String, CaseIterable, Hashable, Sendable {
    case all, claude, codex
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
    case runSetup
    /// Codex 열기, after a restart whose relaunch failed. Opens the app the person just chose to open.
    case openCodex
    /// Open the page where Codex is downloaded.
    case openCodexDownload
    /// Install the Claude plugin (`cua@chenjing-plugins`) and set it up.
    case installPlugin
    /// Update the plugin when it is older than the app, or open the app's release page when it is newer.
    case matchPluginVersion
    /// Read the status again now.
    case refresh

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
