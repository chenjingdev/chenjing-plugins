import Foundation

enum PopoverTab: String, CaseIterable, Identifiable, Sendable {
    case connections, activity

    var id: String { rawValue }

    var title: String {
        switch self {
        case .connections: "연결"
        case .activity: "기록"
        }
    }

    /// R21: an empty tab says "없음" in one line instead of looking broken.
    var emptyText: String {
        switch self {
        case .connections: "연결 없음"
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

extension ButtonSpec {
    /// 탭 풀기 on a connection whose AI is alive: only the tabs it holds, the connection stays.
    static func releaseTabs(of id: String, isEnabled: Bool) -> ButtonSpec {
        ButtonSpec(
            title: "탭 풀기", action: .releaseConnection(id), isEnabled: isEnabled,
            // A button that is off says why when the pointer rests on it.
            help: isEnabled
                ? "이 AI가 잡고 있는 브라우저 탭만 풀어요. AI는 화면 도구를 계속 써요"
                : "탭을 풀 길이 확인되지 않은 연결이에요. 중계기가 없거나 기록이 없을 때 그래요")
    }

    /// 정리 of an ended connection or of a cmux-cua connection nobody owns; off when the app can do neither
    /// of the two things it would do.
    static func tidy(_ id: String, way: TidyPlan.Way?, isCmux: Bool = false) -> ButtonSpec {
        let help: String
        switch way {
        case .stop?:
            help = isCmux
                ? "남은 연결을 꺼요. 띄운 AI가 이미 없어서 끊길 대화도 없어요. 제때 안 꺼지면 강제로 꺼요"
                : "탭을 풀고 남은 연결을 꺼요. AI가 이미 없어서 끊길 것이 없어요. 제때 안 꺼지면 강제로 꺼요"
        case .releaseOnly?:
            help = "탭만 풀어요. 이 연결은 앱이 끌 수 없어요"
        case nil:
            help = isCmux ? "신원을 확인하지 못한 프로세스라 앱이 끌 수 없어요" : "탭을 풀 길이 없고, 신원을 확인하지 못한 프로세스라 앱이 끌 수도 없어요"
        }
        return ButtonSpec(title: "정리", action: .tidy(id), isEnabled: way != nil, help: help)
    }
}

/// What the two tabs show, already turned into text. The views only lay this out, so the
/// decisions (which button is on, what a row says) are testable without a window.
struct PopoverContent: Equatable, Sendable {
    var connections: ConnectionsContent
    var activity: ActivityContent

    init(status: EngineStatus, now: Date, calendar: Calendar = .current) {
        connections = ConnectionsContent(status: status, now: now, calendar: calendar)
        activity = ActivityContent(status: status, calendar: calendar)
    }
}

// MARK: - 연결: the rows

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
    /// The row's one button: 탭 풀기 when its AI is alive, 정리 when it ended.
    var button: ButtonSpec
    /// After the engine refused a release twice (R15): the same 탭 풀기, which does not ask again. A
    /// live AI is never stopped from here.
    var retryButton: ButtonSpec

    /// The line a row shows after a refused release.
    static let refusedNote = "작업이 끝나지 않아 못 풀었어요"

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
        button = connection.state == .ended
            ? .tidy(connection.id, way: TidyPlan.way(for: connection))
            : .releaseTabs(of: connection.id, isEnabled: connection.canRelease)
        retryButton = ButtonSpec(
            title: "탭 풀기", action: .retryRelease(connection.id), isEnabled: connection.canRelease,
            help: "한 번 더 풀어 봐요. AI가 하던 조작이 끝나야 풀 수 있어요")
    }
}

struct ConnectionGroup: Equatable, Identifiable, Sendable {
    var agent: AgentKind
    /// `Claude · 2`
    var title: String
    var rows: [ConnectionRow]
    var id: String { agent.label }
}

struct LeaseRow: Equatable, Identifiable, Sendable {
    enum Kind: Equatable, Sendable { case held, maybeLeft }

    /// Said instead of a button when this one cannot be released by itself.
    static let noWayHint = "풀 방법이 없어요 — 아래 안내를 따라 주세요"

