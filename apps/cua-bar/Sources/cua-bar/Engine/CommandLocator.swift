import Foundation

enum CommandLocation: Equatable, Sendable {
    /// `~/.local/bin/codex-cua`, ours.
    case ready(URL)
    /// An engine copy is bound (`source.json`) but its command has not been set up, or was taken away.
    case installedNotSetUp(installPath: URL)
    case engineMissing
}

/// "Finding the command":
/// 1. `~/.local/bin/codex-cua` exists and its first 3 lines contain the authored-command marker;
/// 2. otherwise an engine copy is bound in `~/.local/share/codex-cua/source.json` and its `setup.sh` is
///    there, but the command is not;
/// 3. otherwise there is no engine.
///
/// The engine copies themselves are put there by the app (`setup.sh install-engine` of the engine in its
/// bundle); nothing here looks at Claude Code.
struct CommandLocator: Sendable {
    static let marker = "# codex-cua authored command v1"

    var home: URL

    init(home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        self.home = home
    }

    var commandURL: URL { home.appendingPathComponent(".local/bin/codex-cua") }

    var supportURL: URL { home.appendingPathComponent(".local/share/codex-cua", isDirectory: true) }

    /// What a setup leaves behind: the engine copy the command is bound to.
    var supportBindingURL: URL { supportURL.appendingPathComponent("source.json") }

    func locate() -> CommandLocation {
        if hasMarker(at: commandURL) { return .ready(commandURL) }
        if let root = boundEngine() { return .installedNotSetUp(installPath: root) }
        return .engineMissing
    }

    /// The engine folder `source.json` binds, when its `setup.sh` is really there. A binding whose folder
    /// is gone is no engine.
    func boundEngine() -> URL? {
        guard
            let data = try? Data(contentsOf: supportBindingURL),
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let path = root["source_root"] as? String, path.hasPrefix("/")
        else { return nil }
        let folder = URL(fileURLWithPath: path, isDirectory: true)
        return FileManager.default.fileExists(atPath: folder.appendingPathComponent("setup.sh").path) ? folder : nil
    }

    private func hasMarker(at url: URL) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? handle.close() }
        guard let head = try? handle.read(upToCount: 2048) else { return false }
        let lines = String(decoding: head, as: UTF8.self).split(separator: "\n", maxSplits: 3, omittingEmptySubsequences: false).prefix(3)
        return lines.contains { $0.contains(Self.marker) }
    }
}
