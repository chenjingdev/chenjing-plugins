import AppKit

/// Fixes that reach outside the engine: opening a web page, the developer tools' installer, and the install
/// itself. `LiveSystemActions` does them in the real app; tests and previews pass their own.
protocol SystemActions: Sendable {
    func openCodexDownload() async -> ActionOutcome
    /// The whole install: the engine, then Claude Code's MCP server and skill. Looks first and changes only
    /// what is missing or out of date, so it is the same call at start-up and behind 고치기.
    func setUp() async -> ActionOutcome
    /// `xcode-select --install`, only because the person pressed the button.
    func installDeveloperTools() async -> ActionOutcome
}

/// Says each of them is not available. The default for tests and previews, where nothing may be
/// opened or installed; the app itself uses `LiveSystemActions`.
struct UnwiredSystemActions: SystemActions {
    func openCodexDownload() async -> ActionOutcome {
        ActionOutcome(kind: .info, message: "Codex 받는 곳 열기는 아직 연결되지 않았어요")
    }

    func setUp() async -> ActionOutcome {
        ActionOutcome(kind: .info, message: "설치는 아직 연결되지 않았어요")
    }

    func installDeveloperTools() async -> ActionOutcome {
        ActionOutcome(kind: .info, message: "개발자 도구 설치는 아직 연결되지 않았어요")
    }
}

@MainActor
protocol PasteboardWriting {
    func copy(_ text: String)
}

struct SystemPasteboard: PasteboardWriting {
    func copy(_ text: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }
}
