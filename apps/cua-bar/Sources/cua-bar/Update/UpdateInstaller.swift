import CryptoKit
import Foundation

/// Where an update can stop. Each has one fixed line that says why; none carries text a command or the site printed.
enum UpdateStep: String, Equatable, Sendable {
    /// What `/version` named cannot be used (a file name or checksum that is not spelled right).
    case offer
    /// The folder the app is in cannot be written to.
    case place
    case download
    /// The file is not as big as the site said, or its SHA-256 is another.
    case checksum
    /// The disk image would not open, or has no app in it, or the app would not copy out of it.
    case image
    case signature
    /// Signed, but by another developer.
    case team
    /// The app inside is not the version that was meant, or is not CUA Bar.
    case version
    /// The old app could not be moved away, or the new one into its place.
    case replace
    /// The helper that opens the new app could not be started.
    case relaunch

    var reason: String {
        switch self {
        case .offer: "받는 곳이 알려 준 판 정보를 쓸 수 없었어요"
        case .place: "앱이 있는 폴더에 쓸 수 없었어요"
        case .download: "새 판을 받지 못했어요"
        case .checksum: "받은 파일이 알려 준 크기·SHA-256과 달랐어요"
        case .image: "받은 파일에서 앱을 꺼내지 못했어요"
        case .signature: "받은 앱의 서명이 맞지 않았어요"
        case .team: "받은 앱의 개발자가 CUA Bar의 개발자가 아니었어요"
        case .version: "받은 앱이 받으려던 판의 CUA Bar가 아니었어요"
        case .replace: "앱을 새 판으로 바꾸지 못했어요"
        case .relaunch: "새 판을 켜는 도우미를 띄우지 못했어요"
        }
    }
}

enum UpdateInstallResult: Equatable, Sendable {
    /// The new app is in the old one's place and a helper will open it once this process has ended: the caller
    /// quits now.
    case replaced
    /// The moment passed while the file was being fetched (the popover opened, an install began): nothing was
    /// changed and nothing is left behind. Not a failure; it is tried again.
    case deferred
    /// Stopped at this step. The app is as it was and nothing is left behind.
    case failed(UpdateStep)
}

protocol UpdateInstalling: Sendable {
    /// Fetches the offer's disk image, checks it and puts the app inside it in place of the running one. `canCommit`
    /// is asked once more right before the replacing: it is the only part that touches the running app.
    func install(_ offer: UpdateOffer, canCommit: @escaping @MainActor @Sendable () -> Bool) async -> UpdateInstallResult
}

/// Starts a process that goes on after this one has ended.
protocol DetachedLaunching: Sendable {
    func launch(_ executable: URL, arguments: [String]) throws
}

struct DetachedProcessLauncher: DetachedLaunching {
    func launch(_ executable: URL, arguments: [String]) throws {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        // Not waited for: it waits for this process to end, and then opens the new app.
        try process.run()
    }
}

/// The process that opens the new app. It waits for the old one to end first, because only one copy runs at a time
/// and a copy opened beside the old one leaves at once. `open -g` opens it without bringing anything to the front.
enum RelaunchHelper {
    static let shell = URL(fileURLWithPath: "/bin/sh")
    static let opener = "/usr/bin/open"
    /// Gives up after a minute if the old process is still there: the new app is on disk for the next start.
    static let script = """
    pid="$1"; opener="$2"; app="$3"
    waited=0
    while kill -0 "$pid" 2>/dev/null; do
      waited=$((waited + 1))
      if [ "$waited" -gt 600 ]; then exit 0; fi
      sleep 0.1
    done
    exec "$opener" -g "$app"
    """

    static func arguments(waitingFor pid: Int32, opening bundle: URL, opener: String = RelaunchHelper.opener) -> [String] {
        ["-c", script, "cua-bar-relaunch", String(pid), opener, bundle.path]
    }
}

/// The update itself, from the file to the replaced app (F4). In this order, and any step that fails stops it with
/// the running app as it was and the temporary things gone:
///
/// 1. the app's folder can be written to
/// 2. the disk image is fetched into a temporary folder; its size and SHA-256 are what the site said
/// 3. it is mounted read-only (`hdiutil attach`), `CUABar.app` is copied out beside the running app into
///    `.CUABar-update.XXXX` (`ditto`), and the image is unmounted
/// 4. the copy is verified: `codesign --verify --deep --strict`, the Developer ID team, and the version in its
///    Info.plist is the one that was meant (and it is CUA Bar)
/// 5. the running app is moved aside and the new one into its place; if the second move fails the first is undone
/// 6. a helper is started that opens the new app once this process has ended; if that fails everything is undone
/// 7. the old app goes to `~/Library/Application Support/CUABar/Backups/<time>/`, the last one only
///
/// Nothing is asked of Codex or any other app, and nothing is brought to the front.
struct UpdateInstaller: UpdateInstalling {
    struct Timeouts: Equatable, Sendable {
        var attach: Duration = .seconds(120)
        var copy: Duration = .seconds(180)
        var verify: Duration = .seconds(120)
        var detach: Duration = .seconds(60)
    }

