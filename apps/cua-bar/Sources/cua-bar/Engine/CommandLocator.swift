import Foundation

enum CommandLocation: Equatable, Sendable {
    /// `~/.local/bin/codex-cua`, ours.
    case ready(URL)
    /// The plugin is installed but its command has not been set up yet.
    case installedNotSetUp(installPath: URL)
    case pluginMissing
}

/// The plugin as Claude Code registered it: the `scope: user` record of `cua@chenjing-plugins`
/// in `installed_plugins.json`.
struct RegisteredPlugin: Equatable, Sendable {
    var installPath: URL
    /// The record's `version`; nil when it has none. The app compares this with its own.
    var version: String?

    /// The plugin's own installer, `<installPath>/setup.sh`.
    var setupScript: URL { installPath.appendingPathComponent("setup.sh") }
}

/// "Finding the command" from the contract:
/// 1. `~/.local/bin/codex-cua` exists and its first 3 lines contain the authored-command marker;
/// 2. otherwise the plugin is installed (`installed_plugins.json`, the `scope: user` record of
///    `cua@chenjing-plugins`) but not set up;
/// 3. otherwise the plugin is not installed.
///
/// It also reads what Claude Code registered, whatever state the command is in, because the
/// app needs the registered version to tell an old plugin from a broken one.
struct CommandLocator: Sendable {
    static let marker = "# codex-cua authored command v1"
    static let pluginID = "cua@chenjing-plugins"
    static let marketplaceName = "chenjing-plugins"

    var home: URL

    init(home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        self.home = home
    }

    var commandURL: URL { home.appendingPathComponent(".local/bin/codex-cua") }

    var registryURL: URL { home.appendingPathComponent(".claude/plugins/installed_plugins.json") }

    var marketplacesURL: URL { home.appendingPathComponent(".claude/plugins/known_marketplaces.json") }

    func locate() -> CommandLocation {
        if hasMarker(at: commandURL) { return .ready(commandURL) }
        if let plugin = registeredPlugin() {
            // A registry entry whose folder is gone is not an installed plugin.
            if FileManager.default.fileExists(atPath: plugin.setupScript.path) {
                return .installedNotSetUp(installPath: plugin.installPath)
            }
        }
        return .pluginMissing
    }

    /// The registered plugin and its version, or nil when there is no usable record.
    func registeredPlugin() -> RegisteredPlugin? {
        guard
            let data = try? Data(contentsOf: registryURL),
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let plugins = root["plugins"] as? [String: Any],
            let records = plugins[Self.pluginID] as? [[String: Any]]
        else { return nil }
        let userRecord = records.first { ($0["scope"] as? String) == "user" && ($0["installPath"] as? String)?.isEmpty == false }
        guard let record = userRecord, let path = record["installPath"] as? String else { return nil }
        let version = (record["version"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return RegisteredPlugin(
            installPath: URL(fileURLWithPath: path, isDirectory: true),
            version: version?.isEmpty == false ? version : nil)
    }

    /// Whether Claude Code already knows the marketplace, from `known_marketplaces.json`. The name
    /// is looked for as a key at any depth, so the file's exact layout does not matter.
    func knowsMarketplace(named name: String = CommandLocator.marketplaceName) -> Bool {
        guard
            let data = try? Data(contentsOf: marketplacesURL),
            let root = try? JSONSerialization.jsonObject(with: data)
        else { return false }
        return Self.contains(key: name, in: root, depth: 0)
    }

    private static func contains(key: String, in value: Any, depth: Int) -> Bool {
        guard depth < 6 else { return false }
        if let dictionary = value as? [String: Any] {
            return dictionary[key] != nil || dictionary.values.contains { contains(key: key, in: $0, depth: depth + 1) }
        }
        if let array = value as? [Any] {
            return array.contains { contains(key: key, in: $0, depth: depth + 1) }
        }
        return false
    }

    private func hasMarker(at url: URL) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? handle.close() }
        guard let head = try? handle.read(upToCount: 2048) else { return false }
        let lines = String(decoding: head, as: UTF8.self).split(separator: "\n", maxSplits: 3, omittingEmptySubsequences: false).prefix(3)
        return lines.contains { $0.contains(Self.marker) }
    }
}
