import Foundation

/// A throwaway home folder so nothing in these tests touches the real `~/.local/bin/codex-cua`.
struct TempHome {
    let url: URL

    init() throws {
        url = FileManager.default.temporaryDirectory.appendingPathComponent("cua-bar-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    func remove() { try? FileManager.default.removeItem(at: url) }

    var command: URL { url.appendingPathComponent(".local/bin/codex-cua") }

    @discardableResult
    func writeCommand(_ text: String = "#!/bin/sh\n# codex-cua authored command v1\nexit 0\n") throws -> URL {
        try write(text, to: command)
        return command
    }

    /// Registers the plugin the way Claude Code does and creates its folder with a `setup.sh`. The
    /// folder is named after the version, like Claude Code's cache, so an update has a new path.
    @discardableResult
    func installPlugin(scope: String = "user", createFolder: Bool = true, version: String? = "0.7.0") throws -> URL {
        let install = url.appendingPathComponent(".claude/plugins/cache/chenjing-plugins/cua/\(version ?? "unversioned")", isDirectory: true)
        if createFolder { try write("#!/bin/sh\nexit 0\n", to: install.appendingPathComponent("setup.sh")) }
        let versionField = version.map { ", \"version\": \"\($0)\"" } ?? ""
        let registry = """
        {"version": 2, "plugins": {"cua@chenjing-plugins": [{"scope": "\(scope)", "installPath": "\(install.path)"\(versionField)}]}}
        """
        try write(registry, to: url.appendingPathComponent(".claude/plugins/installed_plugins.json"))
        return install
    }

    /// `known_marketplaces.json` with a marketplace of that name in it, the way Claude Code writes it:
    /// an object keyed by marketplace name.
    func addMarketplace(_ name: String = "chenjing-plugins") throws {
        let text = """
        {"\(name)": {"source": {"source": "github", "repo": "chenjingdev/chenjing-plugins"}, "installLocation": "/x/\(name)", "lastUpdated": "2026-10-18T00:00:00.000Z", "autoUpdate": true}}
        """
        try write(text, to: url.appendingPathComponent(".claude/plugins/known_marketplaces.json"))
    }

    /// What a setup leaves behind and the plugin's remover reads first: `~/.local/share/codex-cua/source.json`.
    func addSupportInstallation() throws {
        try write(#"{"plugin_id": "cua@chenjing-plugins"}"#, to: url.appendingPathComponent(".local/share/codex-cua/source.json"))
    }

    func write(_ text: String, to file: URL) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: file)
    }
}
