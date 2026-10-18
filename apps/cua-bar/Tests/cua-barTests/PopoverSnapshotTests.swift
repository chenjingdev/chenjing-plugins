import AppKit
import SwiftUI
import Testing
@testable import cua_bar

/// A fake menu bar strip above the popover, so one picture shows the icon, its tooltip and the
/// popover together. Only the tests draw this.
private struct SnapshotScene: View {
    @ObservedObject var model: CUABarViewModel

    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            HStack(spacing: 14) {
                Spacer()
                Text("Wi-Fi").font(.system(size: 12))
                Image(nsImage: MenuBarIcon.image(for: model.summary.icon))
                    .renderingMode(.template)
                    .foregroundStyle(model.summary.icon == .problem ? Color.orange : Color.primary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 5).fill(Color.primary.opacity(0.18)))
                Text("12:00").font(.system(size: 12))
            }
            .padding(.horizontal, 12)
            .frame(height: 28)
            .background(Color.primary.opacity(0.08))

            Text(model.summary.tooltip)
                .font(.system(size: 11))
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(RoundedRectangle(cornerRadius: 4).fill(Color(nsColor: .controlBackgroundColor)))
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color.primary.opacity(0.25)))
                .padding(.trailing, 14)

            PopoverView(model: model, quit: {})
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color(nsColor: .windowBackgroundColor)))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.primary.opacity(0.18)))
                .shadow(color: .black.opacity(0.25), radius: 10, y: 4)
                .padding(.trailing, 8)
                .padding(.bottom, 14)

            // The three icons side by side and enlarged, to judge by shape alone.
            HStack(spacing: 22) {
                ForEach(IconState.allCases, id: \.self) { state in
                    VStack(spacing: 3) {
                        Image(nsImage: MenuBarIcon.image(for: state)).renderingMode(.template).resizable().scaledToFit().frame(width: 30, height: 30)
                        Text(state.accessibilityDescription).font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.trailing, 20)
            .padding(.bottom, 10)
        }
        .frame(width: 500)
        .background(Color(nsColor: .underPageBackgroundColor))
    }
}

@MainActor
private enum Snapshot {
    static func bitmap<V: View>(of view: V, dark: Bool = false) -> NSBitmapImageRep? {
        _ = NSApplication.shared
        let host = NSHostingView(rootView: view)
        let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        host.appearance = appearance
        let size = host.fittingSize
        host.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = appearance
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        // Twice the pixels, so the PNG is as sharp as on a Retina screen.
        guard let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: Int(size.width) * 2, pixelsHigh: Int(size.height) * 2, bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        else { return nil }
        bitmap.size = size
        host.cacheDisplay(in: host.bounds, to: bitmap)
        return bitmap
    }

    static func write(_ bitmap: NSBitmapImageRep, named name: String, to directory: String) throws {
        let folder = URL(fileURLWithPath: directory, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try #require(bitmap.representation(using: .png, properties: [:])).write(to: folder.appendingPathComponent(name + ".png"))
    }

    /// Fraction of pixels that differ from the corner pixel: a blank render scores ~0.
    static func inkRatio(_ bitmap: NSBitmapImageRep) -> Double {
        guard let data = bitmap.bitmapData else { return 0 }
        let bytes = bitmap.bytesPerRow, height = bitmap.pixelsHigh, width = bitmap.pixelsWide
        let corner = Array(UnsafeBufferPointer(start: data, count: 4))
        var different = 0
        for y in stride(from: 0, to: height, by: 2) {
            for x in stride(from: 0, to: width, by: 2) {
                let pixel = data + y * bytes + x * 4
                if abs(Int(pixel[0]) - Int(corner[0])) + abs(Int(pixel[1]) - Int(corner[1])) + abs(Int(pixel[2]) - Int(corner[2])) > 24 { different += 1 }
            }
        }
        return Double(different) / Double((height / 2 + 1) * (width / 2 + 1))
    }
}

/// Draws the popover for three situations. With `CUABAR_SNAPSHOT_DIR` set the PNGs are written
/// there (A1-popover-ready.png, -working.png, -problem.png); `CUABAR_SNAPSHOT_EXTRA_DIR` adds
/// every tab, and `CUABAR_SNAPSHOT_APPEARANCE=dark` renders dark mode.
@MainActor
struct PopoverSnapshotTests {
    private var environment: [String: String] { ProcessInfo.processInfo.environment }
    private var dark: Bool { environment["CUABAR_SNAPSHOT_APPEARANCE"] == "dark" }

