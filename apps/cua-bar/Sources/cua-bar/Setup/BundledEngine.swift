import Foundation

/// The engine the app carries in its bundle (`Contents/Resources/engine`). `setup.sh install-engine` of this
/// folder puts a copy under `~/.local/share/codex-cua/engine/<version>/`; the skill the app installs into
/// Claude Code is the one in here.
///
/// A build that does not run from an app bundle has none, and then the app installs nothing.
struct BundledEngine: Equatable, Sendable {
    var root: URL

    var setupScript: URL { root.appendingPathComponent("setup.sh") }
    var skillSource: URL { root.appendingPathComponent("skills/cuabar/SKILL.md") }

    static func locate(in bundle: Bundle = .main) -> BundledEngine? {
        guard let resources = bundle.resourceURL else { return nil }
        let engine = BundledEngine(root: resources.appendingPathComponent("engine", isDirectory: true))
        return FileManager.default.fileExists(atPath: engine.setupScript.path) ? engine : nil
    }
}

/// Whether the Codex app is on this Mac, by the app's own look: it has to know before the engine (which
/// answers that in its status) is there. The places and the bundle id are the engine's own
/// (`runtime_paths.discover_installation`); the engine's status stays the authority once it can be read.
struct CodexLocator: Sendable {
    static let bundleIdentifier = "com.openai.codex"
    static let overrideVariable = "CODEX_CUA_APP_PATH"

    var home: URL
    var environment: [String: String]
    /// Is the folder at this path the Codex app? Injected so a test says what exists without `/Applications`.
    var isCodexBundle: @Sendable (String) -> Bool

    init(
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        isCodexBundle: @escaping @Sendable (String) -> Bool = CodexLocator.looksLikeCodex
    ) {
        self.home = home
        self.environment = environment
        self.isCodexBundle = isCodexBundle
    }

    func isInstalled() -> Bool {
        // An explicitly chosen app is the only one the engine considers.
        if let chosen = environment[Self.overrideVariable], !chosen.isEmpty { return isCodexBundle(chosen) }
        let roots = ["/Applications", home.appendingPathComponent("Applications").path]
        return roots.contains { root in ["Codex.app", "ChatGPT.app"].contains { isCodexBundle(root + "/" + $0) } }
    }

    @Sendable
    static func looksLikeCodex(_ path: String) -> Bool {
        let info = URL(fileURLWithPath: path).appendingPathComponent("Contents/Info.plist")
        guard
            let data = try? Data(contentsOf: info),
            let plist = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any]
        else { return false }
        return plist["CFBundleIdentifier"] as? String == bundleIdentifier
    }
}
