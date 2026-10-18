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

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.accessory)
        let live = LiveApp.make(quit: { NSApplication.shared.terminate(nil) })
        self.live = live
        controller = StatusItemController(model: live.model, maintenance: live.maintenance)
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
