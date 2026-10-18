import Foundation

enum PopoverTab: String, CaseIterable, Identifiable, Sendable {
    case connections, leases, otherTools, activity

    var id: String { rawValue }

    var title: String {
        switch self {
        case .connections: "연결"
        case .leases: "브라우저 점유"
        case .otherTools: "다른 도구"
        case .activity: "기록"
        }
    }

    /// R21: an empty tab says "없음" in one line instead of looking broken.
    var emptyText: String {
        switch self {
        case .connections: "연결 없음"
        case .leases: "점유 없음"
        case .otherTools: "다른 도구 없음"
        case .activity: "기록 없음"
        }
    }
}

/// What the four tabs show, already turned into text. The views only lay this out, so the
/// decisions (which button is on, what a row says) are testable without a window.
struct PopoverContent: Equatable, Sendable {
    var connections: ConnectionsContent
    var leases: LeasesContent
    var otherTools: OtherToolsContent
    var activity: ActivityContent

    init(status: EngineStatus, now: Date, calendar: Calendar = .current) {
        connections = ConnectionsContent(status: status, now: now, calendar: calendar)
        leases = LeasesContent(status: status, now: now, calendar: calendar)
        otherTools = OtherToolsContent(status: status, now: now)
        activity = ActivityContent(status: status, calendar: calendar)
    }
}

// MARK: - 연결

struct ConnectionRow: Equatable, Identifiable, Sendable {
    var id: String
    var agent: AgentKind
    var folder: String
    /// The full path, for a hover hint.
    var path: String?
    var startedText: String
    var memoryText: String
    var state: StateDisplay
    /// A tool call is in flight right now.
    var isBusy: Bool
    var canRelease: Bool
    var canStop: Bool

    init(_ connection: Connection, now: Date, calendar: Calendar) {
        id = connection.id
        agent = connection.agent
        folder = Format.folder(connection.cwd)
        path = connection.cwd
        startedText = Format.startTime(connection.startedAt, now: now, calendar: calendar)
        memoryText = Format.memory(connection.memoryBytes)
        state = StateDisplay.make(state: connection.state, idleSeconds: connection.idleSeconds)
        isBusy = connection.busy
        canRelease = connection.canRelease
        canStop = connection.canStop
    }
}

struct ConnectionGroup: Equatable, Identifiable, Sendable {
    var agent: AgentKind
    /// `Claude · 2`
    var title: String
    var rows: [ConnectionRow]
    var id: String { agent.label }
}

/// How many connections each group button would stop. Only what the engine says it may signal
/// (`can_stop`) counts, and "all" is Claude plus Codex: cmux-cua is never in a group (R17).
struct GroupStopCounts: Equatable, Sendable {
    var all: Int
    var claude: Int
    var codex: Int

    func count(for group: StopGroup) -> Int {
        switch group {
        case .all: all
        case .claude: claude
        case .codex: codex
        }
    }
}

struct ConnectionsContent: Equatable, Sendable {
    var groups: [ConnectionGroup]
    var stopCounts: GroupStopCounts
    var endedCount: Int
    var emptyText: String?

    init(status: EngineStatus, now: Date, calendar: Calendar) {
        // Needs attention first (ended), then the newest; a stable order so rows do not jump.
        let ordered = status.connections.sorted { left, right in
            if (left.state == .ended) != (right.state == .ended) { return left.state == .ended }
            switch (left.startedAt, right.startedAt) {
            case let (a?, b?) where a != b: return a > b
            case (_?, nil): return true
            case (nil, _?): return false
            default: return left.id < right.id
            }
        }
        var agents: [AgentKind] = []
        for connection in ordered where !agents.contains(connection.agent) { agents.append(connection.agent) }
        let rank: (AgentKind) -> Int = { $0 == .claude ? 0 : ($0 == .codex ? 1 : 2) }
        agents = agents.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map(\.element)

        groups = agents.map { agent in
            let rows = ordered.filter { $0.agent == agent }.map { ConnectionRow($0, now: now, calendar: calendar) }
            return ConnectionGroup(agent: agent, title: "\(agent.label) · \(rows.count)", rows: rows)
        }
        let stoppable = status.connections.filter(\.canStop)
        let claude = stoppable.filter { $0.agent == .claude }.count
        let codex = stoppable.filter { $0.agent == .codex }.count
        stopCounts = GroupStopCounts(all: claude + codex, claude: claude, codex: codex)
        endedCount = status.connections.filter { $0.state == .ended }.count
        emptyText = status.connections.isEmpty ? PopoverTab.connections.emptyText : nil
    }
}

