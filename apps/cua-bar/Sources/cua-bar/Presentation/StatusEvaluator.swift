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
    case pluginMissing = "plugin_missing"
    case versionMismatch = "version_mismatch"
    case setupIncomplete = "setup_incomplete"
    case codexWithoutHost = "codex_without_host"
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

enum StatusEvaluator {
    // MARK: Entry points

    /// `releaseTried`: the ended connections this app run has already tried to release (see `problem`).
    static func evaluate(_ status: EngineStatus, appVersion: String?, releaseTried: Set<String> = []) -> StatusSummary {
        if let problem = problem(in: status, appVersion: appVersion, releaseTried: releaseTried) { return summary(for: problem) }
        if let use = screenUse(in: status) {
            let sentence = "\(use.subject)가 화면을 쓰는 중"
            return StatusSummary(
                icon: .working, stateLabel: "작업 중", headline: sentence, nextStep: "없음", warning: nil, problem: nil,
                tooltip: "CUA 작업 중 · \(sentence)", accessibilityLabel: IconState.working.accessibilityDescription)
        }
        let counts = connectionCounts(in: status)
        let codexIsOffButStartable = status.codex.installed == true && !status.codex.running
        return StatusSummary(
            icon: .ready, stateLabel: "준비됨",
            headline: counts.isEmpty ? "연결 없음" : "연결 " + counts,
            nextStep: codexIsOffButStartable ? "없음 — Claude 대화를 열면 Codex가 뒤에서 켜져요" : "없음",
            warning: nil, problem: nil,
            tooltip: "CUA 준비됨 · " + (counts.isEmpty ? "연결 없음" : counts),
            accessibilityLabel: IconState.ready.accessibilityDescription)
    }

    /// The summary when the engine gave no usable status.
    ///
    /// A command that fails or prints something unreadable while the plugin registered with
    /// Claude Code is a different version from the app is most likely an old plugin that does not
    /// know `status` yet (0.5.0 exits 2), so it is the version problem, not a read problem. When the
    /// registered version is the app's, the command itself is old or broken: setup replaces it.
    /// Before either: a command that fails while Claude Code has no plugin, or one whose folder is
    /// gone, is that plugin problem; the command only hands over to it.
    static func summary(
        for error: EngineError, appVersion: String? = nil, registeredPluginVersion: String? = nil, plugin: PluginPresence = .unknown
    ) -> StatusSummary {
        if error.mayComeFromAnOldCommand, plugin == .absent || plugin == .broken {
            return summary(for: plugin == .absent ? missingPluginProblem : brokenPluginProblem)
        }
        if error.mayComeFromAnOldCommand, let pluginVersion = nonEmpty(registeredPluginVersion), let appVersion = nonEmpty(appVersion) {
            return summary(for: pluginVersion == appVersion
                ? staleCommandProblem
                : versionMismatchProblem(appVersion: appVersion, pluginVersion: pluginVersion))
        }
        switch error {
        case .pluginMissing:
            return summary(for: missingPluginProblem)
        case .setupNeeded:
            return summary(for: Problem(
                kind: .setupIncomplete, title: "연결 설정이 아직 안 됐어요", nextStep: "고치기를 누르면 연결을 설정해요",
                warning: nil, fix: .runSetup, fixLabel: "고치기"))
        case .unsupportedSchema:
            return summary(for: Problem(
                kind: .versionMismatch, title: "앱이 이 플러그인 판을 읽지 못해요", nextStep: "맞는 판을 받아 주세요",
                warning: nil, fix: .matchPluginVersion, fixLabel: "맞는 판 받기"))
        case .timeout, .commandFailed, .launchFailed, .invalidOutput:
            return summary(for: Problem(
                kind: .engineUnreadable, title: "상태를 읽지 못했어요", nextStep: "잠시 뒤 다시 읽어 보세요",
                warning: error.message, fix: .refresh, fixLabel: "다시 읽기"))
        }
    }

    static let missingPluginProblem = Problem(
        kind: .pluginMissing, title: "Claude 플러그인이 없어요", nextStep: "Claude 플러그인을 설치해 주세요",
        warning: nil, fix: .installPlugin, fixLabel: "설치")

    /// Claude Code lists the plugin, but its folder is gone: installing again over the record does
    /// nothing, so the fix takes the record away first (`installPlugin`).
    static let brokenPluginProblem = Problem(
        kind: .pluginMissing, title: "Claude 플러그인 폴더가 없어요", nextStep: "다시 설치를 누르면 플러그인을 다시 받아요",
        warning: nil, fix: .installPlugin, fixLabel: "다시 설치")

    static let loading = StatusSummary(
        icon: .ready, stateLabel: "확인 중", headline: "상태를 확인하는 중이에요", nextStep: "없음", warning: nil, problem: nil,
        tooltip: "CUA 확인 중…", accessibilityLabel: "CUA 확인 중", isPlaceholder: true)

    // MARK: Problems

