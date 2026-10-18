import AppKit

/// Fixes that reach outside the engine: opening a web page, installing or updating the Claude
/// plugin. They are not wired yet; the task after this one fills them in by passing its own
/// `SystemActions` to the view model, so nothing else has to change.
protocol SystemActions: Sendable {
    func openCodexDownload() async -> ActionOutcome
    func installPlugin() async -> ActionOutcome
    func matchPluginVersion() async -> ActionOutcome
}

/// TODO(A3): replace with the real thing (Codex download page, `claude plugin install` /
/// `update`, and the app's own update).
struct UnwiredSystemActions: SystemActions {
    func openCodexDownload() async -> ActionOutcome {
        ActionOutcome(kind: .info, message: "Codex 받는 곳 열기는 아직 연결되지 않았어요")
    }

    func installPlugin() async -> ActionOutcome {
        ActionOutcome(kind: .info, message: "플러그인 설치는 아직 앱에서 못 해요 — Claude에서 직접 설치해 주세요")
    }

    func matchPluginVersion() async -> ActionOutcome {
        ActionOutcome(kind: .info, message: "판 맞추기는 아직 앱에서 못 해요 — Claude에서 플러그인을 갱신해 주세요")
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
