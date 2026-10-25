import AppKit
import SwiftUI

extension Color {
    /// A color that differs between light and dark appearance.
    static func adaptive(light: Color, dark: Color) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(dark) : NSColor(light)
        })
    }
}

/// Sizes and colors shared by the popover. Everything is a system color, so light and dark
/// appearance follow the Mac; no state is told by color alone (each also has its own shape or text).
enum Theme {
    static let popoverWidth: CGFloat = 420
    static let listHeight: CGFloat = 360
    static let padding: CGFloat = 14
    static let cardRadius: CGFloat = 10

    static func tint(for state: IconState) -> Color {
        switch state {
        case .ready: .green
        case .working: .blue
        case .problem: .orange
        }
    }

    // Small text on a tinted background needs more contrast than the tint itself has, so text uses
    // these deeper (light mode) or lighter (dark mode) variants.
    static let greenText = Color.adaptive(light: Color(red: 0.05, green: 0.44, blue: 0.17), dark: Color(red: 0.40, green: 0.86, blue: 0.52))
    static let blueText = Color.adaptive(light: Color(red: 0.0, green: 0.33, blue: 0.78), dark: Color(red: 0.50, green: 0.72, blue: 1.0))
    static let orangeText = Color.adaptive(light: Color(red: 0.60, green: 0.26, blue: 0.0), dark: Color(red: 1.0, green: 0.72, blue: 0.38))
    static let redText = Color.adaptive(light: Color(red: 0.72, green: 0.08, blue: 0.08), dark: Color(red: 1.0, green: 0.50, blue: 0.48))

    static func text(for state: IconState) -> Color {
        switch state {
        case .ready: greenText
        case .working: blueText
        case .problem: orangeText
        }
    }

    static func text(for kind: StateDisplay.Kind) -> Color {
        switch kind {
        case .inUse: greenText
        case .resting, .unknown: .secondary
        case .ended: redText
        }
    }

    /// Text of an action's result on its own row.
    static func text(for kind: ActionOutcome.Kind) -> Color {
        switch kind {
        case .success: greenText
        case .info: .secondary
        case .warning: orangeText
        case .failure: redText
        }
    }

    static func tint(for kind: ActionOutcome.Kind) -> Color {
        switch kind {
        case .success: .green
        case .info: .secondary
        case .warning: .orange
        case .failure: .red
        }
    }

    static func tint(for kind: StateDisplay.Kind) -> Color {
        switch kind {
        case .inUse: .green
        case .resting: .secondary
        case .ended: .red
        case .unknown: .secondary
        }
    }

    /// Fill of the fix button: a darker orange so white text on it stays readable (about 4.5:1).
    static let fixFill = Color(red: 0.76, green: 0.34, blue: 0.0)

    /// Fill of the card's button in the card's own color: a problem's fix is orange, and the 다시 켜기 a ready or
    /// working card offers is a darker green or blue (white text about 5:1).
    static func fixFill(for state: IconState) -> Color {
        switch state {
        case .ready: Color(red: 0.10, green: 0.50, blue: 0.22)
        case .working: Color(red: 0.0, green: 0.40, blue: 0.82)
        case .problem: fixFill
        }
    }

    static let rowFill = Color.primary.opacity(0.055)
    static let rowStroke = Color.primary.opacity(0.06)

    static let titleFont = Font.system(size: 13, weight: .semibold)
    static let bodyFont = Font.system(size: 12)
    static let captionFont = Font.system(size: 11)
}
