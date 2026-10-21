import Foundation
import Security
import Testing
@testable import cua_bar

/// What the real `codesign` and the Security framework say, on files made in a throwaway folder: nothing is downloaded,
/// mounted or installed, and no certificate is needed (an ad hoc signature is made on the spot, as `build-app.sh` makes
/// one for a local build).
struct UpdateSignatureTests {
    private func run(_ arguments: [String], tool: String = "/usr/bin/codesign") async throws -> ProcessOutput {
        try await SystemProcessRunner().run(URL(fileURLWithPath: tool), arguments: arguments, timeout: .seconds(120))
    }

    /// An app bundle signed ad hoc as CUA Bar. `executable` is the name of its main file.
    private func adHocApp(in home: TempHome, executable: String = "cua-bar") async throws -> URL {
        let app = home.url.appendingPathComponent("CUABar.app", isDirectory: true)
        let macOS = app.appendingPathComponent("Contents/MacOS", isDirectory: true)
        try FileManager.default.createDirectory(at: macOS, withIntermediateDirectories: true)
        // Any real program will do for a main file; this one is on every Mac.
        try FileManager.default.copyItem(at: URL(fileURLWithPath: "/usr/bin/true"), to: macOS.appendingPathComponent(executable))
        let info: [String: Any] = [
            "CFBundleExecutable": executable, "CFBundleIdentifier": "dev.chenjing.cua-bar", "CFBundleShortVersionString": "0.8.0",
            "CFBundlePackageType": "APPL",
        ]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
            .write(to: app.appendingPathComponent("Contents/Info.plist"))
        let signed = try await run(["--force", "--sign", "-", app.path])
        try #require(signed.exitCode == 0)
        return app
    }

    @Test func anAdHocAppPassesThePlainVerificationButNotTheRequirement() async throws {
        let home = try TempHome()
        defer { home.remove() }
        let app = try await adHocApp(in: home)
        // What the first version relied on: a whole signature of anybody's is a good one.
        #expect(try await run(["--verify", "--deep", "--strict", app.path]).exitCode == 0)
        // What the update asks instead. 3 is "signed, but not as the requirement says"; a requirement that did not parse
        // would be 1, and an app of the developer's own could not be updated at all.
        let checked = try await run(UpdateInstaller.verification(of: app, requirement: UpdateSource.appRequirement, deep: true))
        #expect(checked.exitCode == 3, "\(String(decoding: checked.stderr, as: UTF8.self))")
    }

    @Test func aTeamLineForgedInTheExecutableNameDecidesNothing() async throws {
        let home = try TempHome()
        defer { home.remove() }
        // A main file whose name carries a line break and a team line of its own.
        let app = try await adHocApp(in: home, executable: "x\nTeamIdentifier=S3KC8R8VDL")
        // Read the way the first version read it (the first such line), this ad hoc app is the developer's: the forged
        // line comes before the real one, `TeamIdentifier=not set`.
        let printed = try await run(["-dv", app.path])
        let lines = String(decoding: printed.stderr, as: UTF8.self).split(whereSeparator: \.isNewline).map(String.init)
        #expect(lines.first { $0.hasPrefix("TeamIdentifier=") } == "TeamIdentifier=S3KC8R8VDL", "the forgery works on a reader of the text")
        #expect(lines.contains("Signature=adhoc"))
        // Asked as the update asks, the system looks at the signature and not at the text.
        #expect(try await run(["--verify", "--deep", "--strict", app.path]).exitCode == 0)
        #expect(try await run(UpdateInstaller.verification(of: app, requirement: UpdateSource.appRequirement, deep: true)).exitCode == 3)
    }

    @Test func aDiskImageThatIsNotTheDevelopersIsRefusedBeforeItCouldBeMounted() async throws {
        let home = try TempHome()
        defer { home.remove() }
        let content = home.url.appendingPathComponent("content", isDirectory: true)
        try home.write("x", to: content.appendingPathComponent("file"))
        let image = home.url.appendingPathComponent("CUABar-v0.8.0-macos-arm64.dmg")
        let made = try await run(["create", "-quiet", "-volname", "T", "-srcfolder", content.path, "-format", "UDZO", "-ov", image.path], tool: "/usr/bin/hdiutil")
        try #require(made.exitCode == 0)
        let check = UpdateInstaller.verification(of: image, requirement: UpdateSource.imageRequirement, deep: false)
        // Not signed at all.
        #expect(try await run(check).exitCode == 1)
        // Signed ad hoc: whole, and anybody's.
        try #require(try await run(["--force", "--sign", "-", image.path]).exitCode == 0)
        #expect(try await run(["--verify", "--strict", image.path]).exitCode == 0)
        #expect(try await run(check).exitCode == 3)
    }

