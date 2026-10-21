import Foundation
import Testing
@testable import cua_bar

/// The update from the file to the replaced app, over a throwaway home: real folders and real moves, but the
/// download, `hdiutil`, `ditto` and `codesign` are stand-ins (nothing reaches the network, mounts an image or signs).
struct UpdateInstallerTests {
    /// What the pretend commands do.
    final class Behavior: @unchecked Sendable {
        struct Values: Sendable {
            var attachFails = false
            var appInImage = true
            var imageVersion = "0.8.0"
            var imageIdentifier = "dev.chenjing.cua-bar"
            var verifyFails = false
            var team = "S3KC8R8VDL"
            var plainDetachFails = false
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
        var moves: MoveScript
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

    func world(failingMoves: Set<Int> = [], image: Data = Data("pretend disk image".utf8)) throws -> World {
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
                if values.plainDetachFails, !call.arguments.contains("-force") { return StepRunner.failed() }
                // Unmounting: what the image showed there is gone.
                let mount = URL(fileURLWithPath: call.arguments.last!, isDirectory: true)
                for entry in (try? FileManager.default.contentsOfDirectory(atPath: mount.path)) ?? [] {
                    try? FileManager.default.removeItem(at: mount.appendingPathComponent(entry))
                }
                return StepRunner.ok()
            case ("/usr/bin/codesign", "--verify"?):
                return values.verifyFails ? StepRunner.failed(code: 1) : StepRunner.ok()
            case ("/usr/bin/codesign", "-dv"?):
                let text = "Executable=/x/CUABar.app/Contents/MacOS/cua-bar\nIdentifier=dev.chenjing.cua-bar\nTeamIdentifier=\(values.team)\n"
                return ProcessOutput(exitCode: 0, stdout: Data(), stderr: Data(text.utf8))
            default:
                return StepRunner.ok()
            }
        }
        let transport = FakeTransport(image: image)
        let launcher = FakeLauncher()
        let notice = UpdateNotice(home: home.url)
        let moves = MoveScript(failing: failingMoves)
        let installer = UpdateInstaller(
            transport: transport, runner: runner, launcher: launcher, bundleURL: bundle, processID: 4242, home: home.url, notice: notice,
            now: { Date(timeIntervalSince1970: 1_792_324_800) }, moveItem: moves.move, temporaryDirectory: scratch)
        return World(
            home: home, apps: apps, bundle: bundle, scratch: scratch, transport: transport, runner: runner, launcher: launcher,
            behavior: behavior, notice: notice, offer: offer, moves: moves, installer: installer)
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
        #expect(world.commands == ["hdiutil attach", "ditto", "hdiutil detach", "codesign --verify", "codesign -dv"])
        let attach = try #require(calls.first)
        let mount = try #require(attach.arguments.firstIndex(of: "-mountpoint").map { attach.arguments[$0 + 1] })
        #expect(attach.executable == "/usr/bin/hdiutil")
        #expect(attach.arguments.dropLast() == ["attach", "-nobrowse", "-noautoopen", "-readonly", "-mountpoint", mount])
        #expect(attach.arguments.last?.hasSuffix("/CUABar-v0.8.0-macos-arm64.dmg") == true)
        #expect(mount.hasPrefix(world.scratch.path), "the image is mounted in the temporary folder, not in /Volumes")
        let ditto = calls[1]
        #expect(ditto.executable == "/usr/bin/ditto")
        #expect(ditto.arguments.first == mount + "/CUABar.app")
        // Beside the running app, in a folder of its own, so that the last step is a rename on the same disk.
        let staged = try #require(ditto.arguments.last)
        #expect(staged.hasPrefix(world.apps.path + "/.CUABar-update."))
        #expect(staged.hasSuffix("/CUABar.app"))
        #expect(calls[2].arguments == ["detach", mount])
        #expect(calls[3].arguments == ["--verify", "--deep", "--strict", staged])
        #expect(calls[4].executable == "/usr/bin/codesign")
        #expect(calls[4].arguments == ["-dv", staged])
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

    @Test func aSignatureThatDoesNotVerifyStopsAndLeavesTheAppAsItWas() async throws {
        let world = try world()
        defer { world.remove() }
        world.behavior.set { $0.verifyFails = true }
        #expect(await world.installer.install(world.offer) { true } == .failed(.signature))
        #expect(world.oldAppIsInPlace)
        #expect(world.nothingIsLeftBehind)
        #expect(world.launcher.launches.isEmpty)
        #expect(world.notice.pendingVersion == nil)
    }

    @Test(arguments: ["ABCDE12345", "not set", "", "s3kc8r8vdl", "S3KC8R8VDLX"])
    func anAppOfAnotherTeamIsRefusedAndTheOriginalStays(team: String) async throws {
        let world = try world()
        defer { world.remove() }
        world.behavior.set { $0.team = team }
        #expect(await world.installer.install(world.offer) { true } == .failed(.team))
        #expect(world.oldAppIsInPlace)
        #expect(world.nothingIsLeftBehind)
        #expect(world.launcher.launches.isEmpty)
        #expect(world.moves.moves == 0, "the running app was not even moved")
        #expect(world.notice.pendingVersion == nil)
    }