    static let hdiutil = URL(fileURLWithPath: "/usr/bin/hdiutil")
    static let ditto = URL(fileURLWithPath: "/usr/bin/ditto")
    static let codesign = URL(fileURLWithPath: "/usr/bin/codesign")

    var transport: any UpdateTransport
    var runner: any ProcessRunning
    var launcher: any DetachedLaunching
    /// The running app: what is replaced.
    var bundleURL: URL
    /// This process: what the helper waits for.
    var processID: Int32
    var home: URL
    var notice: UpdateNotice
    var now: @Sendable () -> Date = { Date() }
    /// How a bundle is moved; tests make one of the moves fail.
    var moveItem: @Sendable (URL, URL) throws -> Void = { try FileManager.default.moveItem(at: $0, to: $1) }
    var temporaryDirectory: URL = FileManager.default.temporaryDirectory
    var timeouts = Timeouts()

    /// What one run has made, so that cleaning up knows what to take away.
    private final class Session: @unchecked Sendable {
        var work: URL?
        var mountPoint: URL?
        var mayBeMounted = false
        var staging: URL?
        /// The old app could not be put back: it is in the staging folder, which stays.
        var keepStaging = false
    }

    func install(_ offer: UpdateOffer, canCommit: @escaping @MainActor @Sendable () -> Bool) async -> UpdateInstallResult {
        let parent = bundleURL.deletingLastPathComponent()
        guard FileManager.default.isWritableFile(atPath: parent.path) else { return .failed(.place) }
        let session = Session()
        let result = await fetchCheckAndReplace(offer, parent: parent, canCommit: canCommit, session: session)
        // Cleaning up does not stop because the task was cancelled.
        await Task.detached { await self.clean(session) }.value
        return result
    }

    // MARK: Fetch, check, replace

