import AppKit

/// The menu bar icon for each state. Three different shapes, so the state is readable without
/// color: a circle with a check (ready), circling arrows (working), a filled warning triangle
/// (problem). Ready and working are template images, so the menu bar draws them in the right tint
/// for light, dark and highlighted states. The menu bar ignores a button's tint, so the problem icon
/// is the same shape painted orange instead.
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
        return state == .problem ? painted(image, .systemOrange) : image
    }

    private static func painted(_ shape: NSImage, _ color: NSColor) -> NSImage {
        let image = NSImage(size: shape.size, flipped: false) { rect in
            shape.draw(in: rect)
            color.set()
            rect.fill(using: .sourceAtop)
            return true
        }
        image.isTemplate = false
        image.accessibilityDescription = shape.accessibilityDescription
        return image
    }
}
