import Foundation

/// What the popover's footer and the 기록 tab need besides the status: the new-version button,
/// the remove action and the login item line.
@MainActor
struct Maintenance {
    var releases: ReleaseChecker
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
