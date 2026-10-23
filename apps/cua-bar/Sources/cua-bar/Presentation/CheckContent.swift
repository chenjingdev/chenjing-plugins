import Foundation

/// The lines of the 점검 tab, in the order the spec lists them (F3).
enum CheckItem: String, CaseIterable, Hashable, Sendable {
    case claudeCode, mcp, skill, engine, python, wrapper, relay, loginItem, host

    var title: String {
        switch self {
        case .claudeCode: "Claude Code"
        case .mcp: "MCP"
        case .skill: "스킬"
        case .engine: "엔진"
        case .python: "파이썬 환경"
        case .wrapper: "Codex 래퍼와 로그인 설정"
        case .relay: "중계기"
        case .loginItem: "앱 로그인 항목"
        case .host: "Codex 호스트와 연결 시험"
        }
    }
}

enum CheckStatus: Equatable, Sendable {
    case ready
    case problem
    /// Nothing is wrong, but nothing is running either: Claude Code is not there yet, Codex is off, the person turned a
    /// login item off.
    case waiting
    /// The app could not tell (no answer yet, a file it cannot read).
    case unknown

    var label: String {
        switch self {
        case .ready: "정상"
        case .problem: "문제"
        case .waiting: "대기"
        case .unknown: "모름"
        }
    }
}

/// A command the person runs in a terminal. The app only hands it over (a copy button); it never runs it.
struct CheckCommand: Equatable, Identifiable, Sendable {
    var text: String
    var copy: ButtonSpec
    var id: String { text }

    init(_ text: String, on item: CheckItem) {
        self.text = text
        copy = ButtonSpec(
            title: "복사", action: .copyCommand(text, on: item),
            help: "명령을 복사해요. 터미널에 붙여 넣어 실행해 주세요. 앱이 대신 실행하지 않아요")
    }
}

/// One line of the tab: a state and one short sentence. A broken line the status card carries says only
/// 위 카드에서 고쳐요; one the card does not carry has what to do on the line itself (`steps`, `commands`, `button`).
struct CheckLine: Equatable, Identifiable, Sendable {
    var item: CheckItem
    var status: CheckStatus
    var detail: String
    /// What the line stands for in the copied diagnosis, when `detail` does not say it (a line the card fixes).
    var facts: String?
    var steps: [String] = []
    var commands: [CheckCommand] = []
    var button: ButtonSpec?

    var id: CheckItem { item }
    var title: String { item.title }

    /// `점검 엔진: 정상 — 판 0.8.0`: names, versions, paths and states only.
    var diagnosisLine: String {
        let said = (facts ?? detail).replacingOccurrences(of: "\n", with: " ")
        return "점검 \(title): \(status.label)" + (said.isEmpty ? "" : " — \(said)")
    }
}

/// What the 점검 tab knows, besides the engine's answer, to judge each line.
struct CheckInput: Sendable {
    var status: EngineStatus?
    /// Why there is no status, when the last read failed.
    var error: EngineError?
    var appVersion: String?
    var claude: ClaudeSetupState = .none
    var developerToolsNeeded = false
    /// The problem the status card shows (before setup's own state is put over it): the lines it carries say so.
    var card: Problem?
    var loginItem: LoginItemReading?
    /// The login environment as read from launchd and the agent file, when the engine calls it a conflict or stale.
    var login: LoginEnvironmentReading?
    /// An install has finished in this run: a login environment that is still stale was not mended by it.
    var fixTried = false
    var probe: ProbeRecord?
    var probing = false
    /// The install is running: the connection test waits for it (the one right after it is the install's own).
    var installing = false
    var now = Date()
    var calendar = Calendar.current
    /// `~/.local/share/codex-cua/start-desktop-cli.sh`: the value the app's setup puts in `CODEX_CLI_PATH`.
    var appLauncherValue = ""
}

