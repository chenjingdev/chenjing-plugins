import Foundation
import Testing
@testable import cua_bar

/// The update from the file to the replaced app, over a throwaway home: real folders and real swaps, but the
/// download, `hdiutil`, `ditto` and `codesign` are stand-ins (nothing reaches the network, mounts an image or signs).
/// What `codesign` really says about a signature is `UpdateSignatureTests`.
struct UpdateInstallerTests {
    /// How the stand-in `codesign --verify -R` answers: the way the real one exits.
    enum Signing: Sendable {
        /// 0: signed by the developer.
        case official
        /// 3: signed, but not as the requirement says (ad hoc, another team's).
        case otherDeveloper
        /// 1: not signed at all, or altered.
        case broken
    }

    /// What the pretend commands do.
    final class Behavior: @unchecked Sendable {
        struct Values: Sendable {
            var attachFails = false
            var appInImage = true
            var imageVersion = "0.8.0"
            var imageIdentifier = "dev.chenjing.cua-bar"
            var appSigning = Signing.official
            var imageSigning = Signing.official
            var plainDetachFails = false
            var detachFails = false
            var dittoFails = false
        }

        private let lock = NSLock()
        private var current = Values()
        var values: Values { lock.withLock { current } }
        func set(_ change: (inout Values) -> Void) { lock.withLock { change(&current) } }
    }

    struct World {
        var home: TempHome
        var apps: URL
        var bundle: URL
        var scratch: URL
        var transport: FakeTransport
        var runner: StepRunner
        var launcher: FakeLauncher
        var behavior: Behavior
        var notice: UpdateNotice
        var offer: UpdateOffer
        var swaps: SwapScript
        var installer: UpdateInstaller

        func remove() {
            // A test may have made the folder read-only.
            try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: apps.path)
            home.remove()
        }

        var backups: URL { UpdateNotice.supportFolder(home: home.url).appendingPathComponent("Backups", isDirectory: true) }

        func names(in folder: URL) -> [String] {
            ((try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []).sorted()
        }

        /// The app that was there before, untouched.
        var oldAppIsInPlace: Bool { bodyOfApp(at: bundle) == "old" && versionOfApp(at: bundle) == "0.7.0" }

        /// Nothing the update made is left: no staging folder beside the app, nothing in the temporary folder.
        var nothingIsLeftBehind: Bool { names(in: apps) == ["CUABar.app"] && names(in: scratch).isEmpty }

        /// What ran, by tool and subcommand: "hdiutil attach", "ditto", "codesign --verify".
        var commands: [String] {
            runner.calls.map { call in
                let tool = URL(fileURLWithPath: call.executable).lastPathComponent
                return tool == "ditto" ? tool : "\(tool) \(call.arguments.first ?? "")"
            }
        }
    }

