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

/// Copies the engine's diagnosis with the lines about the app added: its version, what became of the login item, and
/// what the updates are doing. Like the rest of the diagnosis they say nothing about the screen, a request or a secret (R2).
/// Only the diagnosis gets them: anything else that is copied (a command to run in a terminal) goes on as it is.
@MainActor
struct DiagnosisPasteboard: PasteboardWriting {
    var base: any PasteboardWriting
    var appLines: @MainActor () -> String

    func copy(_ text: String) {
        base.copy(text)
    }

    func copyDiagnosis(_ text: String) {
        let separator = text.isEmpty || text.hasSuffix("\n") ? "" : "\n"
        base.copy(text + separator + appLines() + "\n")
    }
}

extension DiagnosisPasteboard {
    /// The lines the app adds to the diagnosis: its version, what became of the login item, and what the updates are doing
    /// when there is something to say (`AppUpdater.diagnosisLine`).
    static func appLines(appVersion: String?, loginItemLine: String, updateLine: String?) -> String {
        "앱: CUA Bar \(appVersion ?? "개발용")\n\(loginItemLine)" + (updateLine.map { "\n" + $0 } ?? "")
    }
}