    @Test func theArgumentsAskForTheRequirementAsTextAndDeepOnlyForAnApp() {
        let app = URL(fileURLWithPath: "/x/CUABar.app")
        #expect(UpdateInstaller.verification(of: app, requirement: "anchor apple", deep: true) == ["--verify", "--deep", "--strict", "-R", "=anchor apple", "/x/CUABar.app"])
        #expect(UpdateInstaller.verification(of: app, requirement: "anchor apple", deep: false) == ["--verify", "--strict", "-R", "=anchor apple", "/x/CUABar.app"])
    }

    // MARK: The running process

    @Test func theTestRunnerIsNotTheOfficialBuild() {
        #expect(!OfficialBuild.runningProcessIsOfficial())
    }

    @Test func aRequirementThatDoesNotParseIsNotSatisfied() {
        #expect(!OfficialBuild.runningProcessSatisfies("this is not a requirement"))
        #expect(!OfficialBuild.runningProcessSatisfies(""))
    }

    @Test func theCheckCanSayYesForARequirementTheProcessDoesSatisfy() throws {
        // Its own name, as it is signed with (every program on this Mac carries at least an ad hoc signature).
        var code: SecCode?
        try #require(SecCodeCopySelf(SecCSFlags(), &code) == errSecSuccess)
        var staticCode: SecStaticCode?
        try #require(SecCodeCopyStaticCode(try #require(code), SecCSFlags(), &staticCode) == errSecSuccess)
        var information: CFDictionary?
        try #require(SecCodeCopySigningInformation(try #require(staticCode), SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess)
        let identifier = try #require((information as? [String: Any])?[kSecCodeInfoIdentifier as String] as? String)
        #expect(OfficialBuild.runningProcessSatisfies(#"identifier "\#(identifier)""#))
        #expect(!OfficialBuild.runningProcessSatisfies(#"identifier "\#(identifier).not-me""#))
    }

    @Test func onlyTheOfficialBuildOfTheAppMayReplaceItself() throws {
        let home = try TempHome()
        defer { home.remove() }
        let app = home.url.appendingPathComponent("CUABar.app")
        try makeApp(at: app, version: "0.8.0", body: "x")
        let bundle = try #require(Bundle(url: app))
        #expect(UpdateSource.replaceableBundle(of: bundle, isOfficialBuild: { true })?.lastPathComponent == "CUABar.app")
        // A local build, signed ad hoc: like a development build, it looks for nothing and replaces nothing.
        #expect(UpdateSource.replaceableBundle(of: bundle, isOfficialBuild: { false }) == nil)
        // Official, but not CUA Bar's app bundle.
        let other = home.url.appendingPathComponent("Other.app")
        try makeApp(at: other, version: "1.0.0", identifier: "com.example.other", body: "x")
        #expect(UpdateSource.replaceableBundle(of: try #require(Bundle(url: other)), isOfficialBuild: { true }) == nil)
        let folder = home.url.appendingPathComponent("debug", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        #expect(UpdateSource.replaceableBundle(of: try #require(Bundle(url: folder)), isOfficialBuild: { true }) == nil)
    }

    @Test func theOfficialQuestionIsNotAskedOfAProcessThatIsNoAppAtAll() throws {
        let home = try TempHome()
        defer { home.remove() }
        let folder = home.url.appendingPathComponent("debug", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let asked = AskedBox()
        _ = UpdateSource.replaceableBundle(of: try #require(Bundle(url: folder)), isOfficialBuild: {
            asked.count += 1
            return true
        })
        #expect(asked.count == 0)
    }

    final class AskedBox: @unchecked Sendable { var count = 0 }
}
