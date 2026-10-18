import Foundation

/// The groups the engine can stop at once (`codex-cua stop --group <raw value>`).
enum StopGroup: String, CaseIterable, Hashable, Sendable {
    case all, claude, codex
}

/// Everything a button in the popover can ask for. The view model runs these; confirmations,
/// notifications and automatic cleanup (next task) wrap `CUABarViewModel.perform(_:)`.
enum CUAAction: Hashable, Sendable {
    // Engine actions (contract: "Actions").
    case releaseConnection(String)
    case releaseEnded
    case releaseSession(String)
    case stopConnection(String, force: Bool)
    case stopGroup(StopGroup, force: Bool)
    case restartCodex
    case copyDiagnosis

    // Fix buttons that are more than one engine call, or not an engine call at all.
    case runSetup
    /// `release-session` for every leftover lease that has a session to aim at.
    case releaseLeftover
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
        case .releaseConnection(let id), .stopConnection(let id, _): id
        default: nil
        }
    }

    /// Actions that touch several connections or Codex itself; every row waits for them.
    var isWide: Bool {
        switch self {
        case .releaseEnded, .stopGroup, .restartCodex, .releaseLeftover, .runSetup: true
        default: false
        }
    }
}