/// The 점검 tab: a line for each thing the app set up or relies on, judged from what the app already reads (the
/// engine's status, Claude Code's files). It runs nothing of its own.
struct CheckContent: Equatable, Sendable {
    var lines: [CheckLine]

    static let fixedOnCard = "위 카드에서 고쳐요"
    static let codexOff = "Claude 대화를 열면 켜져요"
    static let loadingDetail = "확인하는 중이에요"
    /// The native installer of Claude Code's own documentation: it needs no Node and puts `claude` in `~/.local/bin`,
    /// which is the first place the app looks.
    static let installCommand = "curl -fsSL https://claude.ai/install.sh | bash"
    static let removeMCPCommand = "claude mcp remove -s user cuabar"
    /// Out of the skills folder, not beside it: another name in there is read as a skill of its own.
    static let moveSkillCommand = "mv ~/.claude/skills/cuabar ~/cuabar-skill-backup"
    static let unsetLauncherCommand = "launchctl unsetenv CODEX_CLI_PATH"
    static let agentFile = "~/Library/LaunchAgents/com.chenjingdev.codex-cua.env.plist"

    func line(_ item: CheckItem) -> CheckLine? { lines.first { $0.item == item } }

    var problemCount: Int { lines.filter { $0.status == .problem }.count }

    /// The head of the tab.
    var headline: String {
        problemCount == 0 ? "점검 결과" : "점검 결과 · 문제 \(problemCount)개"
    }

    /// One line for each line of the tab, for the copied diagnosis.
    var diagnosisLines: [String] { lines.map(\.diagnosisLine) }

    init(lines: [CheckLine]) { self.lines = lines }

    init(_ input: CheckInput) {
        let judge = Judge(input)
        lines = CheckItem.allCases.map { judge.line(for: $0) }
    }
}

// MARK: - The judgment

private struct Judge {
    var input: CheckInput
    /// The lines the status card speaks for: the same list of broken parts the card was made from.
    var onCard: Set<CheckItem>

    init(_ input: CheckInput) {
        self.input = input
        onCard = StatusEvaluator.itemsOnCard(
            status: input.status, error: input.error, appVersion: input.appVersion, claude: input.claude, card: input.card)
    }

    private var claude: ClaudeSetupState { input.claude }
    /// There is no Codex app: the engine says so, or the card does (it can when there is no status to read, because the
    /// install does nothing without Codex and so the engine is never unpacked).
    private var codexMissing: Bool { input.card?.kind == .codexMissing || input.status?.codex.installed == false }
    private var loading: Bool { input.status == nil && input.error == nil }

    func line(for item: CheckItem) -> CheckLine {
        if codexMissing, !showsConflict(item), let waiting = codexWaiting(item) {
            return item == .mcp ? withLegacyPlugin(waiting) : waiting
        }
        return switch item {
        case .claudeCode: claudeCodeLine()
        case .mcp: mcpLine()
        case .skill: skillLine()
        case .engine: engineLine()
        case .python: pythonLine()
        case .wrapper: wrapperLine()
        case .relay: relayLine()
        case .loginItem: loginItemLine()
        case .host: hostLine()
        }
    }

    /// What the install would put right waits for the Codex app, as it waits for Claude Code: the card says the one
    /// thing that is wrong. The lines that do not depend on Codex say what they have to say.
    private func codexWaiting(_ item: CheckItem) -> CheckLine? {
        switch item {
        case .engine, .mcp, .skill, .python, .wrapper, .relay:
            return CheckLine(item: item, status: .waiting, detail: "Codex가 생기면 맞춰요", facts: "Codex 없음")
        case .claudeCode, .loginItem, .host:
            return nil
        }
    }

    /// A cuabar MCP server or skill the app did not put there is told, Codex or not (F1): the install leaves it as it is
    /// either way, so waiting for Codex would not put it right, and the line has the command that does.
    private func showsConflict(_ item: CheckItem) -> Bool {
        guard claudeWaiting(item) == nil else { return false }
        switch item {
        case .mcp: return claude.mcp == .conflict
        case .skill: return claude.skill == .conflict
        default: return false
        }
    }

