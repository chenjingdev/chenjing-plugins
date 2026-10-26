import Foundation

/// The names CUA's tools had before: `mcp__cua__js` (0.8.0, MCP server `cua`) and `mcp__plugin_cua_cua__js` (the old
/// plugin). A permission rule or a hook matcher that names them matches nothing now (F9).
enum OldToolNames {
    static let servers = ["mcp__cua", "mcp__plugin_cua_cua"]
    static let prefixes = servers.map { $0 + "__" }

    /// A rule names them when it is one of the servers or one of their tools.
    static func named(byRule rule: String) -> Bool {
        servers.contains(rule) || prefixes.contains { rule.hasPrefix($0) }
    }

    /// A hook matcher is a pattern: it names them when it holds one of their tool names anywhere, or is a server.
    static func named(byMatcher matcher: String) -> Bool {
        servers.contains(matcher) || prefixes.contains { matcher.contains($0) }
    }
}

/// The rule that lets every cuabar tool run without asking, and how a rule names the cuabar server.
enum CuabarRule {
    static let allowAll = "mcp__cuabar"

    static func names(_ rule: String) -> Bool { rule == allowAll || rule.hasPrefix(allowAll + "__") }
}

/// What Claude Code's settings files say of CUA's tools (F9), as the app read them.
struct PermissionReading: Equatable, Sendable {
    /// What the user settings (`~/.claude/settings.json`) say of the cuabar tools.
    enum UserRule: Equatable, Sendable {
        case none
        case allowed
        /// An ask or deny rule: the person chose to be asked, or to keep CUA out.
        case askedOrDenied
    }

    static let bypassMode = "bypassPermissions"
    static let autoMode = "auto"

    /// The user settings are there but could not be read as settings.
    var unreadable = false
    var userRule: UserRule = .none
    /// `permissions.defaultMode` of the user settings, as written.
    var defaultMode: String?
    /// Settings files whose allow, ask or deny rules name the old tools, with `~` for the home folder.
    var oldRuleFiles: [String] = []
    /// Settings files whose hook matchers name them.
    var oldHookFiles: [String] = []

    /// Claude Code does not ask about CUA's tools: the user settings allow them, or the mode asks nothing.
    var skipsAsking: Bool { userRule == .allowed || defaultMode == Self.bypassMode }

    /// No rule of the user settings names cuabar and the mode can ask: the 점검 tab offers the one rule (R26).
    var needsAllowRule: Bool { !unreadable && userRule == .none && defaultMode != Self.bypassMode }

    /// Rules for the old names change nothing once CUA is not asked about; a hook for them never runs again either
    /// way (R25).
    var hasOldNames: Bool { !oldHookFiles.isEmpty || (!oldRuleFiles.isEmpty && !skipsAsking) }
}

/// What one settings file says of CUA's tools (R25).
struct SettingsFileReading: Equatable, Sendable {
    var oldRules = false
    var oldHooks = false
    var cuabarAllowed = false
    var cuabarAskedOrDenied = false
    var defaultMode: String?

    /// nil: not a JSON object.
    init?(data: Data) {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        let permissions = root["permissions"] as? [String: Any] ?? [:]
        func rules(_ key: String) -> [String] { (permissions[key] as? [Any] ?? []).compactMap { $0 as? String } }
        let allow = rules("allow")
        let others = rules("ask") + rules("deny")
        oldRules = (allow + others).contains(where: OldToolNames.named(byRule:))
        cuabarAllowed = allow.contains(where: CuabarRule.names)
        cuabarAskedOrDenied = others.contains(where: CuabarRule.names)
        defaultMode = permissions["defaultMode"] as? String
        let events = (root["hooks"] as? [String: Any] ?? [:]).values
        oldHooks = events.contains { event in
            (event as? [Any] ?? []).contains { group in
                ((group as? [String: Any])?["matcher"] as? String).map(OldToolNames.named(byMatcher:)) ?? false
            }
        }
    }
}

/// The project folders' settings files that still name the old tools.
struct FolderScan: Equatable, Sendable {
    var oldRuleFiles: [String] = []
    var oldHookFiles: [String] = []
}

/// The last look at the project folders' files, kept for a while: Claude Code can list hundreds of folders, and the
/// status is read every few seconds. A copy of `ClaudeIntegration` shares it.
final class FolderScanCache: @unchecked Sendable {
    private let lock = NSLock()
    private var scanned: Date?
    private var kept = FolderScan()

    /// What was found less than `interval` ago, else what `scan` finds now.
    func scan(now: Date, every interval: TimeInterval, _ scan: () -> FolderScan) -> FolderScan {
        let recent = lock.withLock { () -> FolderScan? in
            guard let scanned, now >= scanned, now.timeIntervalSince(scanned) < interval else { return nil }
            return kept
        }
        if let recent { return recent }
        let found = scan()
        lock.withLock {
            scanned = now
            kept = found
        }
        return found
    }
}