// MARK: - 브라우저 점유

struct LeaseRow: Equatable, Identifiable, Sendable {
    enum Kind: Equatable, Sendable { case held, maybeLeft }

    var id: String
    var kind: Kind
    var agent: AgentKind
    var folder: String
    /// `점유 중` or `점유가 남았을 수 있음`
    var statusText: String
    var detail: String?
    var sessionID: String?
    /// The 콕 집어 풀기 button is shown.
    var canReleaseSession: Bool
    /// Shown instead of the button when there is no way to release this one by itself.
    var hint: String?
}

struct ExtensionResetGuidance: Equatable, Sendable {
    var title: String
    var steps: [String]
    var warning: String
    var liveConnectionsTitle: String
    var liveConnections: [String]
    var liveConnectionsEmptyText: String
    /// Some leftover cannot be released one by one, so the guidance is open by default.
    var needsAttention: Bool
}

struct LeasesContent: Equatable, Sendable {
    var rows: [LeaseRow]
    var notice: String?
    var emptyText: String?
    var guidance: ExtensionResetGuidance

    init(status: EngineStatus, now: Date, calendar: Calendar) {
        let leases = status.leases
        var rows: [LeaseRow] = []
        for (index, item) in leases.items.enumerated() {
            var parts: [String] = []
            if let since = item.since { parts.append("\(Format.when(since, now: now, calendar: calendar))부터") }
            if let session = item.sessionID { parts.append("세션 \(Self.shortSession(session))") }
            rows.append(LeaseRow(
                id: "held-\(item.sessionID ?? item.connectionID ?? String(index))", kind: .held, agent: item.agent,
                folder: Format.folder(item.cwd), statusText: "점유 중", detail: parts.isEmpty ? nil : parts.joined(separator: " · "),
                sessionID: item.sessionID, canReleaseSession: item.sessionID != nil && item.releasable, hint: nil))
        }
        for (index, item) in leases.maybeLeft.enumerated() {
            var parts: [String] = []
            if let ended = item.endedAt { parts.append("\(Format.when(ended, now: now, calendar: calendar))에 끝남") }
            if let session = item.sessionID { parts.append("세션 \(Self.shortSession(session))") }
            let releasable = item.sessionID != nil && item.releasable
            rows.append(LeaseRow(
                id: "left-\(item.sessionID ?? item.connectionID ?? String(index))", kind: .maybeLeft, agent: item.agent,
                folder: Format.folder(item.cwd), statusText: "점유가 남았을 수 있음", detail: parts.isEmpty ? nil : parts.joined(separator: " · "),
                sessionID: item.sessionID, canReleaseSession: releasable, hint: releasable ? nil : "콕 집어 풀 방법이 없어요"))
        }
        self.rows = rows
        emptyText = rows.isEmpty ? PopoverTab.leases.emptyText : nil
        // R14: with no readable list the app says what it knows and never invents a count.
        if leases.readable {
            notice = nil
        } else {
            notice = rows.isEmpty
                ? "점유 목록을 읽지 못해요. 끝난 연결 기록으로만 알 수 있어요"
                : "점유 목록을 읽지 못해서, 끝난 연결 기록으로 보여요"
        }

        let live = ConnectionsContent(status: status, now: now, calendar: calendar).groups
            .flatMap(\.rows)
            .filter { $0.state.kind != .ended }
        guidance = ExtensionResetGuidance(
            title: "그래도 안 풀리면 — Chrome 확장 초기화",
            steps: ["Chrome에서 chrome://extensions 페이지를 열어요.", "ChatGPT 확장을 껐다가 다시 켜요."],
            warning: "이 Chrome을 쓰는 모든 CUA 연결의 점유가 한꺼번에 풀려요. 다른 작업 중에는 하지 마세요.",
            liveConnectionsTitle: "초기화하면 끊길 살아 있는 연결",
            liveConnections: live.map { row in row.path == nil ? row.agent.label : "\(row.agent.label) · \(row.folder)" },
            liveConnectionsEmptyText: "없음",
            needsAttention: rows.contains { $0.kind == .maybeLeft && !$0.canReleaseSession })
    }

