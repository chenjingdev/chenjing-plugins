import Foundation

// What the action commands print (contract: "Actions"). Each prints one JSON object and exits 0
// even when the action itself failed (`ok: false`), so a result always carries the reason.

struct ReleaseResult: Equatable, Sendable {
    var ok = false
    var released = false
    var reason: String?
    var scopeCount: Int?
}

/// `release-session`: like `ReleaseResult`, but it reports how many tabs the session held.
struct SessionReleaseResult: Equatable, Sendable {
    var ok = false
    var released = false
    var reason: String?
    /// Tabs the session held right before the release; nil when unknown.
    var tabCount: Int?
}

struct EndedRelease: Equatable, Sendable {
    var connectionID: String?
    var released = false
    var reason: String?
}

struct ReleaseEndedResult: Equatable, Sendable {
    var ok = false
    var results: [EndedRelease] = []
    /// Not in the contract's shape, but an engine that fails before it starts may say why.
    var reason: String?
}

struct StopResult: Equatable, Sendable {
    var ok = false
    var stopped = false
    var released = false
    var reason: String?
}

struct GroupStopEntry: Equatable, Sendable {
    var connectionID: String?
    var stopped = false
    var released = false
    var reason: String?
}

struct GroupStopResult: Equatable, Sendable {
    var ok = false
    var stopped = 0
    var failed = 0
    var results: [GroupStopEntry] = []
    /// Not in the contract's shape, but an engine that fails before it starts may say why.
    var reason: String?
}

struct RestartResult: Equatable, Sendable {
    var ok = false
    var reason: String?
}

/// `settings --error-text on|off`: what the engine now keeps (`unwritable` when its folder is not this user's).
struct SettingsResult: Equatable, Sendable {
    var ok = false
    var reason: String?
    var errorText: Bool?
}

extension ReleaseResult: Decodable {
    private enum CodingKeys: String, CodingKey { case ok, released, reason, scopeCount = "scope_count" }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenientBool(.ok) ?? false
        released = c.lenientBool(.released) ?? false
        reason = c.lenientString(.reason)
        scopeCount = c.lenientInt(.scopeCount)
    }
}

extension SessionReleaseResult: Decodable {
    private enum CodingKeys: String, CodingKey { case ok, released, reason, tabCount = "tab_count" }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenientBool(.ok) ?? false
        released = c.lenientBool(.released) ?? false
        reason = c.lenientString(.reason)
        tabCount = c.lenientInt(.tabCount)
    }
}

extension EndedRelease: Decodable {
    private enum CodingKeys: String, CodingKey { case connectionID = "connection_id", released, reason }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        connectionID = c.lenientString(.connectionID)
        released = c.lenientBool(.released) ?? false
        reason = c.lenientString(.reason)
    }
}

extension ReleaseEndedResult: Decodable {
    private enum CodingKeys: String, CodingKey { case ok, results, reason }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenientBool(.ok) ?? false
        results = c.lenientArray(EndedRelease.self, forKey: .results)
        reason = c.lenientString(.reason)
    }
}

extension StopResult: Decodable {
    private enum CodingKeys: String, CodingKey { case ok, stopped, released, reason }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenientBool(.ok) ?? false
        stopped = c.lenientBool(.stopped) ?? false
        released = c.lenientBool(.released) ?? false
        reason = c.lenientString(.reason)
    }
}

extension GroupStopEntry: Decodable {
    private enum CodingKeys: String, CodingKey { case connectionID = "connection_id", stopped, released, reason }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        connectionID = c.lenientString(.connectionID)
        stopped = c.lenientBool(.stopped) ?? false
        released = c.lenientBool(.released) ?? false
        reason = c.lenientString(.reason)
    }
}

extension GroupStopResult: Decodable {
    private enum CodingKeys: String, CodingKey { case ok, stopped, failed, results, reason }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenientBool(.ok) ?? false
        stopped = c.lenientInt(.stopped) ?? 0
        failed = c.lenientInt(.failed) ?? 0
        results = c.lenientArray(GroupStopEntry.self, forKey: .results)
        reason = c.lenientString(.reason)
    }
}

extension RestartResult: Decodable {
    private enum CodingKeys: String, CodingKey { case ok, reason }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenientBool(.ok) ?? false
        reason = c.lenientString(.reason)
    }
}

extension SettingsResult: Decodable {
    private enum CodingKeys: String, CodingKey { case ok, reason, errorText = "error_text" }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenientBool(.ok) ?? false
        reason = c.lenientString(.reason)
        errorText = c.lenientBool(.errorText)
    }
}
