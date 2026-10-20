import AppKit
import Testing
@testable import cua_bar

/// The verify panel: the popover's view for checks while someone works at the Mac, without their focus.
@MainActor
struct VerifyPanelTests {
    private final class Heard { var opened: [Bool] = [] }

    @Test func itShowsOutOfSightNeverKeyAndHidesAgain() async throws {
        _ = NSApplication.shared
        let model = CUABarViewModel(
            engine: FakeEngineClient(status: try Fixtures.status("status-ready")), appVersion: "0.7.0",
            clock: { Fixtures.now }, calendar: Fixtures.utc, sleep: ManualSleeper().sleep)
        await model.refresh()
        let heard = Heard()
        let controller = VerifyPanelController(model: model, maintenance: nil) { heard.opened.append($0) }

        controller.toggle()
        #expect(controller.isShown)
        #expect(heard.opened == [true], "the model hears it opened, as with the popover")
        let panel = controller.panel
        #expect(panel.styleMask.contains(.nonactivatingPanel), "a press on it does not activate the app")
        #expect(!panel.isKeyWindow)
        #expect(!panel.canBecomeKey, "a borderless panel is never the key window")
        #expect(panel.title == "CUA Bar 검수 창")
        #expect(panel.frame.width == Theme.popoverWidth)
        #expect(panel.frame.height > 200, "as tall as the popover's view: \(panel.frame)")
        for screen in NSScreen.screens {
            #expect(!screen.frame.intersects(panel.frame), "out of sight: \(screen.frame) vs \(panel.frame)")
        }

        // A picture of it, since a window out of sight cannot be captured from outside.
        let picture = FileManager.default.temporaryDirectory.appendingPathComponent("verify-panel-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: picture) }
        #expect(controller.writePicture(to: picture))
        let image = try #require(NSBitmapImageRep(data: try Data(contentsOf: picture)))
        #expect(image.pixelsWide == Int(Theme.popoverWidth) * 2)
        #expect(Snapshot.meanDarkness(image) > 0.01, "something is drawn")

        controller.toggle()
        #expect(!controller.isShown)
        #expect(heard.opened == [true, false])
        #expect(!controller.writePicture(to: picture), "only the shown panel")
    }
}
