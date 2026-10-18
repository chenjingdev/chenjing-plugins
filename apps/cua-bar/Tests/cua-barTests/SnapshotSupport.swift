import AppKit
import SwiftUI
import Testing
@testable import cua_bar

@MainActor
enum Snapshot {
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

    /// How dark the picture is on average, 0 (all white) to 1 (all black): a button that cannot be
    /// pressed is drawn at 40% opacity, so it scores far lower than the same button that can.
    static func meanDarkness(_ bitmap: NSBitmapImageRep) -> Double {
        guard let data = bitmap.bitmapData else { return 0 }
        let bytes = bitmap.bytesPerRow, height = bitmap.pixelsHigh, width = bitmap.pixelsWide
        var total = 0.0
        for y in 0..<height {
            for x in 0..<width {
                let pixel = data + y * bytes + x * 4
                total += 255 - (0.299 * Double(pixel[0]) + 0.587 * Double(pixel[1]) + 0.114 * Double(pixel[2]))
            }
        }
        return total / Double(height * width) / 255
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
