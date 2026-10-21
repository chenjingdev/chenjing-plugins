import CryptoKit
import Darwin
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
    /// The signature is missing or broken (`codesign` found the file altered or not signed at all).
    case signature
    /// Signed, but not by CUA Bar's developer (an ad hoc signature, another team's).
    case team
    /// The app inside is not the version that was meant, or is not CUA Bar.
    case version
    /// The new app could not be put in the old one's place.
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
        case .signature: "받은 파일의 서명이 맞지 않았어요"
        case .team: "받은 파일이 CUA Bar의 개발자가 서명한 것이 아니었어요"
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
    /// How long it waits for this process to end before it gives up, in seconds: the new app is on disk for the next
    /// start. Long, because this process may be busy ending (a stuck unmount) and a helper that gave up leaves no app.
    static let waitLimit = 600
    /// The pause, in seconds, between the old process being gone and the new app being opened: the system forgets the
    /// old one in that time, so that the new one is not taken for a second copy.
    static let settle = 1
    static let script = """
    pid="$1"; opener="$2"; app="$3"
    waited=0
    while kill -0 "$pid" 2>/dev/null; do
      waited=$((waited + 1))
      if [ "$waited" -gt \(waitLimit * 10) ]; then exit 0; fi
      sleep 0.1
    done
    sleep \(settle)
    exec "$opener" -g "$app"
    """

    static func arguments(waitingFor pid: Int32, opening bundle: URL, opener: String = RelaunchHelper.opener) -> [String] {
        ["-c", script, "cua-bar-relaunch", String(pid), opener, bundle.path]
    }
}

/// Exchanges two paths in one step (`renamex_np` with `RENAME_SWAP`): afterwards each holds what the other held, and at no
/// moment is either of them missing. It needs a file system that can (APFS); on another it fails and changes nothing.
enum AtomicSwap {
    static func exchange(_ first: URL, _ second: URL) throws {
        guard renamex_np(first.path, second.path, UInt32(RENAME_SWAP)) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }
}

