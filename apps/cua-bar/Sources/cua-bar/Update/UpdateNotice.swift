import Foundation

/// The mark an update leaves for the app that starts after it, so that the person hears about it once (F4).
///
/// The app that replaces itself writes the new version here before it does, and takes the mark away when the
/// update fails. The new app's install routine finds it when it has put the engine, the MCP server and the skill in
/// line with the new version, tells "CUA Bar를 x.y.z로 올렸어요. 새 Claude 대화부터 새 판이 쓰여요" (a notification, for
/// the popover is closed and a banner there would pass unseen) instead of its own "새 Claude 대화부터 CUA가 붙어요", and
/// takes the mark away: one notice, not two, and only once.
struct UpdateNotice: Sendable {
    var file: URL

    init(home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        file = UpdateNotice.supportFolder(home: home).appendingPathComponent("update-pending.json")
    }

    /// `~/Library/Application Support/CUABar`: the mark, and the backup of the app an update replaced.
    static func supportFolder(home: URL) -> URL {
        home.appendingPathComponent("Library/Application Support/CUABar", isDirectory: true)
    }

    /// "CUA Bar를 x.y.z로 올렸어요": the first half of the line, what a notification says in its title.
    static func headline(for version: VersionNumber) -> String {
        "CUA Bar를 \(version)로 올렸어요"
    }

    /// "새 Claude 대화부터 새 판이 쓰여요": the second half, in its body.
    static let consequence = "새 Claude 대화부터 새 판이 쓰여요"

    /// The whole line: "CUA Bar를 x.y.z로 올렸어요. 새 Claude 대화부터 새 판이 쓰여요".
    static func line(for version: VersionNumber) -> String {
        headline(for: version) + ". " + consequence
    }

    func leave(version: VersionNumber) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: ["version": version.description], options: [.sortedKeys])
        try data.write(to: file, options: .atomic)
    }

    /// The version the last update was to, while its notice has not been told.
    var pendingVersion: VersionNumber? {
        guard
            let data = try? Data(contentsOf: file),
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let text = object["version"] as? String
        else { return nil }
        return VersionNumber(strict: text)
    }

    func clear() {
        try? FileManager.default.removeItem(at: file)
    }

    /// The line to tell when the running app is the version the last update was to; nil otherwise. A mark of an
    /// older version than the running app is long past and goes. A newer one is left alone: it may be the update
    /// that is under way, which this app is about to leave for.
    func lineIfJustUpdated(to appVersion: VersionNumber?) -> String? {
        guard let pending = pendingVersion, let appVersion else { return nil }
        if pending < appVersion {
            clear()
            return nil
        }
        return pending == appVersion ? Self.line(for: pending) : nil
    }
}

/// The line an update's notice adds when Claude Code still has CUA's old names, or asks about CUA by default in auto
/// mode (F9): the 점검 tab has what to do, and clicking the notification opens it. One line, the old names first.
enum UpdateAdvice {
    static let oldNames = "Claude Code에 CUA의 옛 이름이 남아 있어요 — 점검 탭을 보세요"
    static let allowRule = "auto 모드에서도 묻지 않게 하는 규칙 한 줄이 점검 탭에 있어요"

    /// nil: nothing to add. The rule is told only when the user settings choose auto mode (R26): the mode a person
    /// picks in a conversation is not in any file, and a line on every update would be noise.
    static func line(for state: ClaudeSetupState) -> String? {
        if state.hasOldNames { return oldNames }
        if let reading = state.permissions, reading.needsAllowRule, reading.defaultMode == PermissionReading.autoMode {
            return allowRule
        }
        return nil
    }

    /// `text` with the line after it, the way the sentences of a notification are joined.
    static func attach(_ line: String?, to text: String) -> String {
        guard let line else { return text }
        return text.isEmpty ? line : text + ". " + line
    }
}
