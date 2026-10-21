import Foundation

/// The install the app runs by itself (F1, R1): the engine, then Claude Code's MCP server and skill.
///
/// It starts when the app starts, once per app run whatever came of it (a later try is the person's click
/// on the status card). The one other time is what the start put off because Codex or Claude Code was not
/// there yet: after a status read that finds it has come, the install runs once more. A status read itself
/// never installs anything.
@MainActor
struct AutomaticSetup {
    var activity: SetupActivity
    /// Runs the fix like a click on the card would (`CUABarViewModel.perform`).
    var perform: @MainActor (CUAAction) async -> Void
    /// This process runs from an app bundle that carries the engine. A development build installs nothing.
    var isBundled: Bool
    var codexInstalled: @Sendable () -> Bool
    var claudeCodeFound: @Sendable () -> Bool

    func runAtStartup() async {
        guard isBundled else { return }
        guard activity.claimAutomaticRun() else { return }
        await perform(.runSetup)
    }

    /// Cheap when nothing was put off, which is almost always: it only looks at `waitingFor`.
    func runWhatWasPutOff() async {
        let waiting = activity.waitingFor
        guard isBundled, !waiting.isEmpty, !activity.isRunning else { return }
        let arrived = (waiting.contains(.codex) && codexInstalled()) || (waiting.contains(.claudeCode) && claudeCodeFound())
        guard arrived, activity.beginCatchUp() else { return }
        defer { activity.endCatchUp() }
        await perform(.runSetup)
    }
}