    /// What follows the command on a conflict line: the card's fix, or, while the card is the one that says there is
    /// no Codex (it has no fix), the install that comes once Codex is there.
    private func afterConflict(_ done: String, _ result: String) -> String {
        codexMissing ? "\(done) Codex를 깔면 \(result)" : "\(done) 위 카드의 고치기를 누르면 \(result)"
    }

    /// A broken line: the card's, or its own.
    private func broken(_ item: CheckItem, _ sentence: String, steps: [String] = [], commands: [CheckCommand] = []) -> CheckLine {
        if onCard.contains(item) {
            return CheckLine(
                item: item, status: .problem, detail: CheckContent.fixedOnCard, facts: sentence, steps: steps, commands: commands)
        }
        return CheckLine(item: item, status: .problem, detail: sentence, steps: steps, commands: commands)
    }

    private func undecided(_ item: CheckItem, _ sentence: String) -> CheckLine {
        CheckLine(item: item, status: .unknown, detail: loading ? CheckContent.loadingDetail : sentence)
    }

    // MARK: Claude Code

    private func claudeCodeLine() -> CheckLine {
        let item = CheckItem.claudeCode
        guard claude.claudeCodeFound else {
            return CheckLine(
                item: item, status: .waiting, detail: "찾지 못했어요", facts: "없음",
                steps: ["받는 법: 터미널에서 아래 명령을 실행해요. 깔면 다음 점검에서 CUA를 연결해요"],
                commands: [CheckCommand(CheckContent.installCommand, on: item)])
        }
        let path = claude.claudeCodePath
        if claude.claudeCodeUnusable {
            let where_ = path ?? "찾은 claude"
            return CheckLine(
                item: item, status: .problem, detail: "찾았지만 시작하지 못했어요", facts: "시작하지 못함" + (path.map { " (\($0))" } ?? ""),
                steps: ["\(where_) — 터미널에서 그 claude가 도는지 확인해 주세요"])
        }
        return CheckLine(item: item, status: .ready, detail: path.map { "찾았어요 · \($0)" } ?? "찾았어요", facts: path.map { "경로 \($0)" } ?? "찾음")
    }

    // MARK: MCP and skill

    private func claudeWaiting(_ item: CheckItem) -> CheckLine? {
        if !claude.claudeCodeFound {
            return CheckLine(item: item, status: .waiting, detail: "Claude Code가 생기면 연결해요", facts: "Claude Code 없음")
        }
        if claude.claudeCodeUnusable {
            return CheckLine(item: item, status: .waiting, detail: "Claude Code를 시작하지 못해 건너뛰었어요", facts: "Claude Code 시작 못 함")
        }
        return nil
    }

    private func mcpLine() -> CheckLine {
        let item = CheckItem.mcp
        var line: CheckLine
        if let waiting = claudeWaiting(item) {
            line = waiting
        } else {
            switch claude.mcp {
            case .ready: line = CheckLine(item: item, status: .ready, detail: "앱의 엔진에 연결돼 있어요", facts: "앱의 엔진에 연결됨")
            case .missing: line = broken(item, "Claude Code에 CUA가 연결되지 않았어요")
            case .outdated: line = broken(item, "Claude Code의 CUA 연결이 옛 판이에요")
            case .conflict:
                line = CheckLine(
                    item: item, status: .problem, detail: "앱이 깔지 않은 cuabar MCP가 있어요 — 그대로 뒀어요", facts: "앱이 깔지 않은 cuabar MCP",
                    steps: [
                        "지우려면 터미널에서 아래 명령을 실행해 주세요. 앱은 남이 둔 설정을 지우지 않아요",
                        afterConflict("지운 뒤", "앱이 연결해요"),
                    ],
                    commands: [CheckCommand(CheckContent.removeMCPCommand, on: item)])
            case .unknown: line = undecided(item, "~/.claude.json을 읽지 못했어요")
            }
        }
        return withLegacyPlugin(line)
    }

