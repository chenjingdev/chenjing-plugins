import Foundation

// What `codex-cua status --json` prints (contract v1: .pact/cua-메뉴-막대-앱/contract.md).
// Every property has a default and decoding never fails on a missing, null or mistyped field,
// so an older or newer engine still renders. Only a document that is not a JSON object fails.

struct EngineStatus: Equatable, Sendable {
    static let supportedSchemaVersion = 1

    var schemaVersion: Int = EngineStatus.supportedSchemaVersion
    var generatedAt: Date?
    var plugin = PluginInfo()
    var codex = CodexInfo()
    var host = HostInfo()
    var setup = SetupInfo()
    var connections: [Connection] = []
    var leases = Leases()
    var otherTools: [OtherTool] = []
    var screen = ScreenInfo()
    var activity: [ActivityEntry] = []

    func connection(withID id: String?) -> Connection? {
        guard let id else { return nil }
        return connections.first { $0.id == id }
    }

    /// A listed connection that has not ended: its runtime still runs.
    func isLive(connectionID id: String?) -> Bool {
        guard let connection = connection(withID: id) else { return false }
        return connection.state != .ended
    }
}

// MARK: - Kinds

/// Who a connection serves. Unknown agents are kept by name so a future one still shows up.
enum AgentKind: Equatable, Hashable, Sendable {
    case claude
    case codex
    case other(String)

    init(raw: String?) {
        switch raw?.lowercased() {
        case "claude": self = .claude
        case "codex": self = .codex
        default: self = .other(raw ?? "")
        }
    }

    var label: String {
        switch self {
        case .claude: "Claude"
        case .codex: "Codex"
        case .other(let name): name.isEmpty ? "AI" : name
        }
    }
}

enum ConnectionState: Equatable, Sendable {
    case active, idle, ended
    case unknown(String)

    init(raw: String?) {
        switch raw {
        case "active": self = .active
        case "idle": self = .idle
        case "ended": self = .ended
        default: self = .unknown(raw ?? "")
        }
    }
}

enum HostState: Equatable, Sendable {
    case ready, starting, closed, missing
    case unknown(String)

    init(raw: String?) {
        switch raw {
        case "ready": self = .ready
        case "starting": self = .starting
        case "closed": self = .closed
        case "missing": self = .missing
        default: self = .unknown(raw ?? "")
        }
    }
}

// MARK: - Sections

struct PluginInfo: Equatable, Sendable {
    var version: String?
}

struct CodexInfo: Equatable, Sendable {
    /// nil when the engine did not say.
    var installed: Bool?
    var appPath: String?
    var appVersion: String?
    var running: Bool = false
    var pids: [Int] = []
}

struct HostInfo: Equatable, Sendable {
    var state: HostState = .unknown("")
    var since: Date?
}

/// Raw states as the contract lists them (`ready`, `missing`, `broken`, ...); nil is unknown.
struct SetupInfo: Equatable, Sendable {
    var command: String?
    var dependencies: String?
    var loginEnvironment: String?
    var wrapper: String?
    var relay: String?
}

struct Connection: Equatable, Sendable, Identifiable {
    var id: String
    var agent: AgentKind = .other("")
    var state: ConnectionState = .unknown("")
    var pid: Int?
    var ownerPID: Int?
    var ownerAlive: Bool?
    var cwd: String?
    var startedAt: Date?
    var memoryBytes: Int64?
    var lastCallAt: Date?
    var idleSeconds: Double?
    var sessionID: String?
    /// A tool call is in flight right now.
    var busy = false
    /// A verified control endpoint exists.
    var canRelease = false
    /// The engine may signal this process.
    var canStop = false
}

struct Leases: Equatable, Sendable {
    /// false: the real lease list cannot be read, `items` is empty and only `maybeLeft` is known.
    var readable = false
    var items: [LeaseItem] = []
    var maybeLeft: [LeftoverLease] = []
}

/// A lease the engine could read. The contract does not spell out this shape yet, so every
/// field is optional and mirrors `LeftoverLease`.
struct LeaseItem: Equatable, Sendable {
    var sessionID: String?
    var agent: AgentKind = .other("")
    var connectionID: String?
    var cwd: String?
    var since: Date?
    var releasable = false
}

