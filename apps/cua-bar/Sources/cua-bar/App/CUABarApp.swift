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
    private var model: CUABarViewModel?
    private var controller: StatusItemController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.accessory)
        let model = CUABarViewModel(engine: CodexCUAEngineClient(), appVersion: AppVersion.current)
        self.model = model
        controller = StatusItemController(model: model)
        model.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        model?.stop()
        controller?.remove()
    }
}

@main
enum CUABarMain {
    @MainActor static func main() {
        let application = NSApplication.shared
        let delegate = CUABarAppDelegate()
        application.delegate = delegate
        application.run()
    }
}
