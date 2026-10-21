import Foundation

/// The one menu bar icon. Three states, ordered by importance: problem > working > ready (R13).
enum IconState: String, CaseIterable, Equatable, Sendable {
    case ready, working, problem

    var accessibilityDescription: String {
        switch self {
        case .ready: "CUA 준비됨"
        case .working: "CUA 작업 중"
        case .problem: "CUA 문제"
        }
    }
}

/// The problems the status card can show, in the order they win (first match).
enum ProblemKind: String, CaseIterable, Sendable {
    case codexMissing = "codex_missing"
    /// The Mac has no developer tools, which the engine's launcher needs: asked for on the card, never opened by itself.
    case developerToolsNeeded = "developer_tools_needed"
    /// The engine, its Python environment, the wrapper, the relay, or Claude Code's MCP server or skill is
    /// missing, broken or of another version: the card's 고치기 installs it all again.
    case setupIncomplete = "setup_incomplete"
    /// An MCP server or a skill named cua that the app did not put into Claude Code: left alone, told.
    case claudeConflict = "claude_conflict"
    case codexWithoutHost = "codex_without_host"
    /// The login environment value the wrapper needs is set to somebody else's: the setup leaves it alone, so only
    /// the person can clear it (the check tab says how).
    case loginEnvironmentConflict = "login_environment_conflict"
    case endedConnections = "ended_connections"
    case leasesMaybeLeft = "leases_maybe_left"
    /// Not in the spec's list: the app could not read the engine's answer at all.
    case engineUnreadable = "engine_unreadable"
}

struct Problem: Equatable, Sendable {
    var kind: ProblemKind
    /// One plain sentence; also the tail of the tooltip.
    var title: String
    /// "다음에 할 일", one line.
    var nextStep: String
    var warning: String?
    /// The action behind the fix button; nil when no button helps.
    var fix: CUAAction?
    var fixLabel: String?
}

/// Everything the menu bar item and the status card show, derived from one engine answer.
struct StatusSummary: Equatable, Sendable {
    var icon: IconState
    var stateLabel: String
    var headline: String
    var nextStep: String
    var warning: String?
    var problem: Problem?
    var tooltip: String
    var accessibilityLabel: String
    /// True before the first answer arrived; the icon is dimmed instead of claiming "ready".
    var isPlaceholder = false

    var fix: CUAAction? { problem?.fix }
    var fixLabel: String? { problem?.fixLabel }
}

/// What the app knows by itself besides the engine's answer: what Claude Code has of CUA, whether the
/// developer tools are missing, and whether there is no Codex app (the engine cannot say before it is installed).
struct LocalFacts: Equatable, Sendable {
    var claude = ClaudeSetupState.none
    var developerToolsNeeded = false
    var codexMissing = false
}

enum StatusEvaluator {
    // MARK: Entry points

    /// `tabsReleased`: the ended connections the app may only release, whose tabs it released in this run
    /// (see `problem`).
    static func evaluate(
        _ status: EngineStatus, appVersion: String?, tabsReleased: Set<String> = [], facts: LocalFacts = LocalFacts()
    ) -> StatusSummary {
        if let problem = problem(in: status, appVersion: appVersion, tabsReleased: tabsReleased, facts: facts) {
            return summary(for: problem)
        }
        // Not a problem (nothing is broken and the icon stays ready), but nothing else would say why
        // the connections of a Codex from before the update cannot be released. Said while working
        // too, or the card would drop it each time an AI uses the screen.
        let restartApplies = status.codex.running && status.host.startedBeforeSetup
        if let use = screenUse(in: status) {
            let sentence = "\(use.subject)가 화면을 쓰는 중"
            return StatusSummary(
                icon: .working, stateLabel: "작업 중", headline: sentence,
                nextStep: restartApplies ? restartAppliesStep : "없음",
                warning: restartApplies ? restartAppliesWarning : nil, problem: nil,
                tooltip: "CUA 작업 중 · \(sentence)", accessibilityLabel: IconState.working.accessibilityDescription)
        }
        let counts = connectionCounts(in: status)
        let codexIsOffButStartable = status.codex.installed == true && !status.codex.running
        return StatusSummary(
            icon: .ready, stateLabel: "준비됨",
            headline: counts.isEmpty ? "연결 없음" : "연결 " + counts,
            nextStep: restartApplies ? restartAppliesStep
                : codexIsOffButStartable ? "없음 — Claude 대화를 열면 Codex가 뒤에서 켜져요" : "없음",
            warning: restartApplies ? restartAppliesWarning : nil, problem: nil,
            tooltip: "CUA 준비됨 · " + (counts.isEmpty ? "연결 없음" : counts),
            accessibilityLabel: IconState.ready.accessibilityDescription)
    }