    func world(failingSwaps: Set<Int> = [], image: Data = Data("pretend disk image".utf8)) throws -> World {
        let home = try TempHome()
        let apps = home.url.appendingPathComponent("Applications", isDirectory: true)
        let bundle = apps.appendingPathComponent("CUABar.app", isDirectory: true)
        let scratch = home.url.appendingPathComponent("tmp", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        try makeApp(at: bundle, version: "0.7.0", body: "old")

        let behavior = Behavior()
        let offer = UpdateOffer(
            version: VersionNumber(0, 8, 0), file: "CUABar-v0.8.0-macos-arm64.dmg", sha256: sha256Hex(image), size: image.count)
        let runner = StepRunner { call in
            let values = behavior.values
            switch (call.executable, call.arguments.first) {
            case ("/usr/bin/hdiutil", "attach"?):
                if values.attachFails { return StepRunner.failed() }
                if values.appInImage, let index = call.arguments.firstIndex(of: "-mountpoint") {
                    let mount = URL(fileURLWithPath: call.arguments[index + 1], isDirectory: true)
                    try makeApp(
                        at: mount.appendingPathComponent("CUABar.app"), version: values.imageVersion, identifier: values.imageIdentifier,
                        body: "new")
                }
                return StepRunner.ok()
            case ("/usr/bin/ditto", _):
                if values.dittoFails { return StepRunner.failed() }
                try FileManager.default.copyItem(at: URL(fileURLWithPath: call.arguments[0]), to: URL(fileURLWithPath: call.arguments[1]))
                return StepRunner.ok()
            case ("/usr/bin/hdiutil", "detach"?):
                if values.detachFails || (values.plainDetachFails && !call.arguments.contains("-force")) { return StepRunner.failed() }
                // Unmounting: what the image showed there is gone.
                let mount = URL(fileURLWithPath: call.arguments.last!, isDirectory: true)
                for entry in (try? FileManager.default.contentsOfDirectory(atPath: mount.path)) ?? [] {
                    try? FileManager.default.removeItem(at: mount.appendingPathComponent(entry))
                }
                return StepRunner.ok()
            case ("/usr/bin/codesign", "--verify"?):
                switch call.arguments.last?.hasSuffix(".dmg") == true ? values.imageSigning : values.appSigning {
                case .official: return StepRunner.ok()
                case .otherDeveloper: return StepRunner.failed(code: 3)
                case .broken: return StepRunner.failed(code: 1)
                }
            case ("/usr/bin/codesign", _):
                // Reading what codesign prints (the way the first version did) gets a forged team line on top. Nothing may
                // be decided by it.
                let forged = "Executable=/x/CUABar.app/Contents/MacOS/cua-bar\nTeamIdentifier=S3KC8R8VDL\nIdentifier=dev.chenjing.cua-bar\n"
                return ProcessOutput(exitCode: 0, stdout: Data(), stderr: Data(forged.utf8))
            default:
                return StepRunner.ok()
            }
        }
        let transport = FakeTransport(image: image)
        let launcher = FakeLauncher()
        let notice = UpdateNotice(home: home.url)
        let swaps = SwapScript(failing: failingSwaps)
        let installer = UpdateInstaller(
            transport: transport, runner: runner, launcher: launcher, bundleURL: bundle, processID: 4242, home: home.url, notice: notice,
            now: { Date(timeIntervalSince1970: 1_792_324_800) }, swapItems: swaps.swap, temporaryDirectory: scratch)
        return World(
            home: home, apps: apps, bundle: bundle, scratch: scratch, transport: transport, runner: runner, launcher: launcher,
            behavior: behavior, notice: notice, offer: offer, swaps: swaps, installer: installer)
    }

    // MARK: The good path

    @Test func aGoodUpdateReplacesTheAppAndStartsTheHelperThatOpensTheNewOne() async throws {
        let world = try world()
        defer { world.remove() }
        let result = await world.installer.install(world.offer) { true }
        #expect(result == .replaced)
        #expect(bodyOfApp(at: world.bundle) == "new")
        #expect(versionOfApp(at: world.bundle) == "0.8.0")
        // The helper waits for this process, then opens the new app in the background (`open -g`).
        #expect(world.launcher.launches == [
            FakeLauncher.Launch(
                executable: "/bin/sh", arguments: ["-c", RelaunchHelper.script, "cua-bar-relaunch", "4242", "/usr/bin/open", world.bundle.path]),
        ])
        #expect(RelaunchHelper.script.contains("kill -0"))
        #expect(RelaunchHelper.script.contains(#"exec "$opener" -g "$app""#))
        #expect(world.nothingIsLeftBehind)
        #expect(world.swaps.swaps == 1, "the new app and the old one change places once, in one step")
        // The mark for the app that starts next was left before the replacing.
        #expect(world.notice.pendingVersion == VersionNumber(0, 8, 0))
    }

    @Test func theFileComesFromTheOfferAndIsCheckedBeforeAnythingElseHappens() async throws {
        let world = try world()
        defer { world.remove() }
        _ = await world.installer.install(world.offer) { true }
        #expect(world.transport.downloads == [world.offer])
    }

    @Test func theCommandsRunInTheOrderAndWithTheArgumentsTheUpdateIsDefinedBy() async throws {
        let world = try world()
        defer { world.remove() }
        _ = await world.installer.install(world.offer) { true }
        let calls = world.runner.calls
        #expect(world.commands == ["codesign --verify", "hdiutil attach", "ditto", "hdiutil detach", "codesign --verify"])

        // The image is looked at before it is mounted: signed by the developer, whatever its name.
        let imageCheck = calls[0]
        #expect(imageCheck.executable == "/usr/bin/codesign")
        #expect(imageCheck.arguments.dropLast() == ["--verify", "--strict", "-R", "=" + UpdateSource.imageRequirement])
        let image = try #require(imageCheck.arguments.last)
        #expect(image.hasPrefix(world.scratch.path) && image.hasSuffix("/CUABar-v0.8.0-macos-arm64.dmg"))

        let attach = calls[1]
        let mount = try #require(attach.arguments.firstIndex(of: "-mountpoint").map { attach.arguments[$0 + 1] })
        #expect(attach.executable == "/usr/bin/hdiutil")
        #expect(attach.arguments == ["attach", "-nobrowse", "-noautoopen", "-readonly", "-mountpoint", mount, image])
        #expect(mount.hasPrefix(world.scratch.path), "the image is mounted in the temporary folder, not in /Volumes")
        let ditto = calls[2]
        #expect(ditto.executable == "/usr/bin/ditto")
        #expect(ditto.arguments.first == mount + "/CUABar.app")
        // Beside the running app, in a folder of its own, so that the last step is a rename on the same disk.
        let staged = try #require(ditto.arguments.last)
        #expect(staged.hasPrefix(world.apps.path + "/.CUABar-update."))
        #expect(staged.hasSuffix("/CUABar.app"))
        #expect(calls[3].arguments == ["detach", mount])

        // The copy: signed by the developer as CUA Bar, deep and strict. No `-dv`, nothing read out of codesign's words.
        let appCheck = calls[4]
        #expect(appCheck.executable == "/usr/bin/codesign")
        #expect(appCheck.arguments == ["--verify", "--deep", "--strict", "-R", "=" + UpdateSource.appRequirement, staged])
        #expect(!calls.contains { $0.executable == "/usr/bin/codesign" && $0.arguments.contains { $0.hasPrefix("-d") } })
    }

    @Test func theRequirementsAreTheDeveloperIDOfTheTeamAndTheAppAddsItsIdentifier() {
        #expect(
            UpdateSource.appRequirement
                == #"anchor apple generic and identifier "dev.chenjing.cua-bar" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "S3KC8R8VDL""#)
        #expect(
            UpdateSource.imageRequirement
                == #"anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "S3KC8R8VDL""#)
    }

    @Test func theOldAppIsKeptAsTheLastBackupAndOlderBackupsGo() async throws {
        let world = try world()
        defer { world.remove() }
        for old in ["20260101-010101", "20260202-020202"] {
            try makeApp(at: world.backups.appendingPathComponent(old).appendingPathComponent("CUABar.app"), version: "0.6.0", body: "older")
        }
        // Not a backup this app made: left alone.
        try world.home.write("mine", to: world.backups.appendingPathComponent("notes.txt"))
        let result = await world.installer.install(world.offer) { true }
        #expect(result == .replaced)
        let stamp = UpdateInstaller.stamp(Date(timeIntervalSince1970: 1_792_324_800))
        #expect(UpdateInstaller.isStamp(stamp))
        #expect(world.names(in: world.backups) == [stamp, "notes.txt"].sorted())
        let kept = world.backups.appendingPathComponent(stamp).appendingPathComponent("CUABar.app")
        #expect(bodyOfApp(at: kept) == "old", "the app that was replaced, as it was")
        #expect(versionOfApp(at: kept) == "0.7.0")
    }

    // MARK: Before anything is touched

    @Test func aFolderThatCannotBeWrittenToStopsBeforeTheDownload() async throws {
        let world = try world()
        defer { world.remove() }
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: world.apps.path)
        let result = await world.installer.install(world.offer) { true }
        #expect(result == .failed(.place))
        #expect(world.transport.downloads.isEmpty, "nothing is fetched for an update that cannot be put anywhere")
        #expect(world.runner.calls.isEmpty)
        #expect(world.oldAppIsInPlace)
        #expect(world.notice.pendingVersion == nil)
    }

    @Test func aDownloadThatFailsStopsThereAndLeavesNothing() async throws {
        let world = try world()
        defer { world.remove() }
        world.transport.setDownloadFailing()
        #expect(await world.installer.install(world.offer) { true } == .failed(.download))
        #expect(world.runner.calls.isEmpty)
        #expect(world.oldAppIsInPlace)
        #expect(world.nothingIsLeftBehind)
        #expect(world.launcher.launches.isEmpty)
    }

    @Test func aFileWhoseSHA256IsNotTheOneTheSiteGaveIsNeverOpened() async throws {
        let world = try world(image: Data("pretend disk image".utf8))
        defer { world.remove() }
        world.transport.set(image: Data("pretend disk imagE".utf8)) // same size, other bytes
        #expect(await world.installer.install(world.offer) { true } == .failed(.checksum))
        #expect(world.runner.calls.isEmpty, "not mounted, not copied, not looked at")
        #expect(world.oldAppIsInPlace)
        #expect(world.nothingIsLeftBehind)
        #expect(world.notice.pendingVersion == nil)
    }

    @Test func aFileOfAnotherSizeThanTheSiteSaidIsNeverOpenedEither() async throws {
        let world = try world()
        defer { world.remove() }
        let longer = Data("pretend disk image, and a little more".utf8)
        world.transport.set(image: longer)
        // The checksum even matches this file: the size is what is wrong.
        var offer = world.offer
        offer.sha256 = sha256Hex(longer)
        #expect(await world.installer.install(offer) { true } == .failed(.checksum))
        #expect(world.runner.calls.isEmpty)
        #expect(world.nothingIsLeftBehind)
    }

    // MARK: The image is the developer's before it is mounted

    @Test(arguments: [(Signing.otherDeveloper, UpdateStep.team), (.broken, .signature)])
    func anImageThatIsNotSignedByTheDeveloperIsNeverMounted(signing: Signing, step: UpdateStep) async throws {
        let world = try world()
        defer { world.remove() }
        world.behavior.set { $0.imageSigning = signing }
        #expect(await world.installer.install(world.offer) { true } == .failed(step))
        // Only the look at the image ran: it was not mounted, and nothing was copied.
        #expect(world.commands == ["codesign --verify"])
        #expect(world.oldAppIsInPlace)
        #expect(world.nothingIsLeftBehind)
        #expect(world.launcher.launches.isEmpty)
        #expect(world.notice.pendingVersion == nil)
    }

    // MARK: The image and the copy

    @Test func anImageThatWillNotMountStopsThere() async throws {
        let world = try world()
        defer { world.remove() }
        world.behavior.set { $0.attachFails = true }
        #expect(await world.installer.install(world.offer) { true } == .failed(.image))
        #expect(world.oldAppIsInPlace)
        #expect(world.nothingIsLeftBehind)
    }

    @Test func anImageWithoutTheAppInItStopsAndIsUnmounted() async throws {
        let world = try world()
        defer { world.remove() }
        world.behavior.set { $0.appInImage = false }
        #expect(await world.installer.install(world.offer) { true } == .failed(.image))
        #expect(world.commands.contains("hdiutil detach"), "what was mounted is let go of")
        #expect(world.oldAppIsInPlace)
        #expect(world.nothingIsLeftBehind)
    }

    @Test func aCopyThatFailsStopsAndTheImageIsUnmounted() async throws {
        let world = try world()
        defer { world.remove() }
        world.behavior.set { $0.dittoFails = true }
        #expect(await world.installer.install(world.offer) { true } == .failed(.image))
        #expect(world.commands.last == "hdiutil detach")
        #expect(world.oldAppIsInPlace)
        #expect(world.nothingIsLeftBehind)
    }

    @Test func anImageThatWillNotLetGoIsUnmountedByForce() async throws {
        let world = try world()
        defer { world.remove() }
        world.behavior.set { $0.plainDetachFails = true }
        #expect(await world.installer.install(world.offer) { true } == .replaced)
        let detaches = world.runner.calls.filter { $0.arguments.first == "detach" }
        #expect(detaches.count == 2)
        #expect(detaches[1].arguments.contains("-force"))
        #expect(world.nothingIsLeftBehind)
    }

    // MARK: What the copy has to be

    @Test(arguments: [(Signing.otherDeveloper, UpdateStep.team), (.broken, .signature)])
    func aCopyThatIsNotSignedByTheDeveloperIsRefusedAndTheOriginalStays(signing: Signing, step: UpdateStep) async throws {
        let world = try world()
        defer { world.remove() }
        world.behavior.set { $0.appSigning = signing }
        #expect(await world.installer.install(world.offer) { true } == .failed(step))
        #expect(world.oldAppIsInPlace)
        #expect(world.nothingIsLeftBehind)
        #expect(world.launcher.launches.isEmpty)
        #expect(world.swaps.swaps == 0, "the running app was not even touched")
        #expect(world.notice.pendingVersion == nil)
    }

    @Test func aTeamLineForgedInWhatCodesignPrintsDecidesNothing() async throws {
        // An app that is not the developer's, with a name that makes `codesign -dv` print a team line of its own on top. The
        // stand-in `codesign` prints exactly that for anything but `--verify`; the verdict is the requirement's alone.
        let world = try world()
        defer { world.remove() }
        world.behavior.set { $0.appSigning = .otherDeveloper }
        #expect(await world.installer.install(world.offer) { true } == .failed(.team))
        #expect(world.oldAppIsInPlace)
        #expect(world.runner.calls.allSatisfy { $0.executable != "/usr/bin/codesign" || $0.arguments.first == "--verify" })
        #expect(world.nothingIsLeftBehind)
    }

    @Test func aCopyWhoseVersionIsNotTheOneMeantIsRefused() async throws {
        let world = try world()
        defer { world.remove() }
        // An older app under the newer name: the signature is right, the version is not.
        world.behavior.set { $0.imageVersion = "0.7.5" }
        #expect(await world.installer.install(world.offer) { true } == .failed(.version))
        #expect(world.oldAppIsInPlace)
        #expect(world.nothingIsLeftBehind)
    }

    @Test func aCopyThatIsAnotherAppOfTheSameTeamIsRefused() async throws {
        let world = try world()
        defer { world.remove() }
        world.behavior.set { $0.imageIdentifier = "dev.chenjing.other-app" }
        #expect(await world.installer.install(world.offer) { true } == .failed(.version))
        #expect(world.oldAppIsInPlace)
        #expect(world.nothingIsLeftBehind)
    }

    // MARK: Replacing

    @Test func aSwapThatFailsChangesNothingAndTakesTheMarkAway() async throws {
        let world = try world(failingSwaps: [1])
        defer { world.remove() }
        #expect(await world.installer.install(world.offer) { true } == .failed(.replace))
        #expect(world.oldAppIsInPlace)
        #expect(world.swaps.swaps == 1)
        #expect(world.nothingIsLeftBehind)
        #expect(world.launcher.launches.isEmpty)
        #expect(world.notice.pendingVersion == nil)
        #expect(!FileManager.default.fileExists(atPath: world.backups.path), "no backup of an app that was never replaced")
    }

    @Test func aHelperThatCannotBeStartedPutsTheOldAppBackTheSameWay() async throws {
        let world = try world()
        defer { world.remove() }
        world.launcher.fails = true
        #expect(await world.installer.install(world.offer) { true } == .failed(.relaunch))
        #expect(world.oldAppIsInPlace, "an app nobody would open again is not left in the old one's place")
        #expect(world.swaps.swaps == 2, "the same step, back")
        #expect(world.nothingIsLeftBehind)
        #expect(world.notice.pendingVersion == nil)
        #expect(!FileManager.default.fileExists(atPath: world.backups.path))
    }

    @Test func ifEvenThatCannotBeUndoneTheNewAppStaysWholeInPlaceWithItsMark() async throws {
        let world = try world(failingSwaps: [2])
        defer { world.remove() }
        world.launcher.fails = true
        #expect(await world.installer.install(world.offer) { true } == .failed(.relaunch))
        // The place is never empty: it holds the new app, whole, and the new app tells when it is started.
        #expect(bodyOfApp(at: world.bundle) == "new")
        #expect(versionOfApp(at: world.bundle) == "0.8.0")
        #expect(world.notice.pendingVersion == VersionNumber(0, 8, 0))
        #expect(world.names(in: world.apps) == ["CUABar.app"])
    }

    @Test func theTwoPlacesNeverStandEmptyInTheOneStepTheyChange() throws {
        let home = try TempHome()
        defer { home.remove() }
        let first = home.url.appendingPathComponent("A.app")
        let second = home.url.appendingPathComponent("B.app")
        try makeApp(at: first, version: "1.0.0", body: "first")
        try makeApp(at: second, version: "2.0.0", body: "second")
        try AtomicSwap.exchange(first, second)
        #expect(bodyOfApp(at: first) == "second")
        #expect(bodyOfApp(at: second) == "first")
        try AtomicSwap.exchange(first, second)
        #expect(bodyOfApp(at: first) == "first")
        // Nothing to exchange with: it fails and the one that is there is as it was.
        #expect(throws: (any Error).self) { try AtomicSwap.exchange(first, home.url.appendingPathComponent("missing.app")) }
        #expect(bodyOfApp(at: first) == "first")
    }

    // MARK: The moment

    @Test func ifTheMomentPassedWhileFetchingNothingIsReplacedAndNothingIsLeft() async throws {
        let world = try world()
        defer { world.remove() }
        #expect(await world.installer.install(world.offer) { false } == .deferred)
        #expect(world.oldAppIsInPlace)
        #expect(world.swaps.swaps == 0)
        #expect(world.nothingIsLeftBehind)
        #expect(world.launcher.launches.isEmpty)
        #expect(world.notice.pendingVersion == nil)
        #expect(world.commands.contains("hdiutil detach"))
    }

    @MainActor @Test func theMomentIsAskedAgainOnceRightBeforeTheReplacing() async throws {
        let world = try world()
        defer { world.remove() }
        let asked = Asked()
        _ = await world.installer.install(world.offer) {
            asked.count += 1
            return true
        }
        #expect(asked.count == 1)
    }

    @MainActor final class Asked { var count = 0 }

    // MARK: After the update, without waiting for anything

    @Test func anImageThatNeverLetGoIsNotWaitedForOnceTheAppIsReplaced() async throws {
        let world = try world()
        defer { world.remove() }
        world.behavior.set { $0.detachFails = true }
        #expect(await world.installer.install(world.offer) { true } == .replaced)
        // The two tries before the checking were all: the end of the update does not ask `hdiutil` again.
        #expect(world.runner.calls.filter { $0.arguments.first == "detach" }.count == 2)
        #expect(bodyOfApp(at: world.bundle) == "new")
    }

    // MARK: What a run that was cut short left

    @Test func theNextRunTakesAwayTheCopiesAndTheMountsAnEarlierRunLeft() async throws {
        let world = try world()
        defer { world.remove() }
        // A copy of the new app beside the running one, from a run that was quit halfway.
        try makeApp(
            at: world.apps.appendingPathComponent(".CUABar-update.OLD111").appendingPathComponent("CUABar.app"), version: "0.8.0", body: "half")
        // The folder of an update that may hold the only copy of an old app.
        try makeApp(
            at: world.apps.appendingPathComponent(".CUABar-update.OLD222").appendingPathComponent("Previous.app"), version: "0.6.0", body: "keep")
        // Something else that is hidden in the folder, and an app of someone else: not ours to touch.
        try world.home.write("x", to: world.apps.appendingPathComponent(".something-else"))
        try makeApp(at: world.apps.appendingPathComponent("Other.app"), version: "1.0.0", body: "other")
        // An image still mounted in the temporary folder of that run, and its folder with nothing in it.
        let mounted = world.scratch.appendingPathComponent("cua-bar-update-OLD333/mnt")
        try makeApp(at: mounted.appendingPathComponent("CUABar.app"), version: "0.8.0", body: "mounted")
        try FileManager.default.createDirectory(
            at: world.scratch.appendingPathComponent("cua-bar-update-OLD444/mnt"), withIntermediateDirectories: true)
        // Not made by this app.
        try world.home.write("y", to: world.scratch.appendingPathComponent("someone-elses-file"))

        #expect(await world.installer.install(world.offer) { true } == .replaced)
        #expect(world.names(in: world.apps) == [".CUABar-update.OLD222", ".something-else", "CUABar.app", "Other.app"])
        #expect(world.names(in: world.scratch) == ["someone-elses-file"])
        // (The folder listing may spell the temporary folder's path with /private in front.)
        #expect(
            world.runner.calls.contains { $0.arguments.first == "detach" && $0.arguments.last?.hasSuffix("/cua-bar-update-OLD333/mnt") == true },
            "the image is let go of before its folder goes")
    }

    @Test func aMountThatCannotBeLetGoOfIsLeftAloneInsteadOfBeingDeletedAround() async throws {
        let world = try world()
        defer { world.remove() }
        world.behavior.set { $0.detachFails = true }
        let mounted = world.scratch.appendingPathComponent("cua-bar-update-OLD333/mnt")
        try makeApp(at: mounted.appendingPathComponent("CUABar.app"), version: "0.8.0", body: "mounted")
        _ = await world.installer.install(world.offer) { true }
        #expect(bodyOfApp(at: mounted.appendingPathComponent("CUABar.app")) == "mounted")
    }

    // MARK: Small things

    @Test func onlyAnInstalledCUABarAppIsAnAppThatCanReplaceItself() throws {
        let home = try TempHome()
        defer { home.remove() }
        let app = home.url.appendingPathComponent("CUABar.app")
        try makeApp(at: app, version: "0.7.0", body: "x")
        #expect(UpdateSource.runningBundle(of: try #require(Bundle(url: app)))?.lastPathComponent == "CUABar.app")
        // An app of someone else, and a build run from a folder (swift run, the test runner): nothing to replace.
        let other = home.url.appendingPathComponent("Other.app")
        try makeApp(at: other, version: "1.0.0", identifier: "com.example.other", body: "x")
        #expect(UpdateSource.runningBundle(of: try #require(Bundle(url: other))) == nil)
        let folder = home.url.appendingPathComponent("debug", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        #expect(UpdateSource.runningBundle(of: try #require(Bundle(url: folder))) == nil)
    }

    @Test func aBackupNameIsADateAndATimeAndNothingElse() {
        for name in ["20261021-163905", "19990101-000000"] { #expect(UpdateInstaller.isStamp(name)) }
        for name in ["20261021163905", "20261021-16390", "20261021-1639051", "2026102a-163905", "notes.txt", "", ".DS_Store", "20261021_163905"] {
            #expect(!UpdateInstaller.isStamp(name), "\(name)")
        }
    }

    @Test func theSHA256IsTheOneShasumPrints() throws {
        let home = try TempHome()
        defer { home.remove() }
        let file = home.url.appendingPathComponent("abc")
        try home.write("abc", to: file)
        #expect(UpdateInstaller.sha256(of: file) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        #expect(UpdateInstaller.sha256(of: home.url.appendingPathComponent("missing")) == nil)
    }

    // MARK: The helper, really run

    private func openStandIn(in home: TempHome) throws -> (stub: URL, log: URL) {
        let log = home.url.appendingPathComponent("opened.log")
        let stub = home.url.appendingPathComponent("open-stand-in.sh")
        try home.write("#!/bin/sh\necho \"$@\" >> \"\(log.path)\"\n", to: stub)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: stub.path)
        return (stub, log)
    }

    @Test func theHelperWaitsLongEnoughForTheOldProcessAndThenAPauseBeforeOpening() {
        #expect(RelaunchHelper.waitLimit == 600, "ten minutes: a helper that gave up leaves no app")
        #expect(RelaunchHelper.settle == 1)
        #expect(RelaunchHelper.script.contains("-gt 6000"), "a tenth of a second at a time")
        #expect(RelaunchHelper.script.contains("sleep 1\n"))
    }

    /// The helper is the one part that cannot be tried by replacing the app of this Mac: it runs, for real, with a
    /// stand-in for `open` that writes its words down and a process that lives until the test lets it go.
    @Test func theHelperWaitsForTheProcessToEndThenPausesAndOpensTheAppInTheBackgroundOnce() async throws {
        let home = try TempHome()
        defer { home.remove() }
        let (stub, log) = try openStandIn(in: home)

        // `cat` lives until its input is closed.
        let input = Pipe()
        let living = Process()
        living.executableURL = URL(fileURLWithPath: "/bin/cat")
        living.standardInput = input
        living.standardOutput = FileHandle.nullDevice
        try living.run()
        let helper = Process()
        helper.executableURL = RelaunchHelper.shell
        helper.arguments = RelaunchHelper.arguments(
            waitingFor: living.processIdentifier, opening: URL(fileURLWithPath: "/Applications/Some App.app"), opener: stub.path)
        try helper.run()

        try await Task.sleep(for: .milliseconds(400))
        #expect(helper.isRunning)
        #expect(!FileManager.default.fileExists(atPath: log.path), "nothing is opened while the old process lives")
        try input.fileHandleForWriting.close()
        living.waitUntilExit()
        // The old process is gone; the helper pauses before it opens anything.
        try await Task.sleep(for: .milliseconds(400))
        #expect(!FileManager.default.fileExists(atPath: log.path), "the system gets a moment to forget the old one")
        helper.waitUntilExit()
        #expect(helper.terminationStatus == 0)
        let written = try String(contentsOf: log, encoding: .utf8)
        #expect(written == "-g /Applications/Some App.app\n", "once, in the background, with the path as one word")
    }

    @Test func theHelperOfAProcessThatIsAlreadyGoneOpensAfterTheSamePause() async throws {
        let home = try TempHome()
        defer { home.remove() }
        let (stub, log) = try openStandIn(in: home)
        let gone = Process()
        gone.executableURL = URL(fileURLWithPath: "/usr/bin/true")
        try gone.run()
        gone.waitUntilExit()
        let helper = Process()
        helper.executableURL = RelaunchHelper.shell
        helper.arguments = RelaunchHelper.arguments(waitingFor: gone.processIdentifier, opening: URL(fileURLWithPath: "/x/CUABar.app"), opener: stub.path)
        try helper.run()
        helper.waitUntilExit()
        #expect(try String(contentsOf: log, encoding: .utf8) == "-g /x/CUABar.app\n")
    }
}
