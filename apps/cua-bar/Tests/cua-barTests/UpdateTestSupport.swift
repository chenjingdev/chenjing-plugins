import CryptoKit
import Foundation
@testable import cua_bar

/// What the site's `/version` says, the way the site writes it (the `release` and `download` fields are there, and are
/// never used).
func versionDocument(
    _ version: String = "0.8.0", file: String? = nil, sha256: String = String(repeating: "ab", count: 32), size: Int = 1234
) -> String {
    let file = file ?? "CUABar-v\(version)-macos-arm64.dmg"
    return """
    {"version": "\(version)", "file": "\(file)", "sha256": "\(sha256)", "size": \(size),
     "release": "https://github.com/chenjingdev/chenjing-plugins/releases/tag/cua-bar--v\(version)",
     "download": "https://cua.chenjing.org/\(file)"}
    """
}

func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

/// A transport that answers from a script and counts how often it was asked. No network.
final class FakeTransport: UpdateTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var document: Result<Data, any Error>
    private var image: Data
    private var downloadError: (any Error)?
    private var versionRequests = 0
    private var downloaded: [UpdateOffer] = []
    /// While shut, a download waits here once it has been recorded.
    var downloadGate: AsyncGate?

    init(document: String = versionDocument(), image: Data = Data("pretend disk image".utf8)) {
        self.document = .success(Data(document.utf8))
        self.image = image
    }

    init(failing error: any Error) {
        document = .failure(error)
        image = Data()
    }

    var versionRequestCount: Int { lock.withLock { versionRequests } }
    var downloads: [UpdateOffer] { lock.withLock { downloaded } }

    func set(document text: String) { lock.withLock { document = .success(Data(text.utf8)) } }
    func setDocumentFailing() { lock.withLock { document = .failure(UpdateTransportError.badResponse) } }
    func set(image data: Data) { lock.withLock { image = data } }
    func setDownloadFailing(_ error: any Error = UpdateTransportError.badResponse) { lock.withLock { downloadError = error } }

    func fetchVersionDocument() async throws -> Data {
        try lock.withLock {
            versionRequests += 1
            return try document.get()
        }
    }

    func download(_ offer: UpdateOffer, to destination: URL) async throws {
        let (data, failure) = lock.withLock { () -> (Data, (any Error)?) in
            downloaded.append(offer)
            return (image, downloadError)
        }
        await downloadGate?.wait()
        if let failure { throw failure }
        try data.write(to: destination)
    }
}

/// An installer that answers from a list (the last answer repeats) and remembers what it was asked to install.
final class FakeInstaller: UpdateInstalling, @unchecked Sendable {
    private let lock = NSLock()
    private var answers: [UpdateInstallResult]
    private var recorded: [UpdateOffer] = []
    private var moments: [Bool] = []
    private var tidied = 0
    /// Runs when the app asks to tidy up what an earlier run left.
    var onClearLeftovers: (@Sendable () -> Void)?
    /// While shut, an install waits here once it has been recorded.
    var gate: AsyncGate?
    /// Asks the caller whether the moment is right, as the real installer does right before it replaces the app, and
    /// defers when it is not.
    var asksTheMoment = false

    init(_ answers: UpdateInstallResult...) { self.answers = answers.isEmpty ? [.replaced] : answers }

    var offers: [UpdateOffer] { lock.withLock { recorded } }
    /// What the caller answered each time it was asked.
    var momentsAsked: [Bool] { lock.withLock { moments } }
    /// How often the app asked to tidy up.
    var leftoversCleared: Int { lock.withLock { tidied } }

    func clearLeftovers() async {
        lock.withLock { tidied += 1 }
        onClearLeftovers?()
    }

    func install(_ offer: UpdateOffer, canCommit: @escaping @MainActor @Sendable () -> Bool) async -> UpdateInstallResult {
        lock.withLock { recorded.append(offer) }
        await gate?.wait()
        if asksTheMoment {
            let right = await canCommit()
            lock.withLock { moments.append(right) }
            if !right { return .deferred }
        }
        return lock.withLock { answers.count > 1 ? answers.removeFirst() : answers[0] }
    }
}

