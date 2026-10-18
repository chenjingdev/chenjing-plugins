import Foundation

/// The setup the app runs by itself at start-up (F1): the plugin is installed but
/// `~/.local/bin/codex-cua` is missing or not ours, so nothing works until `setup.sh setup` ran.
///
/// It is a start-up step, not a reaction: a status read never starts it, it runs at most once per
/// app run whatever came of it, and a later try is the person's click on the status card.
@MainActor
struct AutomaticSetup {
    var locate: @Sendable () -> CommandLocation
    var activity: SetupActivity
    /// Runs the fix like a click on the card would (`CUABarViewModel.perform`).
    var perform: @MainActor (CUAAction) async -> Void

    func runAtStartup() async {
        guard case .installedNotSetUp = locate() else { return }
        guard activity.claimAutomaticRun() else { return }
        await perform(.runSetup)
    }
}