    private func loadedModel(_ fixture: String, tab: PopoverTab = .connections, banner: ActionOutcome? = nil) async throws -> CUABarViewModel {
        let engine = FakeEngineClient(status: try Fixtures.status(fixture))
        let model = CUABarViewModel(
            engine: engine, appVersion: "0.7.0", policy: RefreshPolicy(closed: .seconds(3600), open: .seconds(3600)),
            clock: { Fixtures.now }, calendar: Fixtures.utc, bannerDuration: .seconds(3600))
        await model.refresh()
        model.selectedTab = tab
        return model
    }

    @Test(arguments: [("ready", "status-ready"), ("working", "status-working"), ("problem", "status-problem")])
    func drawsThePopoverForEachState(name: String, fixture: String) async throws {
        let model = try await loadedModel(fixture)
        let bitmap = try #require(Snapshot.bitmap(of: SnapshotScene(model: model), dark: dark))
        // Rendering happens off screen: no window of this test process may ever have been shown.
        #expect(NSApplication.shared.windows.allSatisfy { !$0.isVisible })
        #expect(bitmap.pixelsWide >= 1000 && bitmap.pixelsHigh >= 960)
        #expect(Snapshot.inkRatio(bitmap) > 0.15, "the render looks blank")
        if let directory = environment["CUABAR_SNAPSHOT_DIR"] {
            try Snapshot.write(bitmap, named: "A1-popover-\(name)", to: directory)
        }
    }

    @Test func eachTabDrawsForTheProblemFixture() async throws {
        for tab in PopoverTab.allCases {
            let model = try await loadedModel("status-problem", tab: tab)
            let bitmap = try #require(Snapshot.bitmap(of: SnapshotScene(model: model), dark: dark))
            #expect(Snapshot.inkRatio(bitmap) > 0.15)
            if let directory = environment["CUABAR_SNAPSHOT_EXTRA_DIR"] {
                try Snapshot.write(bitmap, named: "tab-problem-\(tab.rawValue)", to: directory)
            }
        }
    }

    @Test func eachTabDrawsWhenEverythingIsEmpty() async throws {
        let engine = FakeEngineClient(status: EngineStatus())
        let model = CUABarViewModel(engine: engine, appVersion: "0.7.0", clock: { Fixtures.now }, calendar: Fixtures.utc)
        await model.refresh()
        for tab in PopoverTab.allCases {
            model.selectedTab = tab
            let bitmap = try #require(Snapshot.bitmap(of: SnapshotScene(model: model), dark: dark))
            #expect(Snapshot.inkRatio(bitmap) > 0.1)
            if let directory = environment["CUABAR_SNAPSHOT_EXTRA_DIR"] {
                try Snapshot.write(bitmap, named: "tab-empty-\(tab.rawValue)", to: directory)
            }
        }
    }

