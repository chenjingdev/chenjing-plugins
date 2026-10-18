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

/// One button as the popover offers it: its label, what it does, whether it can be pressed now.
/// The views draw exactly these, so a test can check every button without a window.
struct ButtonSpec: Equatable, Identifiable, Sendable {
    var title: String
    var action: CUAAction
    var isDestructive = false
    var isEnabled = true
    /// Shown when the pointer rests on the button.
    var help: String

    /// Titles are unique within one row or group of buttons.
    var id: String { title }
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
    /// The contract's `state` (active / idle / ended). `state` above is only how it reads: an
    /// active connection whose idle time is unknown reads 알 수 없음, so a decision (such as asking
    /// before releasing a connection that may be working) is made on this one.
    var contractState: ConnectionState
    var sessionID: String?
    /// A tool call is in flight right now.
    var isBusy: Bool
    var canRelease: Bool
    var canStop: Bool
    /// 놓아주기 · 끄기 · 강제 종료
    var buttons: [ButtonSpec]
    /// After the engine refused a release twice (R15): 다시 하기 · 끄기 · 강제 종료. A normal
    /// stop is not blocked by a refused release, so 끄기 stays.
    var refusedButtons: [ButtonSpec]

    /// The line a row shows after a refused release.
    static let refusedNote = "작업이 끝나지 않아 못 놓음"

