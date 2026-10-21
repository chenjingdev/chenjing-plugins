import Foundation

/// The fixed lines of the remove action, called 앱 지우기. None carries text a command printed.
enum RemovalMessages {
    /// The button at the bottom of 기록, and the answer that does it.
    static let buttonTitle = "앱 지우기…"
    static let confirmTitle = "앱 지우기"
    /// Asked once, inline, before anything is touched (R3, R15).
    static let question = "연결 설정과 중계기를 되돌리고, Claude Code에 깐 CUA 연결과 스킬을 지워요. Codex는 다음에 켤 때부터 연결 없이 원래대로 켜져요. 열린 Claude 대화의 CUA도 끊겨요."
    static let working = "되돌리는 중…"
    static let trashHint = "이 앱 파일은 이제 휴지통으로 옮겨도 돼요."
    /// Claude Code could not take the app's MCP server away (no `claude` command, it refused, or its file cannot be read).
    static let mcpStays = " Claude Code의 CUA 연결은 `claude mcp remove -s user cua`로 직접 지워 주세요."
    /// What was taken out of Claude Code, said when the rest did not go as the question promised.
    static let claudeRemoved = " Claude Code에 깐 CUA 연결과 스킬은 지웠어요."
    static let done = "연결 설정과 중계기를 되돌렸어요. " + trashHint
    static let nothingToUndo = "되돌릴 연결 설정이 없었어요. " + trashHint
    /// The remover refuses while a Codex host runs. Codex is never quit from here.
    static let hostRunning = "Codex를 정상 종료한 뒤 다시 해 주세요"
    static let failed = "앱을 지우지 못했어요 — 연결 설정은 그대로 남아 있을 수 있어요"
    /// The same two, after Claude Code's part had already been taken away.
    static let hostRunningAfterClaude = "Codex를 정상 종료한 뒤 다시 해 주세요. Claude Code에 깐 CUA 연결과 스킬은 이미 지웠어요"
    static let failedAfterClaude = "앱을 지우지 못했어요 — Claude Code에 깐 CUA 연결과 스킬은 지웠고, 나머지 연결 설정은 그대로 남아 있을 수 있어요"
    /// The engine could not be asked whether a Codex host runs, so nothing was changed.
    static let statusUnreadable = "Codex 상태를 읽지 못해 아무것도 바꾸지 않았어요. 잠시 뒤 다시 해 주세요"
    /// A setup (or an install or update) writes the same files; they do not run at the same time.
    static let setupRunning = "연결을 설정하는 중이라 지금은 못 해요. 끝난 뒤에 다시 해 주세요"
    static let loginItemStays = " 로그인 항목은 시스템 설정 > 일반 > 로그인 항목에서 직접 꺼 주세요."
}

/// 앱 지우기 at the bottom of 기록 (R3, once called 제거): asks once, then in this order: looks for a running
/// Codex host (which keeps everything as it is), takes away the MCP server and the skill the app put into
/// Claude Code (only its own), runs `codex-cua uninstall` (the bound engine copy's `setup.sh uninstall` when the
/// command is missing or not ours), takes the login item away, shows the result and quits. The remover
/// refuses while a Codex host runs; it never quits Codex. The app file stays.
///
/// Claude Code's part is taken away only when it is known that nothing is running: the status was read and
/// shows no host, or there is no engine at all. Where the status cannot tell but the engine's remover runs (the
/// command is missing and a copy is bound, or it fails or prints what the app cannot read), the remover goes first:
/// it looks at the host itself and refuses, and only after it went through is Claude Code's part taken away. With
/// no answer at all (none in time, or a command that does not start) nothing is changed, and it says so.
@MainActor
final class RemovalFlow: ObservableObject {
    enum Phase: Equatable {
        case idle
        /// The question is on screen with its two buttons.
        case confirming
        case working
        /// Undone; the text is the result, and the app quits in a moment.
        case finished(String)
        /// Not done, nothing else changed, the app stays. The text says why.
        case refused(String)
    }

    @Published private(set) var phase: Phase = .idle

    /// It is undoing things, or has and is about to quit: the app does not replace itself meanwhile.
    var isRunning: Bool {
        switch phase {
        case .working, .finished: true
        case .idle, .confirming, .refused: false
        }
    }

    private let engine: any EngineClient
    private let loginItem: LoginItemRegistrar
    private let claude: any ClaudeRemoving
    private let quit: @MainActor () -> Void
    private let sleep: @Sendable (Duration) async throws -> Void
    private let readingTime: Duration
    private let isSetupRunning: @MainActor () -> Bool
    private let onRemoved: @MainActor () -> Void

