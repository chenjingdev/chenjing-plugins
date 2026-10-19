import AppKit
import SwiftUI

/// For checking the screens while someone works at this Mac. Opening the menu bar popover makes it the key
/// window, so every check through it takes the person's focus. This is the popover's own view on the same
/// model, in a panel out of sight that never activates the app or becomes key. Its buttons are pressed
/// through accessibility, which needs neither the pointer nor the focus.
///
/// SIGUSR1 shows it and hides it again (`kill -USR1 <pid>`); nothing else opens it.
@MainActor
final class VerifyPanelController {
    static let title = "CUA Bar 검수 창"

    let panel: NSPanel
    private let host: NSHostingController<PopoverView>
    private let opened: @MainActor (Bool) -> Void
    private var sizeObservation: NSKeyValueObservation?
    private var signalSource: DispatchSourceSignal?

    /// `opened` hears when it is shown or hidden, as the popover's delegate does.
    init(model: CUABarViewModel, maintenance: Maintenance?, opened: @escaping @MainActor (Bool) -> Void) {
        host = NSHostingController(rootView: PopoverView(
            model: model, maintenance: maintenance, quit: { NSApplication.shared.terminate(nil) }))
        host.sizingOptions = [.preferredContentSize]
        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: Theme.popoverWidth, height: 600),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        self.opened = opened
        panel.title = Self.title
        panel.contentViewController = host
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        // Out of every list a person cycles through.
        panel.collectionBehavior = [.ignoresCycle, .fullScreenAuxiliary]
        sizeObservation = host.observe(\.preferredContentSize, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.fit() }
        }
    }

    var isShown: Bool { panel.isVisible }

    func listenForSignal() {
        signal(SIGUSR1, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        source.setEventHandler { [weak self] in
            Task { @MainActor in self?.toggle() }
        }
        source.resume()
        signalSource = source
    }

    func toggle() {
        if panel.isVisible {
            panel.orderOut(nil)
            opened(false)
        } else {
            fit()
            // Ordered in without activating the app or taking the key window: the person's app keeps both.
            panel.orderFrontRegardless()
            opened(true)
        }
    }

    /// The size the view asks for, to the right of every screen.
    private func fit() {
        var size = host.preferredContentSize
        if size.width < 1 || size.height < 1 { size = host.view.fittingSize }
        let screens = NSScreen.screens.map(\.frame).reduce(NSRect.null) { $0.union($1) }
        let origin = screens.isNull ? NSPoint(x: -10_000, y: 0) : NSPoint(x: screens.maxX + 400, y: screens.minY)
        panel.setFrame(NSRect(origin: origin, size: size), display: panel.isVisible)
    }
}
