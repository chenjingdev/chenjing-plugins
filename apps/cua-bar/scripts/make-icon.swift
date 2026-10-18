// Draws CUA Bar's app icon and writes it as an .icns file. build-app.sh runs it for every build,
// so the icon lives here as code instead of as a binary file:
//
//   swift scripts/make-icon.swift <output.icns>
//
// A blue rounded square on the macOS icon grid with a white pointer and its rays, the symbol of
// computer use. Without an icon the notification question and Login Items showed a blank one.
import AppKit

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("Usage: swift make-icon.swift <output.icns>\n".utf8))
    exit(2)
}
let output = URL(fileURLWithPath: CommandLine.arguments[1])

/// The symbol in white. It stays a vector, so every size is drawn sharp.
func whiteSymbol(pointSize: CGFloat) -> NSImage? {
    let configuration = NSImage.SymbolConfiguration(pointSize: pointSize, weight: .semibold)
        .applying(NSImage.SymbolConfiguration(paletteColors: [.white]))
    return NSImage(systemSymbolName: "cursorarrow.rays", accessibilityDescription: nil)?.withSymbolConfiguration(configuration)
}

/// The icon at 1024 pixels on the icon grid. The smaller sizes are scaled down from it: drawn small,
/// the symbol came out blurred.
func master() -> CGImage? {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
    else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
    let shape = NSBezierPath(roundedRect: tile, xRadius: 185, yRadius: 185)
    let top = NSColor(srgbRed: 0.24, green: 0.52, blue: 0.98, alpha: 1)
    let bottom = NSColor(srgbRed: 0.10, green: 0.20, blue: 0.56, alpha: 1)
    NSGradient(starting: top, ending: bottom)?.draw(in: shape, angle: -90)
    if let symbol = whiteSymbol(pointSize: 420) {
        let size = symbol.size
        symbol.draw(in: NSRect(x: tile.midX - size.width / 2, y: tile.midY - size.height / 2, width: size.width, height: size.height))
    }
    NSGraphicsContext.restoreGraphicsState()
    return bitmap.cgImage
}

/// `image` as a square PNG of `pixels` pixels.
func png(_ image: CGImage, pixels: Int) -> Data? {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB), let context = CGContext(
        data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0, space: space,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: pixels, height: pixels))
    return context.makeImage().flatMap { NSBitmapImageRep(cgImage: $0).representation(using: .png, properties: [:]) }
}

let files = FileManager.default
let iconset = files.temporaryDirectory.appendingPathComponent("CUABar-\(UUID().uuidString).iconset")
do {
    try files.createDirectory(at: iconset, withIntermediateDirectories: true)
    defer { try? files.removeItem(at: iconset) }
    let sizes: [(name: String, pixels: Int)] = [
        ("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128),
        ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024),
    ]
    guard let image = master() else {
        FileHandle.standardError.write(Data("Could not draw the icon.\n".utf8))
        exit(1)
    }
    for size in sizes {
        guard let data = png(image, pixels: size.pixels) else {
            FileHandle.standardError.write(Data("Could not scale the icon to \(size.name).\n".utf8))
            exit(1)
        }
        try data.write(to: iconset.appendingPathComponent("icon_\(size.name).png"))
    }
    let iconutil = Process()
    iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
    iconutil.arguments = ["-c", "icns", iconset.path, "-o", output.path]
    try iconutil.run()
    iconutil.waitUntilExit()
    exit(iconutil.terminationStatus)
} catch {
    FileHandle.standardError.write(Data("Could not write the icon: \(error)\n".utf8))
    exit(1)
}