/// A clock a test moves by hand.
final class ClockBox: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date
    init(_ start: Date) { current = start }
    var now: Date { lock.withLock { current } }
    func advance(hours: Double) { lock.withLock { current = current.addingTimeInterval(hours * 3600) } }
    var read: @Sendable () -> Date { { [self] in now } }
}

/// A helper launcher that starts nothing: it writes down what it was asked to start.
final class FakeLauncher: DetachedLaunching, @unchecked Sendable {
    struct Launch: Equatable {
        var executable: String
        var arguments: [String]
    }

    private let lock = NSLock()
    private var recorded: [Launch] = []
    private var threads: [Bool] = []
    var fails = false

    var launches: [Launch] { lock.withLock { recorded } }
    /// Whether each launch was asked for on the main thread.
    var launchedOnTheMainThread: [Bool] { lock.withLock { threads } }

    func launch(_ executable: URL, arguments: [String]) throws {
        lock.withLock { threads.append(Thread.isMainThread) }
        if fails { throw CocoaError(.fileNoSuchFile) }
        lock.withLock { recorded.append(Launch(executable: executable.path, arguments: arguments)) }
    }
}

/// Makes a pretend app bundle: an Info.plist with a version and an identifier, and a file that says which app it is.
func makeApp(at url: URL, version: String, identifier: String = "dev.chenjing.cua-bar", body: String) throws {
    let contents = url.appendingPathComponent("Contents", isDirectory: true)
    try FileManager.default.createDirectory(at: contents.appendingPathComponent("MacOS"), withIntermediateDirectories: true)
    let info: [String: Any] = ["CFBundleIdentifier": identifier, "CFBundleShortVersionString": version]
    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: contents.appendingPathComponent("Info.plist"))
    try Data(body.utf8).write(to: contents.appendingPathComponent("MacOS/cua-bar"))
}

func bodyOfApp(at url: URL) -> String? {
    (try? String(contentsOf: url.appendingPathComponent("Contents/MacOS/cua-bar"), encoding: .utf8))
}

func versionOfApp(at url: URL) -> String? {
    guard
        let data = try? Data(contentsOf: url.appendingPathComponent("Contents/Info.plist")),
        let info = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any]
    else { return nil }
    return info["CFBundleShortVersionString"] as? String
}

/// Makes a chosen swap fail (counting from 1) and does the others for real, with the same system call the app uses.
final class SwapScript: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    private let failing: Set<Int>

    init(failing: Set<Int> = []) { self.failing = failing }

    var swaps: Int { lock.withLock { count } }

    var swap: @Sendable (URL, URL) throws -> Void {
        { [self] first, second in
            let number = lock.withLock { () -> Int in
                count += 1
                return count
            }
            if failing.contains(number) { throw CocoaError(.fileWriteNoPermission) }
            try AtomicSwap.exchange(first, second)
        }
    }
}

/// Stands in for the notifier of the install: writes down what was posted, and says it went out or not.
final class Announcements: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [AppNotification] = []
    private var goesOut = true

    var posted: [AppNotification] { lock.withLock { recorded } }
    /// False: notifications are off, and every post comes back as not delivered.
    func setDelivering(_ value: Bool) { lock.withLock { goesOut = value } }

    var post: @Sendable (AppNotification) async -> Bool {
        { [self] notification in
            lock.withLock {
                recorded.append(notification)
                return goesOut
            }
        }
    }
}

/// Writes down on which thread things happened.
final class ThreadLog: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [Bool] = []
    /// `true` for each thing that happened on the main thread.
    var onTheMainThread: [Bool] { lock.withLock { recorded } }
    func record() { lock.withLock { recorded.append(Thread.isMainThread) } }
}