/// The update itself, from the file to the replaced app (F4). In this order, and any step that fails stops it with
/// the running app as it was and the temporary things gone:
///
/// 0. what a run that was cut short left behind (copies beside the app, images still mounted) is taken away
/// 1. the app's folder can be written to
/// 2. the disk image is fetched into a temporary folder; its size and SHA-256 are what the site said
/// 3. the image is signed by CUA Bar's developer (`codesign --verify -R`): an image of someone else is never mounted
/// 4. it is mounted read-only (`hdiutil attach`), `CUABar.app` is copied out beside the running app into
///    `.CUABar-update.XXXX` (`ditto`), and the image is unmounted
/// 5. the copy is verified, by the system and not by reading what a tool prints: `codesign --verify --deep --strict -R`
///    with the requirement of the team's Developer ID and CUA Bar's identifier; and the version in its Info.plist is the
///    one that was meant (and it is CUA Bar)
/// 6. the new app and the old one change places in one step; a helper is started that opens the new app once this
///    process has ended, and if that fails they change places back
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
    /// What the folders of one run are called, so that the next run knows which are leftovers.
    static let stagingPrefix = ".CUABar-update."
    static let workPrefix = "cua-bar-update-"

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
    /// How the new app and the old one change places; tests make it fail.
    var swapItems: @Sendable (URL, URL) throws -> Void = { try AtomicSwap.exchange($0, $1) }
    var temporaryDirectory: URL = FileManager.default.temporaryDirectory
    var timeouts = Timeouts()

    /// What one run has made, so that cleaning up knows what to take away.
    private final class Session: @unchecked Sendable {
        var work: URL?
        var mountPoint: URL?
        var mayBeMounted = false
        var staging: URL?
    }

    func install(_ offer: UpdateOffer, canCommit: @escaping @MainActor @Sendable () -> Bool) async -> UpdateInstallResult {
        let parent = bundleURL.deletingLastPathComponent()
        await clearLeftovers(in: parent)
        guard FileManager.default.isWritableFile(atPath: parent.path) else { return .failed(.place) }
        let session = Session()
        let result = await fetchCheckAndReplace(offer, parent: parent, canCommit: canCommit, session: session)
        if result == .replaced {
            // The helper is already counting. Nothing that can take time, an image that will not let go, is waited for;
            // the next run lets go of it.
            forget(session)
        } else {
            // Cleaning up does not stop because the task was cancelled.
            await Task.detached { await self.clean(session) }.value
        }
        return result
    }

    // MARK: Fetch, check, replace

    private func fetchCheckAndReplace(
        _ offer: UpdateOffer, parent: URL, canCommit: @escaping @MainActor @Sendable () -> Bool, session: Session
    ) async -> UpdateInstallResult {
        let fm = FileManager.default

        let work = temporaryDirectory.appendingPathComponent("\(Self.workPrefix)\(UUID().uuidString)", isDirectory: true)
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
        // The same site gave the checksum, so it proves only that the file arrived whole. Whose it is, the signature says;
        // an image of someone else is not even mounted.
        if let refused = await refusal(of: image, requirement: UpdateSource.imageRequirement, deep: false) { return refused }

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

        let staging = parent.appendingPathComponent("\(Self.stagingPrefix)\(Self.randomSuffix())", isDirectory: true)
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

        if let refused = await refusal(of: staged, requirement: UpdateSource.appRequirement, deep: true) { return refused }
        guard Self.isTheApp(at: staged, version: offer.version) else { return .failed(.version) }

        guard !Task.isCancelled else { return .deferred }
        // The moment is looked at and the replacing done in one turn of the main actor, so that nothing (the popover
        // opening, an install starting) can come between them.
        return await MainActor.run {
            guard canCommit() else { return UpdateInstallResult.deferred }
            return replace(with: staged, version: offer.version)
        }
    }

    /// Everything from the mark to the helper happens without waiting for anything.
    private func replace(with staged: URL, version: VersionNumber) -> UpdateInstallResult {
        // Before it is done, so that the new app, whenever it starts, finds it.
        try? notice.leave(version: version)

        // The new app takes the old one's place and the old one takes the staged place, in one step: at no moment is the
        // app missing, and a failure changes nothing.
        do {
            try swapItems(staged, bundleURL)
        } catch {
            notice.clear()
            return .failed(.replace)
        }
        do {
            try launcher.launch(RelaunchHelper.shell, arguments: RelaunchHelper.arguments(waitingFor: processID, opening: bundleURL))
        } catch {
            // The same step back. Should that fail too, the new app, whole and checked, stays in the place, and its mark
            // with it: it tells the person when it is started.
            if (try? swapItems(staged, bundleURL)) != nil { notice.clear() }
            return .failed(.relaunch)
        }
        keepBackup(of: staged)
        return .replaced
    }

    /// Asks the system whether the file at `target` is signed by CUA Bar's developer (`requirement`). nil when it is;
    /// otherwise where the update stops: `codesign` exits 3 when the file is signed but does not satisfy the requirement
    /// (an ad hoc signature, another team's), and with another status when it is not signed or has been altered.
    private func refusal(of target: URL, requirement: String, deep: Bool) async -> UpdateInstallResult? {
        guard
            let output = try? await runner.run(
                Self.codesign, arguments: Self.verification(of: target, requirement: requirement, deep: deep), timeout: timeouts.verify)
        else { return Task.isCancelled ? .deferred : .failed(.signature) }
        switch output.exitCode {
        case 0: return nil
        case 3: return .failed(.team)
        default: return .failed(.signature)
        }
    }

    /// The arguments of `codesign` that verify the file and test it against the requirement (`=` before the text says it is
    /// the requirement itself and not the name of a file). `--deep` for an app, which holds more code.
    static func verification(of target: URL, requirement: String, deep: Bool) -> [String] {
        ["--verify"] + (deep ? ["--deep"] : []) + ["--strict", "-R", "=" + requirement, target.path]
    }

    // MARK: The old app

    /// Moves the replaced app to `Backups/<time>/CUABar.app` and drops the older backups. Best effort: the update is
    /// done by now, and an old copy that could not be kept goes with the staging folder.
    private func keepBackup(of old: URL) {
        let fm = FileManager.default
        let backups = UpdateNotice.supportFolder(home: home).appendingPathComponent("Backups", isDirectory: true)
        let stamp = Self.stamp(now())
        do {
            let folder = backups.appendingPathComponent(stamp, isDirectory: true)
            try fm.createDirectory(at: folder, withIntermediateDirectories: true)
            let destination = folder.appendingPathComponent(UpdateSource.bundleName, isDirectory: true)
            try? fm.removeItem(at: destination)
            try fm.moveItem(at: old, to: destination)
        } catch {
            return
        }
        let others = (try? fm.contentsOfDirectory(at: backups, includingPropertiesForKeys: nil)) ?? []
        for entry in others where entry.lastPathComponent != stamp && Self.isStamp(entry.lastPathComponent) {
            try? fm.removeItem(at: entry)
        }
    }

    // MARK: Cleaning up

    /// Takes away what a run that was cut short (quit, logout) left behind: the copies of the new app in the app's
    /// folder, and images still mounted in the temporary folder. A staging folder with a `Previous.app` in it is left, for
    /// it may hold an old app that nothing else does (a version of this update that moved the old app aside by that name
    /// did; this one swaps, and the place is never empty).
    private func clearLeftovers(in parent: URL) async {
        let fm = FileManager.default
        for entry in (try? fm.contentsOfDirectory(at: parent, includingPropertiesForKeys: nil)) ?? []
        where entry.lastPathComponent.hasPrefix(Self.stagingPrefix) {
            if !fm.fileExists(atPath: entry.appendingPathComponent("Previous.app").path) { try? fm.removeItem(at: entry) }
        }
        for work in (try? fm.contentsOfDirectory(at: temporaryDirectory, includingPropertiesForKeys: nil)) ?? []
        where work.lastPathComponent.hasPrefix(Self.workPrefix) {
            let mount = work.appendingPathComponent("mnt", isDirectory: true)
            if !((try? fm.contentsOfDirectory(atPath: mount.path)) ?? []).isEmpty {
                // Something is in it: an image that is still mounted. Not let go of, it stays.
                guard await detach(mount) else { continue }
            }
            try? fm.removeItem(at: work)
        }
    }

    /// Unmounts the image if it is still mounted and takes the temporary folders away. The work folder stays while the
    /// image is still mounted in it.
    private func clean(_ session: Session) async {
        let fm = FileManager.default
        var stillMounted = false
        if session.mayBeMounted, let mount = session.mountPoint {
            stillMounted = await !detach(mount)
        }
        if let staging = session.staging { try? fm.removeItem(at: staging) }
        if let work = session.work, !stillMounted { try? fm.removeItem(at: work) }
    }

    /// The same without asking anything of `hdiutil`: for an update that is done and about to end.
    private func forget(_ session: Session) {
        let fm = FileManager.default
        if let staging = session.staging { try? fm.removeItem(at: staging) }
        if let work = session.work, !session.mayBeMounted { try? fm.removeItem(at: work) }
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