    /// The old plugin is a second CUA in a new Claude conversation: told on the MCP line, with the command that removes it.
    private func withLegacyPlugin(_ line: CheckLine) -> CheckLine {
        guard claude.legacyPlugin else { return line }
        var changed = line
        let help = "아래 명령으로 지워 주세요. 앱은 지우지 않아요"
        if line.status == .problem {
            changed.steps.append("\(LegacyPlugin.notice) — \(help)")
        } else {
            changed.status = .problem
            changed.detail = LegacyPlugin.notice
            changed.facts = "옛 cua 플러그인 있음"
            changed.steps.append(help)
        }
        changed.commands.append(CheckCommand(LegacyPlugin.removeCommand, on: .mcp))
        if line.status == .problem { changed.facts = (line.facts ?? line.detail) + ", 옛 cua 플러그인 있음" }
        return changed
    }

    private func skillLine() -> CheckLine {
        let item = CheckItem.skill
        if let waiting = claudeWaiting(item) { return waiting }
        switch claude.skill {
        case .ready: return CheckLine(item: item, status: .ready, detail: "앱이 깐 스킬이 최신이에요", facts: "앱이 깐 스킬, 최신")
        case .missing: return broken(item, "Claude Code에 CUA 스킬이 없어요")
        case .outdated: return broken(item, "Claude Code의 CUA 스킬이 옛 판이에요")
        case .conflict:
            return CheckLine(
                item: item, status: .problem, detail: "앱이 깔지 않은 cuabar 스킬이 있어요 — 그대로 뒀어요", facts: "앱이 깔지 않은 cuabar 스킬",
                steps: [
                    "~/.claude/skills/cua는 앱이 깐 것이 아니에요. 아래 명령으로 skills 폴더 밖으로 옮겨 두세요. 앱은 옮기거나 지우지 않아요",
                    afterConflict("옮긴 뒤", "앱이 스킬을 깔아요"),
                ],
                commands: [CheckCommand(CheckContent.moveSkillCommand, on: item)])
        case .unknown: return undecided(item, "스킬 폴더를 읽지 못했어요")
        }
    }

    // MARK: The engine, the Python environment, the wrapper, the relay

    private func issues(of item: CheckItem) -> [StatusEvaluator.SetupIssue] {
        guard let status = input.status else { return [] }
        return (StatusEvaluator.setupIssues(in: status.setup)
            + StatusEvaluator.engineIssues(in: status.engine, appVersion: input.appVersion)).filter { $0.item == item }
    }

    private func engineLine() -> CheckLine {
        let item = CheckItem.engine
        guard let status = input.status else {
            guard let error = input.error else { return undecided(item, "") }
            switch error {
            case .timeout: return undecided(item, "응답이 없어 확인하지 못했어요")
            case .engineMissing, .setupNeeded: return broken(item, "연결 엔진이 없어요")
            case .unsupportedSchema: return broken(item, "앱이 이 엔진 판을 읽지 못해요")
            case .commandFailed, .invalidOutput, .launchFailed: return broken(item, "연결 명령이 옛 판이거나 깨졌어요")
            }
        }
        if let issue = issues(of: item).first {
            let versions = "엔진 \(status.engine.version ?? "판 없음")" + (input.appVersion.map { ", 앱 \($0)" } ?? "")
            return broken(item, issue.sentence + " (\(versions))")
        }
        let version = status.engine.version
        return CheckLine(
            item: item, status: .ready, detail: version.map { "판 \($0)" } ?? "판을 알 수 없어요",
            facts: version.map { "판 \($0)" } ?? "판 없음")
    }