    /// The first problem that applies, in the spec's order (the missing plugin comes from
    /// `summary(for:)`, because without the command there is no status to look at):
    /// Codex missing > version mismatch > setup incomplete > Codex without a host >
    /// ended connections > leftover leases.
    ///
    /// `releaseTried` holds the ended connections this app run has tried to release (the automatic
    /// cleanup's finished runs, a person's successful release).
    static func problem(in status: EngineStatus, appVersion: String?, releaseTried: Set<String> = []) -> Problem? {
        if status.codex.installed == false {
            return Problem(
                kind: .codexMissing, title: "Codex 앱이 없어요", nextStep: "Codex 앱을 받아 설치해 주세요",
                warning: nil, fix: .openCodexDownload, fixLabel: "받는 곳 열기")
        }
        if let pluginVersion = nonEmpty(status.plugin.version), let appVersion = nonEmpty(appVersion), pluginVersion != appVersion {
            return versionMismatchProblem(appVersion: appVersion, pluginVersion: pluginVersion)
        }
        let issues = setupIssues(in: status.setup)
        if !issues.isEmpty {
            let title = issues.count == 1
                ? issues[0].sentence
                : "연결 설정에 문제가 있어요 — " + issues.map(\.name).joined(separator: " · ")
            return Problem(
                kind: .setupIncomplete, title: title, nextStep: "고치기를 누르면 설정을 다시 맞춰요",
                warning: nil, fix: .runSetup, fixLabel: "고치기")
        }
        if status.codex.running, status.host.state != .ready, status.host.state != .starting {
            return Problem(
                kind: .codexWithoutHost, title: "Codex가 연결 없이 켜져 있어요", nextStep: "다시 켜면 Claude가 붙어요",
                warning: "하던 Codex 작업이 끊길 수 있어요", fix: .restartCodex, fixLabel: "다시 켜기")
        }
        let ended = status.connections.filter { $0.state == .ended }
        if !ended.isEmpty {
            let title = "끝난 연결이 \(ended.count)개 남아 있어요"
            // The engine keeps a released connection `ended` while its runtime lives, so releasing
            // never clears this card. Once every one was tried this run, or cannot be released at all
            // (no control endpoint: 0.5.0 bridges), the way to clean up is to stop them (the plugin
            // releases once more on exit). Until then the fix is the release (R13, changed by main).
            let stoppable = ended.filter(\.canStop).count
            let untried = ended.filter { $0.canRelease && !releaseTried.contains($0.id) }
            if untried.isEmpty, stoppable > 0 {
                let nextStep = ended.contains(where: \.canRelease)
                    ? "놓아주기는 해 봤어요. 꺼서 정리해요" : "놓아줄 길이 없는 연결이라 꺼서 정리해요"
                return Problem(
                    kind: .endedConnections, title: title, nextStep: nextStep,
                    warning: nil, fix: .stopEnded, fixLabel: "끝난 연결 끄기 \(stoppable)")
            }
            return Problem(
                kind: .endedConnections, title: title, nextStep: "놓아주면 다음 AI가 막히지 않아요",
                warning: nil, fix: .releaseEnded, fixLabel: "놓아주기")
        }
        if !status.leases.maybeLeft.isEmpty {
            // No count: when the lease list cannot be read, the number would be a guess (R14).
            let title = "점유가 남았을 수 있어요"
            let aimable = status.leases.maybeLeft.filter { $0.releasable && $0.sessionID != nil }
            if aimable.contains(where: { $0.agent == .claude }) {
                return Problem(
                    kind: .leasesMaybeLeft, title: title, nextStep: "놓아주기를 눌러 풀어 주세요",
                    warning: nil, fix: .releaseLeftover, fixLabel: "놓아주기")
            }
            // Only Codex chats' sessions can be aimed at, and those are released by a click on their own row.
            if !aimable.isEmpty {
                return Problem(
                    kind: .leasesMaybeLeft, title: title, nextStep: "Codex 대화의 점유는 점유 탭에서 줄마다 직접 풀어 주세요",
                    warning: nil, fix: .showLeases, fixLabel: "점유 보기")
            }
            return Problem(
                kind: .leasesMaybeLeft, title: title, nextStep: "하나씩 풀 방법이 없어요 — 안내를 따라 주세요",
                warning: nil, fix: .showLeaseGuidance, fixLabel: "안내 보기")
        }
        return nil
    }

    /// "앱 0.7.0 · 플러그인 0.5.0 — 맞는 판을 받아 주세요", with 맞는 판 받기.
    private static func versionMismatchProblem(appVersion: String, pluginVersion: String) -> Problem {
        Problem(
            kind: .versionMismatch, title: "앱과 플러그인 판이 달라요",
            nextStep: "앱 \(appVersion) · 플러그인 \(pluginVersion) — 맞는 판을 받아 주세요",
            warning: nil, fix: .matchPluginVersion, fixLabel: "맞는 판 받기")
    }

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
        switch setup.loginEnvironment {
        case "missing": issues.append(SetupIssue(name: "로그인 환경", sentence: "로그인 환경이 설정되지 않았어요"))
        case "stale": issues.append(SetupIssue(name: "로그인 환경", sentence: "로그인 환경이 옛 설정이에요"))
        case "conflict": issues.append(SetupIssue(name: "로그인 환경", sentence: "로그인 환경이 다른 설정과 겹쳐요"))
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
