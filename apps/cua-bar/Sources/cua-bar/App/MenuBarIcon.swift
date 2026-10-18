import AppKit

/// The menu bar icon for each state. Three different shapes, so the state is readable without
/// color: a circle with a check (ready), circling arrows (working), a filled warning triangle
/// (problem). They are template images, so the menu bar draws them in the right tint for light,
/// dark and highlighted states.
enum MenuBarIcon {
    static func symbolName(for state: IconState) -> String {
        switch state {
        case .ready: "checkmark.circle"
        case .working: "arrow.triangle.2.circlepath"
        case .problem: "exclamationmark.triangle.fill"
        }
    }

    static func image(for state: IconState) -> NSImage {
        let configuration = NSImage.SymbolConfiguration(pointSize: 15, weight: .medium)
        let base = NSImage(systemSymbolName: symbolName(for: state), accessibilityDescription: state.accessibilityDescription)
            ?? NSImage(size: NSSize(width: 16, height: 16))
        let image = base.withSymbolConfiguration(configuration) ?? base
        image.isTemplate = true
        image.accessibilityDescription = state.accessibilityDescription
        return image
    }
}