    /// The popover keeps one height per card: switching tabs or hitting an unreadable engine must
    /// not make it jump or grow (a modifier applied to two views once doubled the placeholder).
    @Test func theTabAreaKeepsItsHeightInEveryTabAndState() async throws {
        func height(_ model: CUABarViewModel) -> CGFloat {
            _ = NSApplication.shared
            return NSHostingView(rootView: PopoverView(model: model, quit: {})).fittingSize.height
        }
        let problem = try await loadedModel("status-problem")
        var heights: Set<CGFloat> = []
        for tab in PopoverTab.allCases {
            problem.selectedTab = tab
            heights.insert(height(problem))
        }
        #expect(heights.count == 1, "the height changes between tabs: \(heights)")

        let empty = FakeEngineClient(status: EngineStatus())
        let emptyModel = CUABarViewModel(engine: empty, appVersion: "0.7.0", clock: { Fixtures.now }, calendar: Fixtures.utc)
        let loadingHeight = height(emptyModel)
        await emptyModel.refresh()
        let readyEmptyHeight = height(emptyModel)
        empty.setStatusError(.timeout)
        let broken = CUABarViewModel(engine: empty, appVersion: "0.7.0", clock: { Fixtures.now }, calendar: Fixtures.utc)
        await broken.refresh()
        // Same list area, cards a little different: all within a few lines of each other, and short enough for a laptop.
        for value in [loadingHeight, readyEmptyHeight, height(broken), heights.first ?? 0] {
            #expect(value > 380 && value < 640, "unexpected popover height \(value)")
        }
        #expect(abs(loadingHeight - readyEmptyHeight) < 30)
    }

    /// The popover's window is sized from the SwiftUI view (`preferredContentSize`); a zero size
    /// there is how a popover ends up blank. Checked without any status item or visible window.
    @Test func theHostingControllerReportsThePopoverSize() async throws {
        _ = NSApplication.shared
        let model = try await loadedModel("status-problem")
        let host = NSHostingController(rootView: PopoverView(model: model, quit: {}))
        host.sizingOptions = [.preferredContentSize]
        let window = NSWindow(contentViewController: host)
        window.contentView?.layoutSubtreeIfNeeded()
        #expect(host.preferredContentSize.width == Theme.popoverWidth)
        #expect(host.preferredContentSize.height > 400)
        window.close()
    }

    @Test func theStatesLookDifferent() async throws {
        var ratios: [Double] = []
        for fixture in ["status-ready", "status-working", "status-problem"] {
            let model = try await loadedModel(fixture)
            ratios.append(Snapshot.inkRatio(try #require(Snapshot.bitmap(of: SnapshotScene(model: model), dark: dark))))
        }
        #expect(Set(ratios).count == 3)
    }

    @Test func theUnreadableAndLoadingStatesDraw() async throws {
        let engine = FakeEngineClient()
        let loading = CUABarViewModel(engine: engine, appVersion: "0.7.0", clock: { Fixtures.now }, calendar: Fixtures.utc)
        let loadingBitmap = try #require(Snapshot.bitmap(of: SnapshotScene(model: loading), dark: dark))
        engine.setStatusError(.timeout)
        let broken = CUABarViewModel(engine: engine, appVersion: "0.7.0", clock: { Fixtures.now }, calendar: Fixtures.utc)
        await broken.refresh()
        let brokenBitmap = try #require(Snapshot.bitmap(of: SnapshotScene(model: broken), dark: dark))
        if let directory = environment["CUABAR_SNAPSHOT_EXTRA_DIR"] {
            try Snapshot.write(loadingBitmap, named: "state-loading", to: directory)
            try Snapshot.write(brokenBitmap, named: "state-unreadable", to: directory)
        }
    }

    @Test func aBannerDraws() async throws {
        let model = try await loadedModel("status-problem")
        let engine = FakeEngineClient(status: try Fixtures.status("status-problem"))
        engine.configure { $0.releaseEnded = ReleaseEndedResult(ok: false, results: [
            EndedRelease(connectionID: "a", released: true), EndedRelease(connectionID: "b", released: false, reason: "request_in_flight")]) }
        let withBanner = CUABarViewModel(engine: engine, appVersion: "0.7.0", clock: { Fixtures.now }, calendar: Fixtures.utc, bannerDuration: .seconds(3600))
        await withBanner.perform(.releaseEnded)
        #expect(withBanner.banner != nil)
        let bitmap = try #require(Snapshot.bitmap(of: SnapshotScene(model: withBanner), dark: dark))
        if let directory = environment["CUABAR_SNAPSHOT_EXTRA_DIR"] {
            try Snapshot.write(bitmap, named: "state-banner", to: directory)
        }
        _ = model
    }
}