    private func pythonLine() -> CheckLine {
        let item = CheckItem.python
        if input.developerToolsNeeded {
            if onCard.contains(item) {
                return CheckLine(item: item, status: .problem, detail: CheckContent.fixedOnCard, facts: "개발자 도구 필요")
            }
            return CheckLine(
                item: item, status: .problem, detail: "개발자 도구 필요", facts: "개발자 도구 필요",
                steps: ["설치를 누르면 macOS 설치 창이 떠요. 끝나면 한 번 더 눌러 주세요"],
                button: ButtonSpec(
                    title: "설치", action: .installDeveloperTools, help: "macOS의 개발자 도구 설치 창을 열어요. 누를 때만 열려요"))
        }
        guard let status = input.status else { return undecided(item, "엔진을 읽지 못해 확인하지 못했어요") }
        if let issue = issues(of: item).first { return broken(item, issue.sentence) }
        switch status.setup.dependencies {
        case "ready": return CheckLine(item: item, status: .ready, detail: "필요한 구성 요소가 준비됐어요", facts: "준비됨")
        default: return undecided(item, "엔진이 상태를 알려 주지 않았어요")
        }
    }

    private func wrapperLine() -> CheckLine {
        let item = CheckItem.wrapper
        guard let status = input.status else { return undecided(item, "엔진을 읽지 못해 확인하지 못했어요") }
        let setup = status.setup
        // Somebody else's value: the setup leaves it alone, so only the person can clear it.
        if setup.loginEnvironment == "conflict" { return withWrapperProblems(loginConflictLine(stale: false)) }
        if setup.loginEnvironment == "stale", input.fixTried, let foreign = foreignLauncher() {
            return withWrapperProblems(loginConflictLine(stale: true, foreign: foreign))
        }
        if let issue = issues(of: item).first {
            let extra = issues(of: item).dropFirst().map(\.sentence)
            var line = broken(item, issue.sentence)
            if !extra.isEmpty { line.facts = ([issue.sentence] + extra).joined(separator: ", ") }
            return line
        }
        if setup.wrapper == "ready", setup.loginEnvironment == "ready" {
            return CheckLine(item: item, status: .ready, detail: "래퍼와 로그인 설정이 준비됐어요", facts: "래퍼 준비됨, 로그인 환경 준비됨")
        }
        return undecided(item, "엔진이 상태를 알려 주지 않았어요")
    }

    /// A wrapper that is missing or broken, beside a login environment the person has to clear: the line is about the
    /// conflict, and this is told on it too, and kept in the diagnosis.
    private func withWrapperProblems(_ line: CheckLine) -> CheckLine {
        let wrapper = issues(of: .wrapper).filter { $0.name == "래퍼" }
        guard !wrapper.isEmpty else { return line }
        var changed = line
        for issue in wrapper {
            changed.steps.append(issue.sentence + (onCard.contains(.wrapper) ? " — 위 카드에서 고쳐요" : ""))
            changed.facts = (changed.facts ?? changed.detail) + ", " + issue.sentence
        }
        return changed
    }

    /// A value in launchd's `CODEX_CLI_PATH` that is not the app's (a setup does not overwrite it).
    private func foreignLauncher() -> String? {
        guard let value = input.login?.launchdValue, !value.isEmpty, value != input.appLauncherValue else { return nil }
        return value
    }

