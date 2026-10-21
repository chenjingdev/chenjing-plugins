import Foundation
import Testing
@testable import cua_bar

struct ClaudeCLILocatorTests {
    private let home = URL(fileURLWithPath: "/Users/someone", isDirectory: true)

    /// `nodeVersions` are the folders nvm holds under `~/.nvm/versions/node`.
    private func locator(existing: Set<String>, nodeVersions: [String] = []) -> ClaudeCLILocator {
        ClaudeCLILocator(
            home: home, isExecutableFile: { existing.contains($0) },
            namesInFolder: { $0 == "/Users/someone/.nvm/versions/node" ? nodeVersions : [] })
    }

    @Test func thePlacesAreAskedInOrder() {
        #expect(locator(existing: []).candidates == [
            "/Users/someone/.local/bin/claude",
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude",
            "/Users/someone/.claude/local/claude",
            "/Users/someone/.bun/bin/claude",
            "/Users/someone/.volta/bin/claude",
            "/Users/someone/.npm-global/bin/claude",
            "/Users/someone/Library/pnpm/claude",
        ])
    }

    @Test(arguments: [
        "/Users/someone/.bun/bin/claude", "/Users/someone/.volta/bin/claude", "/Users/someone/.npm-global/bin/claude",
        "/Users/someone/Library/pnpm/claude",
    ])
    func aClaudeThatAPackageManagerInstalledIsFound(path: String) {
        #expect(locator(existing: [path]).locate()?.path == path)
    }

    @Test func nvmsNodeVersionsAreAskedHighestFirstAsNumbers() {
        let versions = ["v9.0.0", "v20.11.1", "v22.1.0", "v20.9.0", "v18.20.4", "system", "v20.11.10"]
        #expect(locator(existing: [], nodeVersions: versions).nvmCandidates.map { $0.split(separator: "/").dropLast(2).last.map(String.init) ?? "" } == [
            "v22.1.0", "v20.11.10", "v20.11.1", "v20.9.0", "v18.20.4", "v9.0.0", "system",
        ])
        #expect(locator(existing: [], nodeVersions: ["v18.20.4"]).nvmCandidates == ["/Users/someone/.nvm/versions/node/v18.20.4/bin/claude"])
        #expect(locator(existing: [], nodeVersions: []).nvmCandidates.isEmpty)
    }

    @Test func aClaudeInsideNvmIsFoundAndTheHighestNodeWinsAmongThem() {
        let old = "/Users/someone/.nvm/versions/node/v18.20.4/bin/claude"
        let new = "/Users/someone/.nvm/versions/node/v22.1.0/bin/claude"
        #expect(locator(existing: [old], nodeVersions: ["v18.20.4", "v22.1.0"]).locate()?.path == old)
        #expect(locator(existing: [old, new], nodeVersions: ["v18.20.4", "v22.1.0"]).locate()?.path == new)
        // The fixed places come first.
        #expect(locator(existing: [new, "/usr/local/bin/claude"], nodeVersions: ["v22.1.0"]).locate()?.path == "/usr/local/bin/claude")
    }

    @Test func theNodeFoldersAreListedOnlyWhenNothingBeforeThemIsThere() {
        let listed = Presence(false)
        let first = ClaudeCLILocator(
            home: home, isExecutableFile: { $0 == "/opt/homebrew/bin/claude" }, namesInFolder: { _ in
                listed.isThere = true
                return []
            })
        #expect(first.locate()?.path == "/opt/homebrew/bin/claude")
        #expect(!listed.isThere)
        let none = ClaudeCLILocator(home: home, isExecutableFile: { _ in false }, namesInFolder: { _ in
            listed.isThere = true
            return []
        })
        #expect(none.locate() == nil)
        #expect(listed.isThere)
    }

    @Test func aFolderThatIsNotThereHoldsNoVersion() throws {
        let nowhere = FileManager.default.temporaryDirectory.appendingPathComponent("cua-bar-nowhere-\(UUID().uuidString)").path
        #expect(ClaudeCLILocator.namesInRealFolder(nowhere).isEmpty)
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("cua-bar-nvm-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("v20.1.0"), withIntermediateDirectories: true)
        #expect(ClaudeCLILocator.namesInRealFolder(folder.path) == ["v20.1.0"])
    }

    @Test func theFirstExistingOneWinsWhateverIsAfterIt() {
        let all = Set(locator(existing: []).candidates)
        #expect(locator(existing: all).locate()?.path == "/Users/someone/.local/bin/claude")
        #expect(locator(existing: all.subtracting(["/Users/someone/.local/bin/claude"])).locate()?.path == "/opt/homebrew/bin/claude")
        #expect(locator(existing: ["/usr/local/bin/claude", "/Users/someone/.claude/local/claude"]).locate()?.path == "/usr/local/bin/claude")
        #expect(locator(existing: ["/Users/someone/.claude/local/claude"]).locate()?.path == "/Users/someone/.claude/local/claude")
    }

    @Test func noneAtAllMeansNoClaudeCode() {
        #expect(locator(existing: []).locate() == nil)
        // A `claude` somewhere else on PATH is not looked for.
        #expect(locator(existing: ["/somewhere/else/claude"]).locate() == nil)
    }

    // MARK: The real check

    @Test func theRealCheckWantsAnExecutableRegularFile() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("cua-bar-claude-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let executable = folder.appendingPathComponent("executable")
        let plain = folder.appendingPathComponent("plain")
        let directory = folder.appendingPathComponent("directory", isDirectory: true)
        let link = folder.appendingPathComponent("link")
        let broken = folder.appendingPathComponent("broken")
        try Data("#!/bin/sh\n".utf8).write(to: executable)
        try Data("text".utf8).write(to: plain)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: plain.path)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: executable)
        try FileManager.default.createSymbolicLink(at: broken, withDestinationURL: folder.appendingPathComponent("nothing"))

        #expect(ClaudeCLILocator.isExecutableRegularFile(executable.path))
        #expect(ClaudeCLILocator.isExecutableRegularFile(link.path), "a link to the real file counts")
        #expect(!ClaudeCLILocator.isExecutableRegularFile(plain.path), "not executable")
        #expect(!ClaudeCLILocator.isExecutableRegularFile(directory.path), "a folder is executable but not a file")
        #expect(!ClaudeCLILocator.isExecutableRegularFile(broken.path))
        #expect(!ClaudeCLILocator.isExecutableRegularFile(folder.appendingPathComponent("missing").path))
    }

    @Test func theDefaultLocatorUsesTheRealCheckOnTheHomeItIsGiven() throws {
        let temp = try TempHome()
        defer { temp.remove() }
        let claude = temp.url.appendingPathComponent(".local/bin/claude")
        try temp.write("#!/bin/sh\n", to: claude)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: claude.path)
        let located = ClaudeCLILocator(home: temp.url).locate()
        // /opt/homebrew/bin/claude may exist on a machine with Claude Code, but ~/.local/bin comes first.
        #expect(located?.path == claude.path)
    }
}