    /// For a Codex that a launcher older than this setup started (S8).
    static let restartAppliesStep = "Codex를 다시 켜면 새 설정이 적용돼요"
    static let restartAppliesWarning = "갱신 전에 켜진 Codex라 그 연결은 상태를 모르거나 탭을 풀 수 없을 수 있어요"

    /// The card's next steps for a problem that belongs to a line of the list.
    static let tidyStep = "목록 맨 위의 정리를 눌러 주세요"
    /// A leftover lease's line has 탭 풀기, so the card names that button and not 정리.
    static let releaseLeasesStep = "목록 맨 위의 탭 풀기를 눌러 주세요"
    static let noWayToReleaseStep = "하나씩 풀 방법이 없어요 — 목록 맨 아래 안내를 따라 주세요"
    static let cannotTidyStep = "앱이 정리할 수 없는 연결이에요 — 목록에서 까닭을 보세요"
    /// Only ended connections the app may release but not stop are left, and it released their tabs.
    static let tabsReleasedStep = "앱이 끌 수 없는 끝난 연결이에요 — 탭은 풀었어요"

    /// The summary when the engine gave no usable status.
    ///
    /// What the app's own install can repair (no engine, a command that fails or prints something unreadable
    /// because it is old or broken, an engine too new to read) is the setup problem with 고치기, unless the
    /// install cannot start: no Codex app, or no developer tools. Those say so instead.
    static func summary(for error: EngineError, facts: LocalFacts = LocalFacts()) -> StatusSummary {
        if error.needsEngineInstall {
            if facts.codexMissing { return summary(for: codexMissingProblem) }
            if facts.developerToolsNeeded { return summary(for: developerToolsProblem) }
        }
        switch error {
        case .engineMissing:
            return summary(for: Problem(
                kind: .setupIncomplete, title: "연결 엔진이 없어요", nextStep: "고치기를 누르면 엔진을 설치해요",
                warning: nil, fix: .runSetup, fixLabel: "고치기"))
        case .setupNeeded:
            return summary(for: Problem(
                kind: .setupIncomplete, title: "연결 설정이 아직 안 됐어요", nextStep: "고치기를 누르면 연결을 설정해요",
                warning: nil, fix: .runSetup, fixLabel: "고치기"))
        case .commandFailed, .invalidOutput:
            return summary(for: staleCommandProblem)
        case .unsupportedSchema:
            return summary(for: Problem(
                kind: .setupIncomplete, title: "앱이 이 엔진 판을 읽지 못해요", nextStep: "고치기를 누르면 앱의 엔진으로 다시 설정해요",
                warning: nil, fix: .runSetup, fixLabel: "고치기"))
        case .launchFailed:
            // The command is there but does not start (it lost its executable bit, say): the install writes it again.
            return summary(for: Problem(
                kind: .setupIncomplete, title: "연결 명령을 실행하지 못했어요", nextStep: "고치기를 누르면 연결을 다시 설정해요",
                warning: nil, fix: .runSetup, fixLabel: "고치기"))
        case .timeout:
            return summary(for: Problem(
                kind: .engineUnreadable, title: "상태를 읽지 못했어요", nextStep: "잠시 뒤 다시 읽어 보세요",
                warning: error.message, fix: .refresh, fixLabel: "다시 읽기"))
        }
    }