    private func loginConflictLine(stale: Bool, foreign: String? = nil) -> CheckLine {
        let item = CheckItem.wrapper
        var steps: [String] = []
        var commands: [CheckCommand] = []
        var facts = stale ? "로그인 환경 옛 설정" : "로그인 환경 충돌"
        let login = input.login
        if let label = login?.agentLabel, !stale {
            // A file at the app's own place that is somebody else's (another label). A label is somebody else's
            // text: it is shown, and goes into the diagnosis, only when it is plain.
            let plain = Self.safeLabel(label)
            steps = [
                "\(CheckContent.agentFile)이 이 앱의 것이 아니에요" + (plain.map { "(라벨 \($0))" } ?? ""),
                "그 파일을 다른 곳으로 옮긴 뒤 위 카드의 고치기를 눌러 주세요. 앱은 남의 파일을 옮기지 않아요",
            ]
            facts += plain.map { " (남의 로그인 에이전트 라벨 \($0))" } ?? " (남의 로그인 에이전트)"
        } else if let value = foreign ?? foreignLauncher() {
            steps = [
                "launchd의 CODEX_CLI_PATH가 다른 값이에요: \(value)",
                "아래 명령으로 지운 뒤 위 카드의 고치기를 눌러 주세요. 앱은 남이 정한 값을 덮어쓰지 않아요",
            ]
            commands = [CheckCommand(CheckContent.unsetLauncherCommand, on: item)]
            if let safe = Self.safePath(value) { facts += " (CODEX_CLI_PATH=\(safe))" }
        } else if login == nil {
            steps = ["겹치는 값을 아직 읽지 못했어요. 잠시 뒤 다시 열어 보세요"]
        } else {
            steps = [
                "겹치는 값을 찾지 못했어요. 터미널에서 launchctl getenv CODEX_CLI_PATH 로 확인해 주세요",
                "다른 값이 나오면 아래 명령으로 지운 뒤 위 카드의 고치기를 눌러 주세요",
            ]
            commands = [CheckCommand(CheckContent.unsetLauncherCommand, on: item)]
        }
        let detail = stale ? "로그인 설정이 옛 값이고, 고치기로는 바뀌지 않았어요" : "로그인 설정이 다른 값과 겹쳐요"
        return CheckLine(item: item, status: .problem, detail: detail, facts: facts, steps: steps, commands: commands)
    }

    /// A launchd label worth showing and putting in the diagnosis: letters, digits, dots, dashes and underscores, not long.
    static func safeLabel(_ value: String) -> String? {
        guard (1...100).contains(value.count), value.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || ".-_".contains($0)) })
        else { return nil }
        return value
    }

    /// A value worth putting in the diagnosis: one absolute path on one line.
    static func safePath(_ value: String) -> String? {
        guard value.hasPrefix("/"), value.count <= 300, !value.contains(where: { $0.isNewline || $0 == " " }) else { return nil }
        return value
    }

    private func relayLine() -> CheckLine {
        let item = CheckItem.relay
        guard let status = input.status else { return undecided(item, "엔진을 읽지 못해 확인하지 못했어요") }
        if let issue = issues(of: item).first { return broken(item, issue.sentence) }
        switch status.setup.relay {
        case "active": return CheckLine(item: item, status: .ready, detail: "중계기가 켜져 있어요", facts: "켜져 있음")
        case "inactive": return CheckLine(item: item, status: .ready, detail: "준비됐어요 — Codex를 켜면 붙어요", facts: "준비됨, 호스트에는 붙지 않음")
        default: return undecided(item, "엔진이 상태를 알려 주지 않았어요")
        }
    }

    // MARK: The login item

    private func loginItemLine() -> CheckLine {
        let item = CheckItem.loginItem
        guard let reading = input.loginItem else {
            return CheckLine(item: item, status: .unknown, detail: "이 실행에서는 확인하지 않아요")
        }
        let status: CheckStatus
        switch reading.health {
        case .enabled: status = .ready
        case .requiresApproval, .failed, .notFound: status = .problem
        case .notRegistered, .turnedOff: status = .waiting
        }
        return CheckLine(item: item, status: status, detail: reading.detail, facts: reading.health.word)
    }

    // MARK: Codex and the connection test

    private func hostLine() -> CheckLine {
        let item = CheckItem.host
        // The card carries this one, with or without a status to read.
        if codexMissing { return broken(item, "Codex 앱이 없어요") }
        guard let status = input.status else { return undecided(item, "엔진을 읽지 못해 확인하지 못했어요") }
        let state = status.host.state
        switch state {
        case .ready:
            return readyHostLine(status)
        case .starting:
            return CheckLine(item: item, status: .waiting, detail: "Codex가 켜지는 중이에요 — 켜지면 시험할 수 있어요", facts: "켜지는 중")
        case .stopping:
            return CheckLine(item: item, status: .waiting, detail: "Codex가 꺼지는 중이에요", facts: "꺼지는 중")
        case .closed, .missing, .unknown:
            if status.codex.running {
                // Codex runs without the host this app needs, whatever the engine called its state (the card says the
                // same of an empty one): the card restarts it.
                return broken(item, "Codex가 연결 없이 켜져 있어요")
            }
            // Off: nothing is started for a test, and the test is skipped.
            return CheckLine(item: item, status: .waiting, detail: CheckContent.codexOff, facts: "꺼짐, 연결 시험 건너뜀")
        }
    }

    private func readyHostLine(_ status: EngineStatus) -> CheckLine {
        let item = CheckItem.host
        var steps: [String] = []
        if status.host.startedBeforeSetup { steps.append(StatusEvaluator.restartAppliesStep) }
        var facts = "켜져 있음" + (status.host.engineVersion.map { ", 엔진 \($0)로 켜짐" } ?? "")
        let help = input.probing ? "시험하는 중이에요"
            : input.installing ? "설정하는 중이에요. 끝나면 시험할 수 있어요"
            : "Codex가 화면 도구를 읽을 수 있는지 한 번 시험해요. Codex를 켜거나 끄지 않아요"
        let button = ButtonSpec(title: "연결 시험", action: .runProbe, isEnabled: !input.probing && !input.installing, help: help)
        if input.probing {
            return CheckLine(item: item, status: .ready, detail: "연결 시험을 하는 중이에요…", facts: facts + ", 시험 중", steps: steps, button: button)
        }
        guard let probe = input.probe else {
            return CheckLine(item: item, status: .ready, detail: "연결됐어요 — 아직 시험하지 않았어요", facts: facts + ", 시험 안 함", steps: steps, button: button)
        }
        let time = Format.when(probe.at, now: input.now, calendar: input.calendar)
        facts += ", 연결 시험 \(probe.outcome.word) \(time)"
        let status: CheckStatus = probe.outcome.isFailure ? .problem : probe.outcome == .checked ? .ready : .waiting
        return CheckLine(
            item: item, status: status, detail: "\(probe.outcome.summary) · \(time)", facts: facts, steps: steps, button: button)
    }
}