    var id: String
    var kind: Kind
    var agent: AgentKind
    var folder: String
    /// `점유 중` or `점유가 남았을 수 있음`
    var statusText: String
    var detail: String?
    var sessionID: String?
    /// The 탭 풀기 button is shown.
    var canReleaseSession: Bool
    /// Shown instead of the button when there is no way to release this one by itself.
    var hint: String?
    /// 탭 풀기; nil when there is no session to aim at.
    var releaseButton: ButtonSpec? {
        guard canReleaseSession, let sessionID else { return nil }
        // A button press is a person's click, so `--user` goes along (Codex thread sessions need it).
        return ButtonSpec(title: "탭 풀기", action: .releaseSession(sessionID, user: true), help: "이 세션이 남긴 점유만 풀어요")
    }
}

/// One client of another tool, as its line in the list. For cmux-cua each is one connection (one
/// `cmux-cua mcp` process): a live one is left alone (R17), one nobody owns is tidied.
struct ToolClientRow: Equatable, Identifiable, Sendable {
    /// What a client whose AI client is gone reads as.
    static let orphanTitle = "주인 없는 연결"

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
    /// Its AI client is gone, so tidying it cuts nobody off.
    var isOrphan: Bool
    /// 정리, only on a connection nobody owns that the engine named. A live one has no button.
    var button: ButtonSpec?

    init(_ client: ToolClient, index: Int, now: Date) {
        id = client.id ?? "client-\(index)"
        connectionID = client.id
        isOrphan = client.isOrphan
        title = client.isOrphan
            ? Self.orphanTitle
            : client.cwd.map { "\(client.agent.label) · \(Format.folder($0))" } ?? client.agent.label
        path = client.cwd
        startedText = Format.startedAgo(client.startedAt, now: now)
        if client.isOrphan, let connection = client.id, ToolClient.isCmuxConnection(id: connection) {
            button = .tidy(connection, way: TidyPlan.way(for: client), isCmux: true)
        } else {
            button = nil
        }
    }
}

// MARK: - 연결: the list

struct ScreenLine: Equatable, Sendable {
    var isActive: Bool
    var text: String
    var detail: String?

    /// One line: `Claude(dev/x)가 화면을 쓰는 중 · 방금 호출`.
    var line: String { detail.map { "\(text) · \($0)" } ?? text }

    init(isActive: Bool, text: String, detail: String?) {
        self.isActive = isActive
        self.text = text
        self.detail = detail
    }

    init(status: EngineStatus, now: Date) {
        if let use = StatusEvaluator.screenUse(in: status) {
            let lastCall = status.screen.lastCallAt ?? use.connection?.lastCallAt
            self.init(
                isActive: true, text: "\(use.subject)가 화면을 쓰는 중",
                detail: lastCall.map { "\(Format.ago($0, now: now)) 호출" })
        } else {
            self.init(
                isActive: false, text: "지금 화면을 쓰는 연결 없음",
                detail: status.screen.lastCallAt.map { "마지막 호출 \(Format.ago($0, now: now))" })
        }
    }
}

/// One tool that is not Claude or Codex (cmux-cua) with the conversations that hold it open. Its
/// daemon is text only and never stopped; a connection nobody owns is a line of 손볼 것 instead.
struct OtherToolRow: Equatable, Identifiable, Sendable {
    var name: String
    var isRunning: Bool
    var statusText: String
    /// The tool's own processes (`프로세스 n개`).
    var detail: String?
    /// The clients that still have an AI client: no button, their conversation is using them.
    var clients: [ToolClientRow]
    var id: String { name }

    /// `cmux-cua · 실행 중 · 프로세스 2개`, or `cmux-cua · 꺼져 있음`.
    var title: String { ([name, statusText] + (detail.map { [$0] } ?? [])).joined(separator: " · ") }
}

/// One line of 손볼 것.
enum TidyRow: Equatable, Identifiable, Sendable {
    case ended(ConnectionRow)
    case lease(LeaseRow)
    case orphan(ToolClientRow)

    var id: String {
        switch self {
        case .ended(let row): "ended-\(row.id)"
        case .lease(let row): "lease-\(row.id)"
        case .orphan(let row): "orphan-\(row.id)"
        }
    }