    static let codexMissingProblem = Problem(
        kind: .codexMissing, title: "Codex 앱이 없어요", nextStep: "Codex 앱을 받아 설치해 주세요",
        warning: nil, fix: .openCodexDownload, fixLabel: "받는 곳 열기")

    /// The engine's launcher runs on the system's Python, which comes with the developer tools. The app does
    /// not open their installer by itself (it would take the screen); the button does.
    static let developerToolsProblem = Problem(
        kind: .developerToolsNeeded, title: "개발자 도구 필요", nextStep: "설치를 누르면 macOS 설치 창이 떠요. 끝나면 한 번 더 눌러 주세요",
        warning: nil, fix: .installDeveloperTools, fixLabel: "설치")

    static let loading = StatusSummary(
        icon: .ready, stateLabel: "확인 중", headline: "상태를 확인하는 중이에요", nextStep: "없음", warning: nil, problem: nil,
        tooltip: "CUA 확인 중…", accessibilityLabel: "CUA 확인 중", isPlaceholder: true)

    // MARK: Problems

    /// The first problem that applies:
    /// Codex missing > setup incomplete (or the developer tools it needs) > Codex without a host >
    /// a login environment someone else set > a conflict in Claude Code > ended connections > leftover leases. (A missing engine comes from
    /// `summary(for:)`, because without the command there is no status to look at.)
    ///
    /// The card has a fix button only for a problem of the whole app. An ended connection or a leftover
    /// lease is one line's problem: the card says what to do and the button is on that line (F2). A conflict
    /// has no button either: the app does not touch what it did not put there. So the problems that have a
    /// button come first, and a conflict someone left on purpose (their own cua server) does not hide them.
    ///
    /// `tabsReleased` holds the ended connections the app may only release (it may not stop them) whose
    /// tabs it released in this run. Once that is all that is left, the card says so instead of sending
    /// the person to 정리 again; it never says the tabs are released when it does not know.
    static func problem(
        in status: EngineStatus, appVersion: String?, tabsReleased: Set<String> = [], facts: LocalFacts = LocalFacts()
    ) -> Problem? {
        if status.codex.installed == false { return codexMissingProblem }
        let issues = setupIssues(in: status.setup) + engineIssues(in: status.engine, appVersion: appVersion) + claudeIssues(in: facts.claude)
        if !issues.isEmpty {
            if facts.developerToolsNeeded { return developerToolsProblem }
            let title = issues.count == 1
                ? issues[0].sentence
                : "연결 설정에 문제가 있어요 — " + issues.map(\.name).joined(separator: " · ")
            return Problem(
                kind: .setupIncomplete, title: title, nextStep: "고치기를 누르면 설정을 다시 맞춰요",
                warning: nil, fix: .runSetup, fixLabel: "고치기")
        }
        if status.codex.running, status.host.state != .ready, status.host.state != .starting, status.host.state != .stopping {
            return Problem(
                kind: .codexWithoutHost, title: "Codex가 연결 없이 켜져 있어요", nextStep: "다시 켜면 Claude가 붙어요",
                warning: "하던 Codex 작업이 끊길 수 있어요", fix: .restartCodex, fixLabel: "다시 켜기")
        }
        if status.setup.loginEnvironment == "conflict" { return loginEnvironmentConflictProblem }
        if let conflict = conflictProblem(in: facts.claude) { return conflict }
        let ended = status.connections.filter { $0.state == .ended }
        if !ended.isEmpty {
            // Still a problem for the icon, but with no button: the line itself has 정리. 정리 has
            // something to do while one of them can be stopped, or released and not yet released. The card
            // says the tabs were released only when that is so for all of them; with one the app can do
            // nothing for among them, each line says its own reason.
            let worthTidying = ended.contains { connection in
                TidyPlan.way(for: connection) != nil && !TidyPlan.isSettled(connection, tabsReleased: tabsReleased)
            }
            let settled = ended.allSatisfy { TidyPlan.isSettled($0, tabsReleased: tabsReleased) }
            return Problem(
                kind: .endedConnections, title: "끝난 연결이 \(ended.count)개 남아 있어요",
                nextStep: worthTidying ? tidyStep : settled ? tabsReleasedStep : cannotTidyStep,
                warning: nil, fix: nil, fixLabel: nil)
        }
        // A lease the line of a connection lets go of is no problem of its own: that line is where to press (S16).
        let leftover = status.leases.maybeLeft.filter { TidyPlan.lineToPress(for: $0, in: status, tabsReleased: tabsReleased) == nil }
        if !leftover.isEmpty {
            // No count: when the lease list cannot be read, the number would be a guess (R14).
            let aimable = leftover.filter { $0.releasable && $0.sessionID != nil }
            let nextStep = aimable.isEmpty ? noWayToReleaseStep : releaseLeasesStep
            return Problem(
                kind: .leasesMaybeLeft, title: "점유가 남았을 수 있어요", nextStep: nextStep,
                warning: nil, fix: nil, fixLabel: nil)
        }
        return nil
    }