    private func fetchCheckAndReplace(
        _ offer: UpdateOffer, parent: URL, canCommit: @escaping @MainActor @Sendable () -> Bool, session: Session
    ) async -> UpdateInstallResult {
        let fm = FileManager.default

        let work = temporaryDirectory.appendingPathComponent("cua-bar-update-\(UUID().uuidString)", isDirectory: true)
        do {
            try fm.createDirectory(at: work, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        } catch {
            return .failed(.download)
        }
        session.work = work

        let image = work.appendingPathComponent(offer.file)
        do {
            try await transport.download(offer, to: image)
        } catch {
            return Task.isCancelled ? .deferred : .failed(.download)
        }
        guard Self.size(of: image) == offer.size, Self.sha256(of: image) == offer.sha256 else { return .failed(.checksum) }

        let mount = work.appendingPathComponent("mnt", isDirectory: true)
        do {
            try fm.createDirectory(at: mount, withIntermediateDirectories: false)
        } catch {
            return .failed(.image)
        }
        session.mountPoint = mount
        session.mayBeMounted = true
        let attach = ["attach", "-nobrowse", "-noautoopen", "-readonly", "-mountpoint", mount.path, image.path]
        guard await ran(Self.hdiutil, attach, timeouts.attach) else { return Task.isCancelled ? .deferred : .failed(.image) }

        let staging = parent.appendingPathComponent(".CUABar-update.\(Self.randomSuffix())", isDirectory: true)
        do {
            try fm.createDirectory(at: staging, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        } catch {
            return .failed(.place)
        }
        session.staging = staging
        let source = mount.appendingPathComponent(UpdateSource.bundleName, isDirectory: true)
        let staged = staging.appendingPathComponent(UpdateSource.bundleName, isDirectory: true)
        guard fm.fileExists(atPath: source.path) else { return .failed(.image) }
        guard await ran(Self.ditto, [source.path, staged.path], timeouts.copy) else { return Task.isCancelled ? .deferred : .failed(.image) }
        if await detach(mount) { session.mayBeMounted = false }

        guard await ran(Self.codesign, ["--verify", "--deep", "--strict", staged.path], timeouts.verify) else {
            return Task.isCancelled ? .deferred : .failed(.signature)
        }
        guard
            let described = try? await runner.run(Self.codesign, arguments: ["-dv", staged.path], timeout: timeouts.verify),
            described.exitCode == 0, Self.teamIdentifier(in: described) == UpdateSource.teamIdentifier
        else { return Task.isCancelled ? .deferred : .failed(.team) }
        guard Self.isTheApp(at: staged, version: offer.version) else { return .failed(.version) }

        guard !Task.isCancelled, await canCommit() else { return .deferred }
        return replace(with: staged, staging: staging, version: offer.version, session: session)
    }

    /// Everything from the mark to the helper happens without waiting for anything, so nothing can come between.
    private func replace(with staged: URL, staging: URL, version: VersionNumber, session: Session) -> UpdateInstallResult {
        // Before it is done, so that the new app, whenever it starts, finds it.
        try? notice.leave(version: version)

        let previous = staging.appendingPathComponent("Previous.app", isDirectory: true)
        do {
            try moveItem(bundleURL, previous)
        } catch {
            notice.clear()
            return .failed(.replace)
        }
        do {
            try moveItem(staged, bundleURL)
        } catch {
            putBack(previous, session)
            notice.clear()
            return .failed(.replace)
        }
        do {
            try launcher.launch(RelaunchHelper.shell, arguments: RelaunchHelper.arguments(waitingFor: processID, opening: bundleURL))
        } catch {
            if (try? moveItem(bundleURL, staged)) != nil {
                putBack(previous, session)
            } else {
                session.keepStaging = true
            }
            notice.clear()
            return .failed(.relaunch)
        }
        keepBackup(of: previous)
        return .replaced
    }

    /// The old app back where it was. If that cannot be done it stays in the staging folder, which is not removed.
    private func putBack(_ previous: URL, _ session: Session) {
        if (try? moveItem(previous, bundleURL)) == nil { session.keepStaging = true }
    }

    // MARK: The old app

    /// Moves the replaced app to `Backups/<time>/CUABar.app` and drops the older backups. Best effort: the update is
    /// done by now, and an old copy that could not be kept goes with the staging folder.
    private func keepBackup(of previous: URL) {
        let fm = FileManager.default
        let backups = UpdateNotice.supportFolder(home: home).appendingPathComponent("Backups", isDirectory: true)
        let stamp = Self.stamp(now())
        do {
            let folder = backups.appendingPathComponent(stamp, isDirectory: true)
            try fm.createDirectory(at: folder, withIntermediateDirectories: true)
            let destination = folder.appendingPathComponent(UpdateSource.bundleName, isDirectory: true)
            try? fm.removeItem(at: destination)
            try fm.moveItem(at: previous, to: destination)
        } catch {
            return
        }
        let others = (try? fm.contentsOfDirectory(at: backups, includingPropertiesForKeys: nil)) ?? []
        for entry in others where entry.lastPathComponent != stamp && Self.isStamp(entry.lastPathComponent) {
            try? fm.removeItem(at: entry)
        }
    }

    // MARK: Cleaning up

    /// Unmounts the image if it is still mounted and takes the temporary folders away. The staging folder stays when it
    /// holds the only copy of the old app; the work folder stays while the image is still mounted in it.
    private func clean(_ session: Session) async {
        let fm = FileManager.default
        var stillMounted = false
        if session.mayBeMounted, let mount = session.mountPoint {
            stillMounted = await !detach(mount)
        }
        if let staging = session.staging, !session.keepStaging { try? fm.removeItem(at: staging) }
        if let work = session.work, !stillMounted { try? fm.removeItem(at: work) }
    }

    /// True when the image is not mounted any more (it was not, or `hdiutil detach` took it away, with force if it came
    /// to that).
    private func detach(_ mount: URL) async -> Bool {
        if await ran(Self.hdiutil, ["detach", mount.path], timeouts.detach) { return true }
        if await ran(Self.hdiutil, ["detach", "-force", mount.path], timeouts.detach) { return true }
        // Neither worked: it is gone all the same when nothing is in the place it was mounted on.
        return ((try? FileManager.default.contentsOfDirectory(atPath: mount.path)) ?? ["?"]).isEmpty
    }

    // MARK: Small things

    private func ran(_ tool: URL, _ arguments: [String], _ timeout: Duration) async -> Bool {
        guard let output = try? await runner.run(tool, arguments: arguments, timeout: timeout) else { return false }
        return output.exitCode == 0
    }

    static func size(of file: URL) -> Int? {
        (try? FileManager.default.attributesOfItem(atPath: file.path))?[.size] as? Int
    }

    static func sha256(of file: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: file) else { return nil }
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try? handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// `TeamIdentifier=<team>` of `codesign -dv`, which prints it on its error output.
    static func teamIdentifier(in output: ProcessOutput) -> String? {
        let text = String(decoding: output.stderr, as: UTF8.self) + "\n" + String(decoding: output.stdout, as: UTF8.self)
        for line in text.split(whereSeparator: \.isNewline) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("TeamIdentifier=") { return String(trimmed.dropFirst("TeamIdentifier=".count)) }
        }
        return nil
    }

    /// The copy is CUA Bar of the version that was meant.
    static func isTheApp(at app: URL, version: VersionNumber) -> Bool {
        let plist = app.appendingPathComponent("Contents/Info.plist")
        guard
            let data = try? Data(contentsOf: plist),
            let info = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any]
        else { return false }
        return info["CFBundleIdentifier"] as? String == SingleInstance.bundleIdentifier
            && (info["CFBundleShortVersionString"] as? String).flatMap { VersionNumber(strict: $0) } == version
    }

    static func randomSuffix() -> String {
        String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(6))
    }

    /// `20261021-163905`, the way `build-app.sh --install` names its backups.
    static func stamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter.string(from: date)
    }

    static func isStamp(_ name: String) -> Bool {
        let characters = Array(name.utf8)
        return characters.count == 15 && characters.enumerated().allSatisfy { index, byte in
            index == 8 ? byte == UInt8(ascii: "-") : (byte >= 0x30 && byte <= 0x39)
        }
    }
}