    @Test func aCopyWhoseVersionIsNotTheOneMeantIsRefused() async throws {
        let world = try world()
        defer { world.remove() }
        // An older app under the newer name: the signature and the team are right, the version is not.
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

    @Test func aSecondMoveThatFailsPutsTheOldAppBackAndTakesTheMarkAway() async throws {
        let world = try world(failingMoves: [2])
        defer { world.remove() }
        #expect(await world.installer.install(world.offer) { true } == .failed(.replace))
        #expect(world.oldAppIsInPlace, "the first move is undone")
        #expect(world.moves.moves == 3, "the old app away, the new one in (failed), the old one back")
        #expect(world.nothingIsLeftBehind)
        #expect(world.launcher.launches.isEmpty)
        #expect(world.notice.pendingVersion == nil)
        #expect(!FileManager.default.fileExists(atPath: world.backups.path), "no backup of an app that was never replaced")
    }

    @Test func aFirstMoveThatFailsChangesNothing() async throws {
        let world = try world(failingMoves: [1])
        defer { world.remove() }
        #expect(await world.installer.install(world.offer) { true } == .failed(.replace))
        #expect(world.oldAppIsInPlace)
        #expect(world.moves.moves == 1)
        #expect(world.nothingIsLeftBehind)
        #expect(world.notice.pendingVersion == nil)
    }

    @Test func ifTheOldAppCannotGoBackItStaysInTheStagingFolderInsteadOfBeingDeleted() async throws {
        let world = try world(failingMoves: [2, 3])
        defer { world.remove() }
        #expect(await world.installer.install(world.offer) { true } == .failed(.replace))
        let leftovers = world.names(in: world.apps).filter { $0.hasPrefix(".CUABar-update.") }
        let staging = try #require(leftovers.first)
        let kept = world.apps.appendingPathComponent(staging).appendingPathComponent("Previous.app")
        #expect(bodyOfApp(at: kept) == "old", "the only copy of the old app is not thrown away")
    }

    @Test func aHelperThatCannotBeStartedUndoesTheReplacing() async throws {
        let world = try world()
        defer { world.remove() }
        world.launcher.fails = true
        #expect(await world.installer.install(world.offer) { true } == .failed(.relaunch))
        #expect(world.oldAppIsInPlace, "an app nobody would open again is not left in the old one's place")
        #expect(world.nothingIsLeftBehind)
        #expect(world.notice.pendingVersion == nil)
        #expect(!FileManager.default.fileExists(atPath: world.backups.path))
    }

    // MARK: The moment

    @Test func ifTheMomentPassedWhileFetchingNothingIsReplacedAndNothingIsLeft() async throws {
        let world = try world()
        defer { world.remove() }
        #expect(await world.installer.install(world.offer) { false } == .deferred)
        #expect(world.oldAppIsInPlace)
        #expect(world.moves.moves == 0)
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

    @Test func theTeamIsTheLineCodesignPrintsOnItsErrorOutput() {
        let output = ProcessOutput(
            exitCode: 0, stdout: Data(),
            stderr: Data("Executable=/x\nIdentifier=dev.chenjing.cua-bar\nFormat=app bundle with Mach-O thin (arm64)\nTeamIdentifier=S3KC8R8VDL\nSealed Resources version=2\n".utf8))
        #expect(UpdateInstaller.teamIdentifier(in: output) == "S3KC8R8VDL")
        let adHoc = ProcessOutput(exitCode: 0, stdout: Data(), stderr: Data("Signature=adhoc\nTeamIdentifier=not set\n".utf8))
        #expect(UpdateInstaller.teamIdentifier(in: adHoc) == "not set")
        #expect(UpdateInstaller.teamIdentifier(in: ProcessOutput(exitCode: 0, stdout: Data(), stderr: Data("nothing\n".utf8))) == nil)
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

    /// The helper is the one part that cannot be tried by replacing the app of this Mac: it runs, for real, with a
    /// stand-in for `open` that writes its words down and a process that lives until the test lets it go.
    @Test func theHelperWaitsForTheProcessToEndAndThenOpensTheAppInTheBackgroundOnce() async throws {
        let home = try TempHome()
        defer { home.remove() }
        let log = home.url.appendingPathComponent("opened.log")
        let stub = home.url.appendingPathComponent("open-stand-in.sh")
        try home.write("#!/bin/sh\necho \"$@\" >> \"\(log.path)\"\n", to: stub)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: stub.path)

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
        helper.waitUntilExit()
        #expect(helper.terminationStatus == 0)
        let written = try String(contentsOf: log, encoding: .utf8)
        #expect(written == "-g /Applications/Some App.app\n", "once, in the background, with the path as one word")
    }

    @Test func theHelperOfAProcessThatIsAlreadyGoneOpensAtOnce() async throws {
        let home = try TempHome()
        defer { home.remove() }
        let log = home.url.appendingPathComponent("opened.log")
        let stub = home.url.appendingPathComponent("open-stand-in.sh")
        try home.write("#!/bin/sh\necho \"$@\" >> \"\(log.path)\"\n", to: stub)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: stub.path)
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