    var endedRow: ConnectionRow? { if case .ended(let row) = self { row } else { nil } }
    var leaseRow: LeaseRow? { if case .lease(let row) = self { row } else { nil } }
    var orphanRow: ToolClientRow? { if case .orphan(let row) = self { row } else { nil } }
}

/// 손볼 것: what the app can clean up, at the top of the list with 모두 정리 above it.
struct TidyContent: Equatable, Sendable {
    /// `손볼 것 3개`
    var title: String
    var rows: [TidyRow]
    /// R14: said once, here, when a lease line is shown and the lease list cannot be read.
    var notice: String?
    var tidyAllButton: ButtonSpec
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

/// The one list: who uses the screen, what needs tidying, the live connections, the other tools,
/// and the folded guidance for tabs that stay blocked.
struct ConnectionsContent: Equatable, Sendable {
    var screen: ScreenLine
    /// nil when there is nothing to tidy.
    var tidy: TidyContent?
    /// The connections whose AI is alive, Claude then Codex: a 탭 풀기 on each line.
    var groups: [ConnectionGroup]
    var tools: [OtherToolRow]
    /// R21: no connection of any kind.
    var emptyText: String?
    var guidance: ExtensionResetGuidance

    init(status: EngineStatus, now: Date, calendar: Calendar) {
        screen = ScreenLine(status: status, now: now)

        let live = status.connections.filter { $0.state != .ended }.sorted(by: TidyPlan.newestFirst)
        var agents: [AgentKind] = []
        for connection in live where !agents.contains(connection.agent) { agents.append(connection.agent) }
        let rank: (AgentKind) -> Int = { $0 == .claude ? 0 : ($0 == .codex ? 1 : 2) }
        agents = agents.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map(\.element)
        groups = agents.map { agent in
            let rows = live.filter { $0.agent == agent }.map { ConnectionRow($0, now: now, calendar: calendar) }
            return ConnectionGroup(agent: agent, title: "\(agent.label) · \(rows.count)", rows: rows)
        }

        tools = status.otherTools.map { tool in
            let clients = tool.clients.enumerated().filter { !$0.element.isOrphan }
                .map { ToolClientRow($0.element, index: $0.offset, now: now) }
            return OtherToolRow(
                name: tool.name, isRunning: tool.running, statusText: tool.running ? "실행 중" : "꺼져 있음",
                detail: tool.running && !tool.pids.isEmpty ? "프로세스 \(tool.pids.count)개" : nil,
                clients: tool.running ? clients : [])
        }

        // 손볼 것: the ended connections (newest first), the leases, the connections nobody owns.
        let ended = TidyPlan.endedConnections(in: status).map { TidyRow.ended(ConnectionRow($0, now: now, calendar: calendar)) }
        let leases = Self.leaseRows(in: status, live: live, now: now, calendar: calendar)
        let orphans = status.otherTools.flatMap { tool in
            tool.clients.enumerated().filter { $0.element.isOrphan }.map { TidyRow.orphan(ToolClientRow($0.element, index: $0.offset, now: now)) }
        }
        let rows = ended + leases.map(TidyRow.lease) + orphans
        if rows.isEmpty {
            tidy = nil
        } else {
            let hasTargets = !TidyPlan.items(in: status).isEmpty
            let codexChatLeft = leases.contains { $0.agent == .codex && $0.releaseButton != nil }
            tidy = TidyContent(
                title: "손볼 것 \(rows.count)개", rows: rows,
                // R14: with no readable list the app says what it knows and never invents a count.
                notice: !leases.isEmpty && !status.leases.readable ? "점유 목록을 읽지 못해서, 끝난 연결 기록으로 보여요" : nil,
                tidyAllButton: ButtonSpec(
                    title: "모두 정리", action: .tidyAll, isEnabled: hasTargets,
                    help: hasTargets
                        ? "끝난 연결과 남은 점유를 한 번에 정리해요"
                        : (codexChatLeft ? "Codex 대화가 남긴 점유는 그 줄에서 풀어 주세요" : "앱이 정리할 수 있는 것이 없어요")))
        }

        let hasClients = tools.contains { !$0.clients.isEmpty }
        emptyText = rows.isEmpty && groups.isEmpty && !hasClients ? PopoverTab.connections.emptyText : nil

        guidance = ExtensionResetGuidance(
            title: "브라우저 탭이 계속 막히면",
            // Smallest first (spec ruling): closing the blocked tab frees only that tab's lease and
            // cuts nobody off; the extension reset comes last.
            steps: [
                "막힌 탭이 있으면 그 탭을 닫아요. 그 탭의 점유만 풀려서 다른 대화는 끊기지 않아요.",
                "그래도 안 풀리면 Chrome에서 chrome://extensions 페이지를 열어 ChatGPT 확장을 껐다가 다시 켜요.",
            ],
            warning: "확장을 껐다 켜면 이 Chrome을 쓰는 모든 CUA 연결의 점유가 한꺼번에 풀려요. 다른 작업 중에는 하지 마세요.",
            liveConnectionsTitle: "확장을 껐다 켜면 끊길 살아 있는 연결",
            liveConnections: groups.flatMap(\.rows).map { row in row.path == nil ? row.agent.label : "\(row.agent.label) · \(row.folder)" },
            liveConnectionsEmptyText: "없음",
            needsAttention: leases.contains { $0.kind == .maybeLeft && !$0.canReleaseSession })
    }