extension StatusEvaluator {
    /// The lines of the check tab the status card speaks for: for a setup problem, the lines of the broken parts it was
    /// made from (the card and the tab judge from the same list); for the developer tools, also the Python
    /// environment; for Codex without its app or its host, the Codex line. A conflict has no button and the card
    /// sends the person to the tab, so it carries nothing.
    static func itemsOnCard(
        status: EngineStatus?, error: EngineError?, appVersion: String?, claude: ClaudeSetupState, card: Problem?
    ) -> Set<CheckItem> {
        guard let card else { return [] }
        switch card.kind {
        case .setupIncomplete, .developerToolsNeeded:
            var items: Set<CheckItem> = []
            if let status {
                items = Set((setupIssues(in: status.setup) + engineIssues(in: status.engine, appVersion: appVersion)
                    + claudeIssues(in: claude)).map(\.item))
            } else {
                if let error, error.needsEngineInstall { items = [.engine] }
                // With no status to list the broken parts from, the card's button is still the whole install (고치기, or
                // 설치 for the developer tools, which runs it once the tools are there): it puts Claude Code's MCP server
                // and skill in too, so the lines of those say to fix them on the card.
                if card.fix == .runSetup || card.fix == .installDeveloperTools {
                    items.formUnion(claudeIssues(in: claude).map(\.item))
                }
            }
            if card.kind == .developerToolsNeeded { items.insert(.python) }
            return items
        case .codexMissing, .codexWithoutHost:
            return [.host]
        case .loginEnvironmentConflict, .claudeConflict, .endedConnections, .leasesMaybeLeft, .engineUnreadable:
            return []
        }
    }
}