    init(
        engine: any EngineClient,
        loginItem: LoginItemRegistrar,
        // What the app put into Claude Code goes first; tests pass a recorder, the app the real one.
        claude: any ClaudeRemoving = NoClaudeRemoval(),
        quit: @escaping @MainActor () -> Void,
        // Long enough to read the result before the app goes away.
        readingTime: Duration = .seconds(6),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        // True while a setup, install or update runs: removing waits until it is done.
        isSetupRunning: @escaping @MainActor () -> Bool = { false },
        // Called once it is undone, so the app can stop reading a status that no longer exists.
        onRemoved: @escaping @MainActor () -> Void = {}
    ) {
        self.engine = engine
        self.loginItem = loginItem
        self.claude = claude
        self.quit = quit
        self.readingTime = readingTime
        self.sleep = sleep
        self.isSetupRunning = isSetupRunning
        self.onRemoved = onRemoved
    }

    /// 앱 지우기 was pressed: ask.
    func ask() {
        switch phase {
        case .idle, .refused: phase = .confirming
        case .confirming, .working, .finished: break
        }
    }

    /// 취소, or closing a refusal.
    func dismiss() {
        switch phase {
        case .confirming, .refused: phase = .idle
        case .idle, .working, .finished: break
        }
    }

    /// 앱 지우기 was confirmed.
    func confirm() async {
        guard phase == .confirming else { return }
        if isSetupRunning() {
            phase = .refused(RemovalMessages.setupRunning)
            return
        }
        phase = .working
        // Look before changing anything: with a Codex host running nothing is touched, as it always was.
        var claudeRemoval: ClaudeIntegration.Removal?
        switch await look() {
        case .hostRunning:
            phase = .refused(RemovalMessages.hostRunning)
            return
        case .unreadable:
            phase = .refused(RemovalMessages.statusUnreadable)
            return
        case .clear:
            // Claude Code's part first: once the engine copy is gone, the MCP server would point at nothing.
            claudeRemoval = await claude.removeAppOwned()
        case .engineFirst:
            break
        }
        var undone = true
        do {
            try await engine.uninstall()
        } catch let error as EngineError {
            switch error {
            case .engineMissing, .setupNeeded:
                // No engine, or the remover found nothing a setup installed: there is nothing to undo.
                undone = false
            default:
                phase = .refused(await refusal(afterClaude: claudeRemoval?.removedAnything == true))
                return
            }
        } catch {
            phase = .refused(claudeRemoval?.removedAnything == true ? RemovalMessages.failedAfterClaude : RemovalMessages.failed)
            return
        }
        // The engine's remover went through (it looks at the host itself): now Claude Code's part.
        let removal: ClaudeIntegration.Removal
        if let already = claudeRemoval {
            removal = already
        } else {
            removal = await claude.removeAppOwned()
        }
        let loginItemOff = loginItem.unregisterForRemoval()
        phase = .finished(
            (undone ? RemovalMessages.done : RemovalMessages.nothingToUndo)
                + (!undone && removal.removedAnything ? RemovalMessages.claudeRemoved : "")
                + (removal.mcpStays ? RemovalMessages.mcpStays : "")
                + (loginItemOff ? "" : RemovalMessages.loginItemStays))
        onRemoved()
        try? await sleep(readingTime)
        quit()
    }

    /// What the engine says before anything is changed.
    private enum Look {
        /// Its status shows no host (or there is no engine to have one): Claude Code's part can go first.
        case clear
        case hostRunning
        /// The status cannot tell, but the remover can: the command is missing and an engine copy is bound, or the
        /// command runs and fails, prints nonsense or speaks a newer schema. The engine's remover looks at host.json
        /// itself and refuses with a host, so it goes first and Claude Code's part only after it went through.
        case engineFirst
        /// No answer at all (none in time, or the command does not start): a host may be running, so nothing is changed.
        case unreadable
    }

    private func look() async -> Look {
        do {
            return Self.hostMayBeRunning(in: try await engine.status()) ? .hostRunning : .clear
        } catch let error as EngineError {
            switch error {
            case .engineMissing: return .clear
            case .setupNeeded, .commandFailed, .invalidOutput, .unsupportedSchema: return .engineFirst
            case .timeout, .launchFailed: return .unreadable
            }
        } catch {
            return .unreadable
        }
    }

    /// The remover exits with the same code whatever stopped it, so what refused it is read from
    /// what is running now: a Codex host (or Codex itself, when the host cannot be told).
    private func refusal(afterClaude: Bool) async -> String {
        if let status = try? await engine.status(), Self.hostMayBeRunning(in: status) {
            return afterClaude ? RemovalMessages.hostRunningAfterClaude : RemovalMessages.hostRunning
        }
        return afterClaude ? RemovalMessages.failedAfterClaude : RemovalMessages.failed
    }

    static func hostMayBeRunning(in status: EngineStatus) -> Bool {
        switch status.host.state {
        // A stopping host is gone, but its Codex is still quitting.
        case .ready, .starting, .stopping: true
        case .unknown: status.codex.running
        case .closed, .missing: false
        }
    }
}
