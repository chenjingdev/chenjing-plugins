import Foundation
import Testing
@testable import cua_bar

struct ClaudeCLILocatorTests {
    private let home = URL(fileURLWithPath: "/Users/someone", isDirectory: true)

    private func locator(existing: Set<String>) -> ClaudeCLILocator {
        ClaudeCLILocator(home: home, isExecutableFile: { existing.contains($0) })
    }

    @Test func theFourPlacesAreAskedInOrder() {
        #expect(locator(existing: []).candidates == [
            "/Users/someone/.local/bin/claude",
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude",
            "/Users/someone/.claude/local/claude",
        ])
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
