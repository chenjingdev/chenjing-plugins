// cuabar-overlay: the soft glow around the screen edges that shows a person that the AI is working the Mac through
// cuabar (0.9.1). The engine (overlay.py) starts it and talks to it; CUA Bar and the cuabar plugin run the same binary
// from the engine copy.
//
//   cuabar-overlay <socket path>
//
// One runs per user. It listens on the socket, and each engine bridge connects and writes lines:
//   on     a CUA call runs
//   off    the bridge's calls ended: the glow stays LINGER seconds, so short calls in a row do not blink
//   clear  the turn ended: off at once
// The glow shows while any connection is on. A connection that closes (its bridge ended or died) counts as off. With
// no connection for IDLE seconds it exits, so it never outlives the engines. A second one finds the socket answering
// and exits at once.
//
// The windows let every click through, sit above everything on every Space and over full-screen apps, and are left
// out of screen captures (sharingType .none), so the AI's screenshots and accessibility trees never see them.
// CUABAR_OVERLAY_CAPTURE=1 lets captures see them, only to check the look.
import AppKit
import Darwin
import QuartzCore

let LINGER = 1.2
let IDLE = 5.0
let FADE = 0.35
let BREATH = 2.4
let EDGE: CGFloat = 3
let SPREAD: CGFloat = 22

func accentColor() -> NSColor {
    // The accent the ChatGPT app gives Codex Computer Use (~/.codex/computer-use/config.json), so both look alike.
    let path = NSString(string: "~/.codex/computer-use/config.json").expandingTildeInPath
    if let data = FileManager.default.contents(atPath: path), data.count < 65536,
       let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let hex = object["accentColor"] as? String, hex.count == 7, hex.hasPrefix("#"),
       let value = UInt32(hex.dropFirst(), radix: 16) {
        return NSColor(srgbRed: CGFloat((value >> 16) & 0xff)/255, green: CGFloat((value >> 8) & 0xff)/255,
                       blue: CGFloat(value & 0xff)/255, alpha: 1)
    }
    return NSColor(srgbRed: 0x33/255.0, green: 0x9c/255.0, blue: 1, alpha: 1)
}

final class GlowView: NSView {
    let glow = CAShapeLayer()

    init(frame: NSRect, color: NSColor) {
        super.init(frame: frame)
        wantsLayer = true
        layer = CALayer()
        layer!.opacity = 0
        glow.fillRule = .evenOdd
        glow.fillColor = color.cgColor
        glow.shadowColor = color.cgColor
        glow.shadowRadius = SPREAD
        glow.shadowOpacity = 1
        glow.shadowOffset = .zero
        layer!.addSublayer(glow)
        layout()
    }

    required init?(coder: NSCoder) { nil }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        glow.frame = bounds
        // A thin band on the edge; its shadow is the soft light that spreads inwards.
        let path = CGMutablePath()
        path.addRect(bounds.insetBy(dx: -SPREAD, dy: -SPREAD))
        path.addRoundedRect(in: bounds.insetBy(dx: EDGE, dy: EDGE), cornerWidth: 10, cornerHeight: 10)
        glow.path = path
        glow.shadowPath = path
        CATransaction.commit()
    }

    func breathe() {
        guard glow.animation(forKey: "breath") == nil else { return }
        let breath = CABasicAnimation(keyPath: "opacity")
        breath.fromValue = 0.45
        breath.toValue = 1.0
        breath.duration = BREATH/2
        breath.autoreverses = true
        breath.repeatCount = .infinity
        breath.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        glow.add(breath, forKey: "breath")
    }

    func fade(to opacity: Float, done: (() -> Void)? = nil) {
        CATransaction.begin()
        CATransaction.setAnimationDuration(FADE)
        CATransaction.setCompletionBlock(done)
        layer!.opacity = opacity
        CATransaction.commit()
    }
}

final class Glow {
    var panels: [(NSPanel, GlowView)] = []
    var shown = false

    init() {
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                               object: nil, queue: .main) { [weak self] _ in self?.rebuild() }
        rebuild()
    }

    func rebuild() {
        for (panel, _) in panels { panel.orderOut(nil) }
        let color = accentColor()
        let capture = ProcessInfo.processInfo.environment["CUABAR_OVERLAY_CAPTURE"] == "1"
        panels = NSScreen.screens.map { screen in
            let panel = NSPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
                                backing: .buffered, defer: false)
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = false
            panel.ignoresMouseEvents = true
            panel.level = .screenSaver
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            panel.sharingType = capture ? .readOnly : .none
            panel.isReleasedWhenClosed = false
            panel.setFrame(screen.frame, display: false)
            let view = GlowView(frame: NSRect(origin: .zero, size: screen.frame.size), color: color)
            panel.contentView = view
            return (panel, view)
        }
        if shown {
            for (panel, view) in panels {
                panel.orderFrontRegardless()
                view.breathe()
                view.fade(to: 1)
            }
        }
    }

    func show(_ on: Bool) {
        guard on != shown else { return }
        shown = on
        for (panel, view) in panels {
            if on {
                panel.orderFrontRegardless()
                view.breathe()
                view.fade(to: 1)
            } else {
                view.fade(to: 0) { [weak self] in
                    if self?.shown == false {
                        view.glow.removeAnimation(forKey: "breath")
                        panel.orderOut(nil)
                    }
                }
            }
        }
    }
}

