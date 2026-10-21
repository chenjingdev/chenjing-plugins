import Foundation

/// What the popover's bottom line and the 기록 tab need besides the status: the new-version button
/// (bottom line, while an update could not be made by itself), 앱 지우기 and the login item line (기록).
@MainActor
struct Maintenance {
    var updater: AppUpdater
    var removal: RemovalFlow
    var loginItem: LoginItemRegistrar
    var opener: any URLOpening
}

/// Copies the engine's diagnosis with two lines about the app added: its version and what became
/// of the login item. Like the rest of the diagnosis they say nothing about the screen, a request or a secret (R2).
@MainActor
struct DiagnosisPasteboard: PasteboardWriting {
    var base: any PasteboardWriting
    var appLines: @MainActor () -> String

    func copy(_ text: String) {
        let separator = text.isEmpty || text.hasSuffix("\n") ? "" : "\n"
        base.copy(text + separator + appLines() + "\n")
    }
}
