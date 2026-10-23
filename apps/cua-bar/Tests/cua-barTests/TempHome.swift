import Foundation

/// A throwaway home folder so nothing in these tests touches the real `~/.local/bin/codex-cua`,
/// `~/.local/share/codex-cua`, `~/.claude.json` or `~/.claude/`.
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

    // MARK: The engine

    /// The folder the engine copies live in.
    var engineCopies: URL { url.appendingPathComponent(".local/share/codex-cua/engine", isDirectory: true) }

    /// The one launcher Claude Code's MCP server is registered with, whatever the engine's version.
    var launcher: String { engineCopies.appendingPathComponent("current/start-mcp.sh").path }

    /// An engine copy the way `install-engine` leaves one: `engine/<version>/` with its `setup.sh` and
    /// `start-mcp.sh`, and `source.json` binding it. A folder named after the version, so an update has a new path.
    @discardableResult
    func installEngine(version: String = "0.7.0", createFolder: Bool = true, bind: Bool = true) throws -> URL {
        let folder = engineCopies.appendingPathComponent(version, isDirectory: true)
        if createFolder {
            try write("#!/bin/sh\nexit 0\n", to: folder.appendingPathComponent("setup.sh"))
            try write("#!/bin/sh\nexit 0\n", to: folder.appendingPathComponent("start-mcp.sh"))
        }
        if bind {
            let binding = ["schema_version": 1, "plugin_id": "cua@chenjing-plugins", "source_root": folder.path] as [String: Any]
            try write(String(decoding: try JSONSerialization.data(withJSONObject: binding), as: UTF8.self),
                      to: url.appendingPathComponent(".local/share/codex-cua/source.json"))
        }
        return folder
    }

    // MARK: Claude Code

    /// The `claude` command, where `ClaudeCLILocator` looks first.
    var claudeCLI: URL { url.appendingPathComponent(".local/bin/claude") }

    /// A `claude` that is there (never run: the tests give the process runner a stand-in).
    func installClaudeCode() throws {
        try write("#!/bin/sh\nexit 0\n", to: claudeCLI)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: claudeCLI.path)
    }

    var claudeConfig: URL { url.appendingPathComponent(".claude.json") }

    /// `~/.claude.json` with other things in it, as a used Claude Code leaves it, and `cuabar` among the user's MCP servers.
    func addMcp(command: String, args: [String] = [], others: [String: Any] = [:], type: String = "stdio") throws {
        var servers = others
        servers["cuabar"] = ["type": type, "command": command, "args": args, "env": [String: String]()] as [String: Any]
        try writeClaudeConfig(["numStartups": 7, "projects": ["/x": ["history": []]], "mcpServers": servers])
    }

    func writeClaudeConfig(_ object: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: object)
        try write(String(decoding: data, as: UTF8.self), to: claudeConfig)
    }

    var skillFolder: URL { url.appendingPathComponent(".claude/skills/cuabar", isDirectory: true) }

    /// `~/.claude/skills/cuabar/` with a skill in it, and the app's mark when `version` is given.
    func addSkill(version: String?, body: String = "the skill\n") throws {
        try write(body, to: skillFolder.appendingPathComponent("SKILL.md"))
        if let version { try write(#"{"version": "\#(version)"}"#, to: skillFolder.appendingPathComponent(".cua-bar.json")) }
    }

    /// The old plugin as Claude Code records it.
    func addLegacyPlugin(scope: String = "user") throws {
        let install = url.appendingPathComponent(".claude/plugins/cache/chenjing-plugins/cua/0.7.0").path
        try write(
            #"{"version": 2, "plugins": {"cua@chenjing-plugins": [{"scope": "\#(scope)", "installPath": "\#(install)", "version": "0.7.0"}]}}"#,
            to: url.appendingPathComponent(".claude/plugins/installed_plugins.json"))
    }

    func write(_ text: String, to file: URL) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: file)
    }
}
