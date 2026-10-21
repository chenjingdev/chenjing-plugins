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
    ///
    /// `status` is what the read that just ended answered (nil: it failed). Once the engine can be read, its word
    /// about Codex is the one that counts, so a Codex the engine does not accept does not start a run at every
    /// read; the app's own look at the disk is for when the engine cannot answer.
    func runWhatWasPutOff(status: EngineStatus? = nil) async {
        let waiting = activity.waitingFor
        guard isBundled, !waiting.isEmpty, !activity.isRunning else { return }
        let codexArrived = waiting.contains(.codex) && (status?.codex.installed ?? codexInstalled())
        let claudeCodeArrived = waiting.contains(.claudeCode) && claudeCodeFound()
        let statusArrived = waiting.contains(.status) && status != nil
        guard codexArrived || claudeCodeArrived || statusArrived, activity.beginCatchUp() else { return }
        defer { activity.endCatchUp() }
        await perform(.runSetup)
    }
}
