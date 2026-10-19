import AppKit

/// The version this app was built as (the plugin's version, written into Info.plist by
/// scripts/build-app.sh). nil when run unbundled, e.g. `swift run`; then no version check happens.
enum AppVersion {
    static var current: String? {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    }
}

@MainActor
final class CUABarAppDelegate: NSObject, NSApplicationDelegate {
    private var live: LiveApp?
    private var controller: StatusItemController?
    private var verifyPanel: VerifyPanelController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.accessory)
        let live = LiveApp.make(quit: { NSApplication.shared.terminate(nil) })
        self.live = live
        // The popover and the verify panel show one model: it counts as open while either is.
        controller = StatusItemController(
            model: live.model, maintenance: live.maintenance,
            otherViewIsOpen: { [weak self] in self?.verifyPanel?.isShown ?? false })
        let verifyPanel = VerifyPanelController(model: live.model, maintenance: live.maintenance) { [weak self] open in
            if open { live.maintenance.loginItem.refresh() }
            live.model.setPopoverOpen(open || (self?.controller?.isPopoverShown ?? false))
        }
        verifyPanel.listenForSignal()
        self.verifyPanel = verifyPanel
        live.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        live?.stop()
        controller?.remove()
    }
}

@main
enum CUABarMain {
    @MainActor static func main() {
        // A second copy leaves before it shows anything and without waking the first (R1).
        if SingleInstance.anotherCopyIsRunning() { exit(0) }
        let application = NSApplication.shared
        let delegate = CUABarAppDelegate()
        application.delegate = delegate
        application.run()
    }
}
