import AppKit
import Combine
import SwiftUI

/// The one menu bar item: shows the icon for the current state with a one-line tooltip, and
/// opens the popover when clicked. It only mirrors `CUABarViewModel.summary`; every decision
/// about what to show lives in the view model and the evaluator, where tests can reach it.
@MainActor
final class StatusItemController: NSObject, NSPopoverDelegate {
    private let model: CUABarViewModel
    private let maintenance: Maintenance?
    private let statusItem: NSStatusItem
    private let popover = NSPopover()
    private let host: NSHostingController<PopoverView>
    private var subscription: AnyCancellable?

    init(model: CUABarViewModel, maintenance: Maintenance? = nil) {
        self.model = model
        self.maintenance = maintenance
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        host = NSHostingController(rootView: PopoverView(model: model, maintenance: maintenance, quit: { NSApplication.shared.terminate(nil) }))
        super.init()

        statusItem.autosaveName = "dev.chenjing.cua-bar.status-item"
        if let button = statusItem.button {
            button.target = self
            button.action = #selector(togglePopover(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.imagePosition = .imageOnly
        }

        // The popover follows the SwiftUI view's own size as tabs and cards change.
        host.sizingOptions = [.preferredContentSize]
        popover.behavior = .transient
        popover.contentViewController = host
        popover.delegate = self

        subscription = model.$summary.removeDuplicates().sink { [weak self] summary in
            self?.apply(summary)
        }
        apply(model.summary)
    }

    func remove() {
        popover.close()
        NSStatusBar.system.removeStatusItem(statusItem)
    }

    private func apply(_ summary: StatusSummary) {
        guard let button = statusItem.button else { return }
        button.image = MenuBarIcon.image(for: summary.icon)
        button.toolTip = summary.tooltip
        button.setAccessibilityLabel(summary.accessibilityLabel)
        button.setAccessibilityHelp(summary.tooltip)
        // Dimmed until the first answer, so "ready" is never claimed before it is known. A
        // problem is also orange: color is an extra cue, the shape is what tells the states apart.
        button.appearsDisabled = summary.isPlaceholder
        button.contentTintColor = summary.icon == .problem ? .systemOrange : nil
    }

    @objc private func togglePopover(_ sender: AnyObject?) {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(sender)
        } else {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    // MARK: NSPopoverDelegate

    func popoverWillShow(_ notification: Notification) {
        maintenance?.loginItem.refresh()
        model.setPopoverOpen(true)
    }

    func popoverDidClose(_ notification: Notification) {
        model.setPopoverOpen(false)
    }
}
