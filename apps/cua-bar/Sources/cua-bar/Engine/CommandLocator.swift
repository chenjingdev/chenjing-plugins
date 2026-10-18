import Foundation

enum CommandLocation: Equatable, Sendable {
    /// `~/.local/bin/codex-cua`, ours.
    case ready(URL)
    /// The plugin is installed but its command has not been set up yet.
    case installedNotSetUp(installPath: URL)
    case pluginMissing
}

/// "Finding the command" from the contract:
/// 1. `~/.local/bin/codex-cua` exists and its first 3 lines contain the authored-command marker;
/// 2. otherwise the plugin is installed (`installed_plugins.json`, the `scope: user` record of
///    `cua@chenjing-plugins`) but not set up;
/// 3. otherwise the plugin is not installed.
struct CommandLocator: Sendable {
    static let marker = "# codex-cua authored command v1"
    static let pluginID = "cua@chenjing-plugins"

    var home: URL

    init(home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        self.home = home
    }

    var commandURL: URL { home.appendingPathComponent(".local/bin/codex-cua") }

    var registryURL: URL { home.appendingPathComponent(".claude/plugins/installed_plugins.json") }

    func locate() -> CommandLocation {
        if hasMarker(at: commandURL) { return .ready(commandURL) }
        if let path = installedPluginPath() {
            // A registry entry whose folder is gone is not an installed plugin.
            if FileManager.default.fileExists(atPath: path.appendingPathComponent("setup.sh").path) {
                return .installedNotSetUp(installPath: path)
            }
        }
        return .pluginMissing
    }

    private func hasMarker(at url: URL) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? handle.close() }
        guard let head = try? handle.read(upToCount: 2048) else { return false }
        let lines = String(decoding: head, as: UTF8.self).split(separator: "\n", maxSplits: 3, omittingEmptySubsequences: false).prefix(3)
        return lines.contains { $0.contains(Self.marker) }
    }

    private func installedPluginPath() -> URL? {
        guard
            let data = try? Data(contentsOf: registryURL),
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let plugins = root["plugins"] as? [String: Any],
            let records = plugins[Self.pluginID] as? [[String: Any]]
        else { return nil }
        let userRecord = records.first { ($0["scope"] as? String) == "user" && ($0["installPath"] as? String)?.isEmpty == false }
        return (userRecord?["installPath"] as? String).map { URL(fileURLWithPath: $0, isDirectory: true) }
    }
}