/// A recorded session whose owner and runtime are gone without confirmed cleanup.
struct LeftoverLease: Equatable, Sendable {
    var sessionID: String?
    var agent: AgentKind = .other("")
    var connectionID: String?
    var cwd: String?
    var endedAt: Date?
    var releasable = false
}

/// One client of another tool. For cmux-cua each is one `cmux-cua mcp` process: what one AI
/// conversation holds open to it.
struct ToolClient: Equatable, Sendable {
    /// `cmux-<mcp pid>-<process start epoch seconds>`, what `stop --connection` takes. nil from an
    /// engine that does not name its clients yet.
    var id: String?
    /// The AI client that started it. One client can hold several connections, so this repeats and
    /// is no key. nil when that AI client is gone.
    var pid: Int?
    /// The `cmux-cua mcp` process itself, the one a stop signals.
    var mcpPID: Int?
    var agent: AgentKind = .other("")
    var cwd: String?
    var startedAt: Date?
    /// The engine may signal this process.
    var canStop = false

    /// Nobody is on the other end: the engine reports no `pid` (nor agent or folder) for it.
    var isOrphan: Bool { pid == nil }

    /// A cmux-cua connection id starts with `cmux-`, the way the others start with their agent.
    static func isCmuxConnection(id: String) -> Bool { id.hasPrefix("cmux-") }
}

struct OtherTool: Equatable, Sendable {
    var name: String
    var running = false
    var pids: [Int] = []
    var clients: [ToolClient] = []
}

struct ScreenInfo: Equatable, Sendable {
    var activeConnectionID: String?
    var lastCallAt: Date?
}

struct ActivityEntry: Equatable, Sendable {
    var at: Date?
    var connectionID: String?
    var agent: AgentKind = .other("")
    var tool: String?
    var ok: Bool?
    var ms: Int?
}

// MARK: - Decoding

extension EngineStatus: Decodable {
    private enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version", generatedAt = "generated_at"
        case plugin, codex, host, setup, connections, leases
        case otherTools = "other_tools", screen, activity
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = c.lenientInt(.schemaVersion) ?? Self.supportedSchemaVersion
        generatedAt = c.lenientDate(.generatedAt)
        plugin = c.lenient(PluginInfo.self, forKey: .plugin) ?? PluginInfo()
        codex = c.lenient(CodexInfo.self, forKey: .codex) ?? CodexInfo()
        host = c.lenient(HostInfo.self, forKey: .host) ?? HostInfo()
        setup = c.lenient(SetupInfo.self, forKey: .setup) ?? SetupInfo()
        connections = c.lenientArray(Connection.self, forKey: .connections)
        leases = c.lenient(Leases.self, forKey: .leases) ?? Leases()
        otherTools = c.lenientArray(OtherTool.self, forKey: .otherTools)
        screen = c.lenient(ScreenInfo.self, forKey: .screen) ?? ScreenInfo()
        activity = c.lenientArray(ActivityEntry.self, forKey: .activity)
    }
}

extension PluginInfo: Decodable {
    private enum CodingKeys: String, CodingKey { case version }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = c.lenientString(.version)
    }
}

extension CodexInfo: Decodable {
    private enum CodingKeys: String, CodingKey {
        case installed, appPath = "app_path", appVersion = "app_version", running, pids
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        installed = c.lenientBool(.installed)
        appPath = c.lenientString(.appPath)
        appVersion = c.lenientString(.appVersion)
        running = c.lenientBool(.running) ?? false
        pids = c.lenientInts(.pids)
    }
}

extension HostInfo: Decodable {
    private enum CodingKeys: String, CodingKey { case state, since }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = HostState(raw: c.lenientString(.state))
        since = c.lenientDate(.since)
    }
}

extension SetupInfo: Decodable {
    private enum CodingKeys: String, CodingKey {
        case command, dependencies, loginEnvironment = "login_environment", wrapper, relay
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        command = c.lenientString(.command)
        dependencies = c.lenientString(.dependencies)
        loginEnvironment = c.lenientString(.loginEnvironment)
        wrapper = c.lenientString(.wrapper)
        relay = c.lenientString(.relay)
    }
}