    private static func shortSession(_ id: String) -> String { String(id.prefix(8)) }
}

// MARK: - 다른 도구

struct ScreenLine: Equatable, Sendable {
    var isActive: Bool
    var text: String
    var detail: String?
}

struct OtherToolRow: Equatable, Identifiable, Sendable {
    var name: String
    var isRunning: Bool
    var statusText: String
    var detail: String?
    var clients: [String]
    var id: String { name }
}

struct OtherToolsContent: Equatable, Sendable {
    var screen: ScreenLine
    var tools: [OtherToolRow]
    var emptyText: String?

    init(status: EngineStatus, now: Date) {
        if let use = StatusEvaluator.screenUse(in: status) {
            let lastCall = status.screen.lastCallAt ?? use.connection?.lastCallAt
            let who = use.folder.map { "\(use.agentLabel) · \($0)" } ?? use.agentLabel
            screen = ScreenLine(
                isActive: true, text: "\(who)가 화면을 쓰는 중",
                detail: lastCall.map { "\(Format.ago($0, now: now)) 호출" })
        } else {
            screen = ScreenLine(
                isActive: false, text: "지금 화면을 쓰는 연결 없음",
                detail: status.screen.lastCallAt.map { "마지막 호출 \(Format.ago($0, now: now))" })
        }
        tools = status.otherTools.map { tool in
            OtherToolRow(
                name: tool.name, isRunning: tool.running, statusText: tool.running ? "실행 중" : "꺼져 있음",
                detail: tool.running && !tool.pids.isEmpty ? "프로세스 \(tool.pids.count)개" : nil,
                clients: tool.clients.map { client in
                    client.cwd.map { "\(client.agent.label) · \(Format.folder($0))" } ?? client.agent.label
                })
        }
        emptyText = tools.isEmpty ? PopoverTab.otherTools.emptyText : nil
    }
}

// MARK: - 기록

struct ActivityRow: Equatable, Identifiable, Sendable {
    var id: String
    var timeText: String
    var agent: AgentKind
    var folder: String
    var tool: String
    var ok: Bool?
    var durationText: String
}

struct ActivityContent: Equatable, Sendable {
    var rows: [ActivityRow]
    var emptyText: String?

    init(status: EngineStatus, calendar: Calendar) {
        var seen: [String: Int] = [:]
        rows = status.activity.prefix(200).map { entry in
            let connection = status.connection(withID: entry.connectionID)
            let base = "\(entry.at.map { String(Int($0.timeIntervalSince1970)) } ?? "-")|\(entry.connectionID ?? "-")|\(entry.tool ?? "-")|\(entry.ms.map(String.init) ?? "-")"
            let occurrence = seen[base, default: 0]
            seen[base] = occurrence + 1
            let agent = entry.agent == .other("") ? (connection?.agent ?? entry.agent) : entry.agent
            return ActivityRow(
                id: "\(base)|\(occurrence)", timeText: Format.clock(entry.at, calendar: calendar), agent: agent,
                folder: Format.folder(connection?.cwd), tool: entry.tool ?? Format.unknown, ok: entry.ok,
                durationText: Format.milliseconds(entry.ms))
        }
        emptyText = rows.isEmpty ? PopoverTab.activity.emptyText : nil
    }
}
