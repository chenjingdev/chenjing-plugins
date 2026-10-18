import AppKit

/// Opens the Codex app on the person's click (the 열기 button after a failed relaunch). The app
/// never opens it by itself (R1).
protocol AppOpening: Sendable {
    func openCodex(appPath: String?) async -> ActionOutcome
}

struct WorkspaceAppOpener: AppOpening {
    func openCodex(appPath: String?) async -> ActionOutcome {
        guard let appPath, !appPath.isEmpty, FileManager.default.fileExists(atPath: appPath) else {
            return ActionOutcome(kind: .failure, message: "Codex 앱 위치를 알 수 없어요")
        }
        let opened = await Self.open(URL(fileURLWithPath: appPath))
        return opened
            ? ActionOutcome(kind: .success, message: "Codex를 열었어요")
            : ActionOutcome(kind: .failure, message: "Codex를 열지 못했어요")
    }

    @MainActor private static func open(_ url: URL) async -> Bool {
        do {
            // Opened like a click in Finder, so it starts the way Codex always starts.
            _ = try await NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
            return true
        } catch {
            return false
        }
    }
}