    /// The lease lines: what the engine could read (`items`) unless a live connection's own session
    /// holds it, then the sessions whose owner is gone (`maybe_left`).
    private static func leaseRows(in status: EngineStatus, live: [Connection], now: Date, calendar: Calendar) -> [LeaseRow] {
        let leases = status.leases
        let liveSessions = Set(live.compactMap(\.sessionID))
        let leftSessions = Set(leases.maybeLeft.compactMap(\.sessionID))
        var rows: [LeaseRow] = []
        for (index, item) in leases.items.enumerated() {
            // A live connection's own tabs are not for tidying; neither is a session already listed as left.
            if let session = item.sessionID, liveSessions.contains(session) || leftSessions.contains(session) { continue }
            var parts: [String] = []
            if let since = item.since { parts.append("\(Format.when(since, now: now, calendar: calendar))부터") }
            if let session = item.sessionID { parts.append("세션 \(shortSession(session))") }
            rows.append(LeaseRow(
                id: "held-\(item.sessionID ?? item.connectionID ?? String(index))", kind: .held, agent: item.agent,
                folder: Format.folder(item.cwd), statusText: "점유 중", detail: parts.isEmpty ? nil : parts.joined(separator: " · "),
                sessionID: item.sessionID, canReleaseSession: item.sessionID != nil && item.releasable, hint: nil))
        }
        for (index, item) in leases.maybeLeft.enumerated() {
            var parts: [String] = []
            if let ended = item.endedAt { parts.append("\(Format.when(ended, now: now, calendar: calendar))에 끝남") }
            if let session = item.sessionID { parts.append("세션 \(shortSession(session))") }
            let releasable = item.sessionID != nil && item.releasable
            rows.append(LeaseRow(
                id: "left-\(item.sessionID ?? item.connectionID ?? String(index))", kind: .maybeLeft, agent: item.agent,
                folder: Format.folder(item.cwd), statusText: "점유가 남았을 수 있음", detail: parts.isEmpty ? nil : parts.joined(separator: " · "),
                sessionID: item.sessionID, canReleaseSession: releasable, hint: releasable ? nil : LeaseRow.noWayHint))
        }
        return rows
    }

    private static func shortSession(_ id: String) -> String { String(id.prefix(8)) }

    /// The connection with this id on any line of the list: a live one, or an ended one in 손볼 것.
    func row(withID id: String) -> ConnectionRow? {
        groups.flatMap(\.rows).first { $0.id == id } ?? tidy?.rows.compactMap(\.endedRow).first { $0.id == id }
    }

    /// The cmux-cua connection nobody owns with this id, in 손볼 것.
    func orphanRow(withID id: String) -> ToolClientRow? {
        tidy?.rows.compactMap(\.orphanRow).first { $0.connectionID == id }
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
    /// 진단 복사: runs `diagnose` and puts its text on the pasteboard. It sits at the bottom of the tab.
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
                folder: Format.folder(connection?.cwd), tool: Format.tool(entry.tool), ok: entry.ok,
                durationText: Format.milliseconds(entry.ms))
        }
        emptyText = rows.isEmpty ? PopoverTab.activity.emptyText : nil
    }
}