    init(_ connection: Connection, now: Date, calendar: Calendar) {
        id = connection.id
        agent = connection.agent
        folder = Format.folder(connection.cwd)
        path = connection.cwd
        startedText = Format.startTime(connection.startedAt, now: now, calendar: calendar)
        memoryText = Format.memory(connection.memoryBytes)
        state = StateDisplay.make(state: connection.state, idleSeconds: connection.idleSeconds)
        contractState = connection.state
        sessionID = connection.sessionID
        isBusy = connection.busy
        canRelease = connection.canRelease
        canStop = connection.canStop
        // A button that is off says why when the pointer rests on it.
        let releaseOffHelp = "놓아줄 길이 확인되지 않은 연결이에요. 중계기가 없거나 기록이 없을 때 그래요"
        let stopOffHelp = "신원을 확인하지 못한 프로세스라 앱이 끌 수 없어요"
        let stop = ButtonSpec(
            title: "끄기", action: .stopConnection(connection.id, force: false), isEnabled: connection.canStop,
            help: connection.canStop ? "탭을 놓아준 뒤 정상 종료해요" : stopOffHelp)
        let forceStop = ButtonSpec(
            title: "강제 종료", action: .stopConnection(connection.id, force: true), isDestructive: true,
            isEnabled: connection.canStop,
            help: connection.canStop ? "탭을 놓아준 뒤에도 안 꺼지면 강제로 끝내요. 하던 작업이 끊겨요" : stopOffHelp)
        buttons = [
            ButtonSpec(
                title: "놓아주기", action: .releaseConnection(connection.id), isEnabled: connection.canRelease,
                help: connection.canRelease ? "이 연결이 잡고 있는 브라우저 탭만 놓아줘요. 연결은 그대로예요" : releaseOffHelp),
            stop, forceStop,
        ]
        refusedButtons = [
            ButtonSpec(
                title: "다시 하기", action: .retryRelease(connection.id), isEnabled: connection.canRelease,
                help: "한 번 더 놓아 봐요. AI가 하던 조작이 끝나야 놓을 수 있어요"),
            stop, forceStop,
        ]
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
/// (`can_stop`) counts, and cmux-cua is never in a group (R17). `stop --group codex` skips a Codex
/// connection that has no session (`unattributed`: it may serve a Claude conversation), so the
/// Codex count leaves those out; `--group all` still stops them, so "all" has them.
struct GroupStopCounts: Equatable, Sendable {
    var all: Int
    var claude: Int
    var codex: Int
    /// Codex connections `--group codex` skips.
    var unattributedCodex = 0

    func count(for group: StopGroup) -> Int {
        switch group {
        case .all: all
        case .claude: claude
        case .codex: codex
        }
    }
}

extension GroupStopCounts {
    init(connections: [Connection]) {
        let stoppable = connections.filter(\.canStop)
        let claude = stoppable.filter { $0.agent == .claude }.count
        let codex = stoppable.filter { $0.agent == .codex }
        self.init(
            all: claude + codex.count, claude: claude, codex: codex.filter { $0.sessionID != nil }.count,
            unattributedCodex: codex.filter { $0.sessionID == nil }.count)
    }
}

struct ConnectionsContent: Equatable, Sendable {
    var groups: [ConnectionGroup]
    var stopCounts: GroupStopCounts
    var endedCount: Int
    /// Ended connections the engine may stop: what 끝난 연결 끄기 would stop.
    var endedStoppableCount: Int
    var emptyText: String?
    /// The group rows (묶음 끄기, 끝난 연결 놓아주기) only make sense when there are connections.
    var showsGroupButtons: Bool { !groups.isEmpty }
    /// 전체 끄기 · Claude만 · Codex만, each with how many it would stop.
    var stopButtons: [ButtonSpec]
    /// 끝난 연결 놓아주기, with how many ended connections there are.
    var releaseEndedButton: ButtonSpec

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
        stopCounts = GroupStopCounts(connections: status.connections)
        endedCount = status.connections.filter { $0.state == .ended }.count
        endedStoppableCount = status.connections.filter { $0.state == .ended && $0.canStop }.count
        emptyText = status.connections.isEmpty ? PopoverTab.connections.emptyText : nil

        let counts = stopCounts
        func stop(_ title: String, _ group: StopGroup, _ help: String) -> ButtonSpec {
            ButtonSpec(title: "\(title) \(counts.count(for: group))", action: .stopGroup(group, force: false),
                       isEnabled: counts.count(for: group) > 0, help: help)
        }
        let codexHelp = counts.unattributedCodex > 0
            ? "세션을 아는 Codex 연결만 정상 종료해요. 주인을 모르는 \(counts.unattributedCodex)개는 빠져요 — 하나씩 끄거나 전체로 끌 수 있어요"
            : "Codex 연결만 정상 종료해요"
        stopButtons = [
            stop("전체 끄기", .all, "Claude와 Codex 연결을 모두 정상 종료해요"),
            stop("Claude만", .claude, "Claude 연결만 정상 종료해요"),
            stop("Codex만", .codex, codexHelp),
        ]
        releaseEndedButton = ButtonSpec(
            title: "끝난 연결 놓아주기 \(endedCount)", action: .releaseEnded, isEnabled: endedCount > 0,
            help: "끝난 연결이 잡고 있는 브라우저 탭만 한꺼번에 놓아줘요")
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
    /// 콕 집어 풀기; nil when there is no session to aim at.
    var releaseButton: ButtonSpec? {
        guard canReleaseSession, let sessionID else { return nil }
        // A button press is a person's click, so `--user` goes along (Codex thread sessions need it).
        return ButtonSpec(title: "콕 집어 풀기", action: .releaseSession(sessionID, user: true), help: "이 세션이 남긴 점유만 세션 ID로 풀어요")
    }
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
        // With no readable list "no leases" would be a claim: all the app knows is that the
        // recorded sessions left nothing behind.
        emptyText = rows.isEmpty ? (leases.readable ? PopoverTab.leases.emptyText : "기록상 남은 점유 없음") : nil
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
            title: "그래도 안 풀리면 — 막힌 탭 닫기 · 확장 초기화",
            // Smallest first (spec ruling): closing the blocked tab frees only that tab's lease and
            // cuts nobody off; the extension reset comes last.
            steps: [
                "막힌 탭이 있으면 그 탭을 닫아요. 그 탭의 점유만 풀려서 다른 대화는 끊기지 않아요.",
                "그래도 안 풀리면 Chrome에서 chrome://extensions 페이지를 열어 ChatGPT 확장을 껐다가 다시 켜요.",
            ],
            warning: "확장을 껐다 켜면 이 Chrome을 쓰는 모든 CUA 연결의 점유가 한꺼번에 풀려요. 다른 작업 중에는 하지 마세요.",
            liveConnectionsTitle: "확장을 껐다 켜면 끊길 살아 있는 연결",
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

/// One client of another tool, as its line in the 다른 도구 tab. For cmux-cua each is one connection
/// (one `cmux-cua mcp` process), stopped one at a time and never in a group (R17).
struct ToolClientRow: Equatable, Identifiable, Sendable {
    /// What a client whose AI client is gone reads as.
    static let orphanTitle = "주인 없는 연결"
    /// The line a row shows after its normal stop ran out of time.
    static let timedOutNote = "정상 종료가 시간 안에 안 끝남"

    /// The connection id. `pid` is no key: one AI client can hold several connections. An engine
    /// that does not name its clients gets a stand-in by position.
    var id: String
    /// What `stop --connection` takes; nil from an engine that does not name its clients.
    var connectionID: String?
    /// `Claude · dev/z`, `Claude` when the folder is unknown, or 주인 없는 연결.
    var title: String
    /// The full path, for a hover hint.
    var path: String?
    /// `11시간 전 시작`
    var startedText: String
    /// Its AI client is gone, so stopping it cuts nobody off.
    var isOrphan: Bool
    /// 끄기, only when the engine may stop it and named it. A single normal stop asks nothing.
    var buttons: [ButtonSpec]
    /// After a normal stop ran out of time: 끄기 · 강제 종료 (the force stop asks once).
    var timedOutButtons: [ButtonSpec]

    init(_ client: ToolClient, tool: String, index: Int, now: Date) {
        id = client.id ?? "client-\(index)"
        connectionID = client.id
        isOrphan = client.isOrphan
        title = client.isOrphan
            ? Self.orphanTitle
            : client.cwd.map { "\(client.agent.label) · \(Format.folder($0))" } ?? client.agent.label
        path = client.cwd
        startedText = Format.startedAgo(client.startedAt, now: now)
        guard client.canStop, let connection = client.id else {
            buttons = []
            timedOutButtons = []
            return
        }
        let cutOff = client.isOrphan ? "띄운 AI가 없어서 끊길 대화도 없어요" : "그 대화의 \(tool) 도구는 다시 붙을 때까지 끊겨요"
        let stop = ButtonSpec(
            title: "끄기", action: .stopConnection(connection, force: false), help: "이 \(tool) 연결만 정상 종료해요. \(cutOff)")
        let forceStop = ButtonSpec(
            title: "강제 종료", action: .stopConnection(connection, force: true), isDestructive: true,
            help: "정상 종료가 시간 안에 안 끝났어요. 이 연결만 강제로 끝내요")
        buttons = [stop]
        timedOutButtons = [stop, forceStop]
    }
}

struct OtherToolRow: Equatable, Identifiable, Sendable {
    var name: String
    var isRunning: Bool
    var statusText: String
    /// The tool's own processes (`프로세스 n개`). Text only: the daemon is never stopped.
    var detail: String?
    var clients: [ToolClientRow]
    var id: String { name }
}

struct OtherToolsContent: Equatable, Sendable {
    var screen: ScreenLine
    var tools: [OtherToolRow]
    var emptyText: String?

    init(status: EngineStatus, now: Date) {
        if let use = StatusEvaluator.screenUse(in: status) {
            let lastCall = status.screen.lastCallAt ?? use.connection?.lastCallAt
            screen = ScreenLine(
                isActive: true, text: "\(use.subject)가 화면을 쓰는 중",
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
                clients: tool.clients.enumerated().map { ToolClientRow($1, tool: tool.name, index: $0, now: now) })
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
    /// 진단 복사: runs `diagnose` and puts its text on the pasteboard.
    var copyButton = ActivityContent.diagnosisButton

    static let diagnosisButton = ButtonSpec(
        title: "진단 복사", action: .copyDiagnosis, help: "진단 내용을 복사해요. 화면과 요청 내용은 들어 있지 않아요")

    /// What the tab shows while there is no status to read: no rows, but 진단 복사 stays, because
    /// that is exactly when someone needs it (F6).
    static func placeholder(isLoading: Bool) -> ActivityContent {
        ActivityContent(
            rows: [], emptyText: isLoading ? "불러오는 중…" : "상태를 읽지 못해서 기록을 보일 수 없어요",
            copyButton: diagnosisButton)
    }

    init(rows: [ActivityRow], emptyText: String?, copyButton: ButtonSpec) {
        self.rows = rows
        self.emptyText = emptyText
        self.copyButton = copyButton
    }

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