    /// The engine that answered is not the app's: another version, or none (an engine from before the app carried
    /// one names no version). The install judges it the same way, so what the card offers is what 고치기 does.
    /// Without the app's own version (a build outside the bundle) there is nothing to compare with.
    static func engineIssues(in engine: EngineInfo, appVersion: String?) -> [SetupIssue] {
        guard let appVersion = nonEmpty(appVersion), nonEmpty(engine.version) != appVersion else { return [] }
        return [SetupIssue(name: "엔진", sentence: "연결 엔진이 앱과 판이 달라요")]
    }

    /// The MCP server or the skill is missing or the app's own and out of date. Nothing is said without
    /// Claude Code: it is not a problem of the Mac, and it is put off until Claude Code is there.
    static func claudeIssues(in claude: ClaudeSetupState) -> [SetupIssue] {
        guard claude.claudeCodeFound, !claude.claudeCodeUnusable else { return [] }
        var issues: [SetupIssue] = []
        switch claude.mcp {
        case .missing: issues.append(SetupIssue(name: "MCP", sentence: "Claude Code에 CUA가 연결되지 않았어요"))
        case .outdated: issues.append(SetupIssue(name: "MCP", sentence: "Claude Code의 CUA 연결이 옛 판이에요"))
        case .ready, .conflict, .unknown: break
        }
        switch claude.skill {
        case .missing: issues.append(SetupIssue(name: "스킬", sentence: "Claude Code에 CUA 스킬이 없어요"))
        case .outdated: issues.append(SetupIssue(name: "스킬", sentence: "Claude Code의 CUA 스킬이 옛 판이에요"))
        case .ready, .conflict, .unknown: break
        }
        return issues
    }

    /// An MCP server or a skill named cua that is not the app's.
    static func conflictProblem(in claude: ClaudeSetupState) -> Problem? {
        guard claude.claudeCodeFound, !claude.claudeCodeUnusable else { return nil }
        let title: String
        switch (claude.mcp == .conflict, claude.skill == .conflict) {
        case (true, true): title = "Claude Code에 앱이 깔지 않은 cua MCP와 스킬이 있어요"
        case (true, false): title = "Claude Code에 앱이 깔지 않은 cua MCP가 있어요"
        case (false, true): title = "Claude Code에 앱이 깔지 않은 cua 스킬이 있어요"
        case (false, false): return nil
        }
        return Problem(
            kind: .claudeConflict, title: title, nextStep: "점검 탭에서 지우는 방법을 보세요", warning: nil, fix: nil, fixLabel: nil)
    }

    /// The setup leaves a launchd value somebody else set as it is (`login_environment: conflict`), so 고치기 could not
    /// change it: no button, and the check tab shows the value and how to clear it.
    static let loginEnvironmentConflictProblem = Problem(
        kind: .loginEnvironmentConflict, title: "Codex 로그인 설정이 다른 값과 겹쳐요",
        nextStep: "점검 탭에서 겹치는 값과 지우는 방법을 보세요", warning: nil, fix: nil, fixLabel: nil)

    private static func summary(for problem: Problem) -> StatusSummary {
        StatusSummary(
            icon: .problem, stateLabel: "문제", headline: problem.title, nextStep: problem.nextStep, warning: problem.warning,
            problem: problem, tooltip: "CUA 문제 · \(problem.title)", accessibilityLabel: "CUA 문제: \(problem.title)")
    }