final class Server {
    let glow = Glow()
    var clients: [Int32: (source: DispatchSourceRead, buffer: Data, on: Bool)] = [:]
    var lingerUntil: Date?
    var lastClient = Date()
    var listener: DispatchSourceRead?
    var path = ""
    var inode: ino_t = 0

    func listen(at path: String) -> Bool {
        if answers(path) { return false }
        unlink(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0, var address = unixAddress(path) else { return false }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        var info = stat()
        guard bound == 0, chmod(path, 0o600) == 0, Darwin.listen(fd, 16) == 0, lstat(path, &info) == 0 else {
            close(fd)
            return false
        }
        self.path = path
        inode = info.st_ino
        _ = fcntl(fd, F_SETFL, O_NONBLOCK)
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
        source.setEventHandler { [weak self] in self?.accept(fd) }
        source.resume()
        listener = source
        return true
    }

    func accept(_ fd: Int32) {
        while true {
            let client = Darwin.accept(fd, nil, nil)
            guard client >= 0 else { return }
            var uid: uid_t = 0, gid: gid_t = 0
            guard getpeereid(client, &uid, &gid) == 0, uid == getuid() else {
                close(client)
                continue
            }
            _ = fcntl(client, F_SETFL, O_NONBLOCK)
            let source = DispatchSource.makeReadSource(fileDescriptor: client, queue: .main)
            source.setEventHandler { [weak self] in self?.read(client) }
            source.resume()
            clients[client] = (source, Data(), false)
            lastClient = Date()
        }
    }

    func read(_ client: Int32) {
        var chunk = [UInt8](repeating: 0, count: 1024)
        let count = Darwin.read(client, &chunk, chunk.count)
        if count == 0 || (count < 0 && errno != EAGAIN && errno != EINTR) {
            drop(client)
            return
        }
        guard count > 0, var entry = clients[client] else { return }
        entry.buffer.append(contentsOf: chunk[0..<count])
        while let end = entry.buffer.firstIndex(of: 0x0a) {
            let line = String(decoding: entry.buffer[entry.buffer.startIndex..<end], as: UTF8.self)
            entry.buffer.removeSubrange(entry.buffer.startIndex...end)
            switch line.trimmingCharacters(in: .whitespaces) {
            case "on": entry.on = true
            case "off":
                if entry.on { lingerUntil = Date().addingTimeInterval(LINGER) }
                entry.on = false
            case "clear": entry.on = false
            default: break
            }
            clients[client] = entry
            if line == "clear" && !clients.values.contains(where: { $0.on }) { lingerUntil = nil }
        }
        if entry.buffer.count > 4096 { drop(client) } else { clients[client] = entry }
        update()
    }

    func drop(_ client: Int32) {
        if let entry = clients.removeValue(forKey: client) {
            entry.source.cancel()
            close(client)
        }
        lastClient = Date()
        update()
    }

    func update() {
        let lingering = lingerUntil.map { $0 > Date() } ?? false
        glow.show(clients.values.contains(where: { $0.on }) || lingering)
    }

    func tick() {
        update()
        if clients.isEmpty && Date().timeIntervalSince(lastClient) > IDLE {
            // The socket goes with it, unless a newer one already took the path.
            var info = stat()
            if lstat(path, &info) == 0 && info.st_ino == inode { unlink(path) }
            exit(0)
        }
    }
}

func unixAddress(_ path: String) -> sockaddr_un? {
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return nil }
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
        raw.copyBytes(from: bytes)
        raw[bytes.count] = 0
    }
    return address
}

func answers(_ path: String) -> Bool {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0, var address = unixAddress(path) else { return false }
    defer { close(fd) }
    return withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    } == 0
}

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write("usage: cuabar-overlay <socket path>\n".data(using: .utf8)!)
    exit(2)
}
signal(SIGPIPE, SIG_IGN)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let server = Server()
guard server.listen(at: CommandLine.arguments[1]) else { exit(0) }
let timer = Timer(timeInterval: 0.2, repeats: true) { _ in server.tick() }
RunLoop.main.add(timer, forMode: .common)
app.run()
