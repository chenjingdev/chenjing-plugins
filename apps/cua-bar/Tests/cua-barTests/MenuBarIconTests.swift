import AppKit
import Testing
@testable import cua_bar

@MainActor
struct MenuBarIconTests {
    /// Which pixels the icon covers at menu bar size, ignoring color.
    private func coverage(_ image: NSImage, side: Int = 44) -> [Bool] {
        let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side, bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        image.draw(in: NSRect(x: 0, y: 0, width: side, height: side))
        NSGraphicsContext.restoreGraphicsState()
        let data = bitmap.bitmapData!
        return (0..<(side * side)).map { data[$0 * bitmap.samplesPerPixel + 3] > 96 }
    }

    @Test func everyStateHasAnImageThatDrawsSomething() {
        for state in IconState.allCases {
            let image = MenuBarIcon.image(for: state)
            #expect(image.size.width > 8 && image.size.height > 8)
            #expect(coverage(image).filter { $0 }.count > 30, "\(state) draws nothing")
        }
    }

    @Test func theImagesAreTemplatesSoTheMenuBarTintsThemForLightAndDark() {
        for state in IconState.allCases { #expect(MenuBarIcon.image(for: state).isTemplate) }
    }

    @Test func imagesCarryTheAccessibilityDescription() {
        for state in IconState.allCases {
            #expect(MenuBarIcon.image(for: state).accessibilityDescription == state.accessibilityDescription)
        }
        #expect(MenuBarIcon.image(for: .ready).accessibilityDescription == "CUA 준비됨")
        #expect(MenuBarIcon.image(for: .working).accessibilityDescription == "CUA 작업 중")
        #expect(MenuBarIcon.image(for: .problem).accessibilityDescription == "CUA 문제")
    }

    @Test func statesDifferByShapeNotOnlyByColor() {
        // Colorblind-safe by construction: with color thrown away (coverage only) the three
        // icons still differ in a large share of their pixels.
        let masks = IconState.allCases.map { (state: $0, mask: coverage(MenuBarIcon.image(for: $0))) }
        for (index, a) in masks.enumerated() {
            for b in masks[(index + 1)...] {
                let differing = zip(a.mask, b.mask).filter { $0 != $1 }.count
                let union = zip(a.mask, b.mask).filter { $0 || $1 }.count
                #expect(Double(differing) / Double(max(union, 1)) > 0.25, "\(a.state) and \(b.state) look too alike")
            }
        }
    }

    @Test func thePopoverCardUsesTheSameShapes() {
        #expect(Set(IconState.allCases.map { MenuBarIcon.symbolName(for: $0) }).count == 3)
    }
}
