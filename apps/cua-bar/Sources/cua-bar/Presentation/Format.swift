import Foundation

/// How a connection's liveness reads in a row (R16): more than 30 minutes without a CUA call is
/// "쉼 n분", no call record at all is "알 수 없음".
struct StateDisplay: Equatable, Sendable {
    enum Kind: Equatable, Sendable { case inUse, resting, ended, unknown }

    var kind: Kind
    var text: String

    /// A connection that has been quiet longer than this is resting.
    static let restingAfter: Double = 30 * 60

    static func make(state: ConnectionState, idleSeconds: Double?) -> StateDisplay {
        if state == .ended { return StateDisplay(kind: .ended, text: "끝남") }
        guard let idleSeconds else {
            return state == .idle ? StateDisplay(kind: .resting, text: "쉼") : StateDisplay(kind: .unknown, text: "알 수 없음")
        }
        guard idleSeconds > restingAfter else { return StateDisplay(kind: .inUse, text: "사용 중") }
        return StateDisplay(kind: .resting, text: "쉼 " + Format.span(seconds: idleSeconds))
    }
}

/// Plain Korean text for the popover. Everything takes `now` and `calendar` so tests and
/// snapshots are deterministic.
enum Format {
    static let unknown = "—"

    /// The last two path components (`/Users/me/dev/x` -> `dev/x`).
    static func folder(_ path: String?) -> String {
        guard let path, !path.isEmpty else { return unknown }
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        if parts.isEmpty { return "/" }
        return parts.suffix(2).joined(separator: "/")
    }

    /// Binary megabytes like Activity Monitor; gigabytes from 1 GB up.
    static func memory(_ bytes: Int64?) -> String {
        guard let bytes else { return unknown }
        let mebibytes = Double(bytes) / 1_048_576
        if mebibytes < 1 { return "1 MB 미만" }
        if mebibytes.rounded() < 1024 { return "\(Int(mebibytes.rounded())) MB" }
        return String(format: "%.1f GB", mebibytes / 1024)
    }

    /// `09:39` today, `10/17 16:11` on another day.
    static func when(_ date: Date, now: Date, calendar: Calendar) -> String {
        calendar.isDate(date, inSameDayAs: now) ? clockMinutes(date, calendar: calendar) : dayAndClock(date, calendar: calendar)
    }

    /// `09:39 시작` today, `10/17 16:11 시작` on another day.
    static func startTime(_ date: Date?, now: Date, calendar: Calendar) -> String {
        guard let date else { return "시작 시각 알 수 없음" }
        return when(date, now: now, calendar: calendar) + " 시작"
    }

    /// `3시간 전 시작`, `방금 시작`; `시작 시각 알 수 없음` when the engine did not say.
    static func startedAgo(_ date: Date?, now: Date) -> String {
        guard let date else { return "시작 시각 알 수 없음" }
        return ago(date, now: now) + " 시작"
    }

    static func clock(_ date: Date?, calendar: Calendar) -> String {
        guard let date else { return unknown }
        let parts = calendar.dateComponents([.hour, .minute, .second], from: date)
        return String(format: "%02ld:%02ld:%02ld", parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0)
    }

    /// `09:39:12` today, `10/17 16:11:05` on another day: the log holds days, and yesterday must not read as today.
    static func clock(_ date: Date?, now: Date, calendar: Calendar) -> String {
        guard let date, !calendar.isDate(date, inSameDayAs: now) else { return clock(date, calendar: calendar) }
        let parts = calendar.dateComponents([.month, .day], from: date)
        return String(format: "%ld/%ld ", parts.month ?? 0, parts.day ?? 0) + clock(date, calendar: calendar)
    }

    static func clockMinutes(_ date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02ld:%02ld", parts.hour ?? 0, parts.minute ?? 0)
    }

    static func dayAndClock(_ date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.month, .day], from: date)
        return String(format: "%ld/%ld ", parts.month ?? 0, parts.day ?? 0) + clockMinutes(date, calendar: calendar)
    }

    /// `방금`, `30초 전`, `5분 전`, `3시간 전`, `2일 전`.
    static func ago(_ date: Date?, now: Date) -> String {
        guard let date else { return unknown }
        let seconds = max(0, now.timeIntervalSince(date))
        switch seconds {
        case ..<3: return "방금"
        case ..<60: return "\(Int(seconds))초 전"
        case ..<3600: return "\(Int(seconds / 60))분 전"
        case ..<86_400: return "\(Int(seconds / 3600))시간 전"
        default: return "\(Int(seconds / 86_400))일 전"
        }
    }

    /// A length of time without the "ago": `42분`, `1시간 5분`, `1일 1시간`.
    static func span(seconds: Double) -> String {
        let total = Int(max(0, seconds))
        let days = total / 86_400
        let hours = (total % 86_400) / 3600
        let minutes = (total % 3600) / 60
        if days > 0 { return hours > 0 ? "\(days)일 \(hours)시간" : "\(days)일" }
        if hours > 0 { return minutes > 0 ? "\(hours)시간 \(minutes)분" : "\(hours)시간" }
        return "\(minutes)분"
    }

    /// What a CUA tool call did, in words. Names the app does not know stay as the engine wrote them.
    static func tool(_ name: String?) -> String {
        switch name {
        case nil: unknown
        case "js"?: "화면 조작"
        case "turn_ended"?: "차례 끝 · 탭 풀기"
        case "js_reset"?: "런타임 초기화"
        case let name?: name
        }
    }

    /// Why a call failed, from the engine's word. A plain `error`, an older line's nothing and a word the app does not
    /// know say no more than the row's 실패 does already.
    static func failure(_ word: String?) -> String? {
        switch word {
        case "timeout"?: "시간 초과"
        case "screen_locked"?: "화면 잠김"
        default: nil
        }
    }

    /// `87ms`, `1.2초`, `12초`, `1분 5초`.
    static func milliseconds(_ ms: Int?) -> String {
        guard let ms else { return unknown }
        if ms < 1000 { return "\(max(0, ms))ms" }
        if ms < 10_000 { return String(format: "%.1f초", Double(ms) / 1000) }
        let seconds = ms / 1000
        if seconds < 60 { return "\(seconds)초" }
        let rest = seconds % 60
        return rest > 0 ? "\(seconds / 60)분 \(rest)초" : "\(seconds / 60)분"
    }
}