    // MARK: Setup

    struct SetupIssue: Equatable {
        /// Short name used when several things are wrong at once.
        var name: String
        var sentence: String
    }

    /// Fields the contract marks as failing. `unknown` and `inactive` are not failures: the
    /// engine could not tell, or Codex is simply off.
    static func setupIssues(in setup: SetupInfo) -> [SetupIssue] {
        var issues: [SetupIssue] = []
        if setup.command == "missing" { issues.append(SetupIssue(name: "명령", sentence: "연결 명령이 없어요")) }
        if setup.dependencies == "missing" { issues.append(SetupIssue(name: "구성 요소", sentence: "필요한 구성 요소가 없어요")) }
        // `conflict` is not one: the setup does not overwrite somebody else's value, so it has a card of its own.
        switch setup.loginEnvironment {
        case "missing": issues.append(SetupIssue(name: "로그인 환경", sentence: "로그인 환경이 설정되지 않았어요"))
        case "stale": issues.append(SetupIssue(name: "로그인 환경", sentence: "로그인 환경이 옛 설정이에요"))
        default: break
        }
        switch setup.wrapper {
        case "missing": issues.append(SetupIssue(name: "래퍼", sentence: "Codex 연결용 래퍼가 없어요"))
        case "broken": issues.append(SetupIssue(name: "래퍼", sentence: "Codex 연결용 래퍼가 깨졌어요"))
        default: break
        }
        if setup.relay == "unavailable" { issues.append(SetupIssue(name: "중계기", sentence: "중계기를 쓸 수 없어요")) }
        return issues
    }

    // MARK: Who is using the screen

    struct ScreenUse: Equatable {
        var agentLabel: String
        var folder: String?
        var connection: Connection?

        /// `Claude(dev/x)` or just `Claude` when the folder is unknown.
        var subject: String { folder.map { "\(agentLabel)(\($0))" } ?? agentLabel }
    }

    /// The connection that has the screen: the one the engine names (a CUA call in the last
    /// 10 s), else one whose tool call is still in flight.
    static func screenUse(in status: EngineStatus) -> ScreenUse? {
        if let id = status.screen.activeConnectionID {
            if let connection = status.connection(withID: id) {
                return ScreenUse(agentLabel: connection.agent.label, folder: knownFolder(connection.cwd), connection: connection)
            }
            return ScreenUse(agentLabel: agentLabel(fromConnectionID: id), folder: nil, connection: nil)
        }
        if let busy = status.connections.first(where: { $0.busy }) {
            return ScreenUse(agentLabel: busy.agent.label, folder: knownFolder(busy.cwd), connection: busy)
        }
        return nil
    }

    /// Connection ids look like `<agent>-<pid>-<start epoch>`.
    static func agentLabel(fromConnectionID id: String) -> String {
        let agent = AgentKind(raw: id.split(separator: "-").first.map(String.init))
        switch agent {
        case .claude, .codex: return agent.label
        case .other: return "AI"
        }
    }

    // MARK: Helpers

    /// `Claude 1 · Codex 1` for the connections that are not ended; empty when there are none.
    private static func connectionCounts(in status: EngineStatus) -> String {
        var order: [AgentKind] = []
        var counts: [AgentKind: Int] = [:]
        for connection in status.connections where connection.state != .ended {
            if counts[connection.agent] == nil { order.append(connection.agent) }
            counts[connection.agent, default: 0] += 1
        }
        let rank: (AgentKind) -> Int = { $0 == .claude ? 0 : ($0 == .codex ? 1 : 2) }
        return order.enumerated()
            .sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }
            .map { "\($0.element.label) \(counts[$0.element] ?? 0)" }
            .joined(separator: " · ")
    }

    private static func knownFolder(_ path: String?) -> String? {
        guard let path, !path.isEmpty else { return nil }
        return Format.folder(path)
    }

    private static func nonEmpty(_ text: String?) -> String? {
        guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed
    }
}