extension Connection: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id, agent, state, pid
        case ownerPID = "owner_pid", ownerAlive = "owner_alive", cwd
        case startedAt = "started_at", memoryBytes = "memory_bytes"
        case lastCallAt = "last_call_at", idleSeconds = "idle_seconds"
        case sessionID = "session_id", busy
        case canRelease = "can_release", canStop = "can_stop"
    }

    /// A connection without an id cannot be acted on, so it is the one thing that fails.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        agent = AgentKind(raw: c.lenientString(.agent))
        state = ConnectionState(raw: c.lenientString(.state))
        pid = c.lenientInt(.pid)
        ownerPID = c.lenientInt(.ownerPID)
        ownerAlive = c.lenientBool(.ownerAlive)
        cwd = c.lenientString(.cwd)
        startedAt = c.lenientDate(.startedAt)
        memoryBytes = c.lenientInt64(.memoryBytes)
        lastCallAt = c.lenientDate(.lastCallAt)
        idleSeconds = c.lenientDouble(.idleSeconds)
        sessionID = c.lenientString(.sessionID)
        busy = c.lenientBool(.busy) ?? false
        canRelease = c.lenientBool(.canRelease) ?? false
        canStop = c.lenientBool(.canStop) ?? false
    }
}

extension Leases: Decodable {
    private enum CodingKeys: String, CodingKey { case readable, items, maybeLeft = "maybe_left" }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        readable = c.lenientBool(.readable) ?? false
        items = c.lenientArray(LeaseItem.self, forKey: .items)
        maybeLeft = c.lenientArray(LeftoverLease.self, forKey: .maybeLeft)
    }
}

extension LeaseItem: Decodable {
    private enum CodingKeys: String, CodingKey {
        case sessionID = "session_id", agent, connectionID = "connection_id", cwd, since, releasable
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionID = c.lenientString(.sessionID)
        agent = AgentKind(raw: c.lenientString(.agent))
        connectionID = c.lenientString(.connectionID)
        cwd = c.lenientString(.cwd)
        since = c.lenientDate(.since)
        releasable = c.lenientBool(.releasable) ?? false
    }
}

extension LeftoverLease: Decodable {
    private enum CodingKeys: String, CodingKey {
        case sessionID = "session_id", agent, connectionID = "connection_id", cwd
        case endedAt = "ended_at", releasable
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionID = c.lenientString(.sessionID)
        agent = AgentKind(raw: c.lenientString(.agent))
        connectionID = c.lenientString(.connectionID)
        cwd = c.lenientString(.cwd)
        endedAt = c.lenientDate(.endedAt)
        releasable = c.lenientBool(.releasable) ?? false
    }
}

extension ToolClient: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id, pid, mcpPID = "mcp_pid", agent, cwd, startedAt = "started_at", canStop = "can_stop"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenientString(.id)
        pid = c.lenientInt(.pid)
        mcpPID = c.lenientInt(.mcpPID)
        agent = AgentKind(raw: c.lenientString(.agent))
        cwd = c.lenientString(.cwd)
        startedAt = c.lenientDate(.startedAt)
        canStop = c.lenientBool(.canStop) ?? false
    }
}

extension OtherTool: Decodable {
    private enum CodingKeys: String, CodingKey { case name, running, pids, clients }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        running = c.lenientBool(.running) ?? false
        pids = c.lenientInts(.pids)
        clients = c.lenientArray(ToolClient.self, forKey: .clients)
    }
}

extension ScreenInfo: Decodable {
    private enum CodingKeys: String, CodingKey {
        case activeConnectionID = "active_connection_id", lastCallAt = "last_call_at"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        activeConnectionID = c.lenientString(.activeConnectionID)
        lastCallAt = c.lenientDate(.lastCallAt)
    }
}

extension ActivityEntry: Decodable {
    private enum CodingKeys: String, CodingKey {
        case at, connectionID = "connection_id", agent, tool, ok, ms
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = c.lenientDate(.at)
        connectionID = c.lenientString(.connectionID)
        agent = AgentKind(raw: c.lenientString(.agent))
        tool = c.lenientString(.tool)
        ok = c.lenientBool(.ok)
        ms = c.lenientInt(.ms)
    }
}
