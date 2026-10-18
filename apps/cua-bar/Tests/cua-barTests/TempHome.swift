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

    /// Registers the plugin the way Claude Code does and creates its folder with a `setup.sh`.
    @discardableResult
    func installPlugin(scope: String = "user", createFolder: Bool = true) throws -> URL {
        let install = url.appendingPathComponent(".claude/plugins/cache/chenjing-plugins/cua/0.7.0", isDirectory: true)
        if createFolder { try write("#!/bin/sh\nexit 0\n", to: install.appendingPathComponent("setup.sh")) }
        let registry = """
        {"version": 2, "plugins": {"cua@chenjing-plugins": [{"scope": "\(scope)", "installPath": "\(install.path)", "version": "0.7.0"}]}}
        """
        try write(registry, to: url.appendingPathComponent(".claude/plugins/installed_plugins.json"))
        return install
    }

    func write(_ text: String, to file: URL) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: file)
    }
}
