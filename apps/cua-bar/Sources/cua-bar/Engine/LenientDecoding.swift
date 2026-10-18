import Foundation

// The engine and the app ship separately, so the app reads the engine's JSON the way the
// contract asks consumers to: unknown keys are ignored, nulls mean "unknown", and one field of
// the wrong type must not take the whole popover down. These helpers return nil instead of
// throwing for anything that is missing, null or of an unexpected type.

extension KeyedDecodingContainer {
    func lenient<T: Decodable>(_ type: T.Type, forKey key: Key) -> T? {
        guard contains(key) else { return nil }
        return try? decode(T.self, forKey: key)
    }

    func lenientString(_ key: Key) -> String? { lenient(String.self, forKey: key) }

    func lenientBool(_ key: Key) -> Bool? { lenient(Bool.self, forKey: key) }

    func lenientDouble(_ key: Key) -> Double? { lenient(Double.self, forKey: key) }

    /// Accepts integers and whole or fractional numbers (a Python `2.0` or `1234.5`), rounded.
    func lenientInt(_ key: Key) -> Int? {
        if let value = lenient(Int.self, forKey: key) { return value }
        guard let value = lenientDouble(key), value.isFinite, abs(value) < 9e15 else { return nil }
        return Int(value.rounded())
    }

    func lenientInt64(_ key: Key) -> Int64? {
        if let value = lenient(Int64.self, forKey: key) { return value }
        guard let value = lenientDouble(key), value.isFinite, abs(value) < 9e18 else { return nil }
        return Int64(value.rounded())
    }

    func lenientDate(_ key: Key) -> Date? {
        lenientString(key).flatMap(ISO8601.parse)
    }

    func lenientInts(_ key: Key) -> [Int] {
        lenientArray(Int.self, forKey: key)
    }

    /// An array whose broken elements are dropped instead of failing the whole array.
    func lenientArray<T: Decodable>(_ type: T.Type, forKey key: Key) -> [T] {
        (lenient([LossyElement<T>].self, forKey: key) ?? []).compactMap(\.value)
    }
}

private struct LossyElement<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws {
        value = try? T(from: decoder)
    }
}

/// ISO 8601 timestamps as the engine prints them (`2026-10-18T12:00:00Z`); also accepts a
/// numeric offset (`+09:00`, `-0500`), fractional seconds and a space instead of the `T`.
/// Written out by hand so it has no shared formatter state and behaves the same on every thread.
enum ISO8601 {
    static func parse(_ text: String) -> Date? {
        let bytes = Array(text.utf8)
        var index = 0

        func number(_ count: Int) -> Int? {
            guard index + count <= bytes.count else { return nil }
            var value = 0
            for offset in 0..<count {
                let byte = bytes[index + offset]
                guard byte >= 48, byte <= 57 else { return nil }
                value = value * 10 + Int(byte - 48)
            }
            index += count
            return value
        }
        func consume(_ byte: UInt8) -> Bool {
            guard index < bytes.count, bytes[index] == byte else { return false }
            index += 1
            return true
        }

        let dash = UInt8(ascii: "-"), colon = UInt8(ascii: ":"), dot = UInt8(ascii: ".")
        guard let year = number(4), consume(dash), let month = number(2), consume(dash), let day = number(2) else { return nil }
        guard consume(UInt8(ascii: "T")) || consume(UInt8(ascii: " ")) else { return nil }
        guard let hour = number(2), consume(colon), let minute = number(2) else { return nil }

        var second = 0
        var fraction = 0.0
        if consume(colon) {
            guard let value = number(2) else { return nil }
            second = value
            if consume(dot) {
                var scale = 0.1
                var digits = 0
                while index < bytes.count, bytes[index] >= 48, bytes[index] <= 57 {
                    fraction += Double(bytes[index] - 48) * scale
                    scale /= 10
                    digits += 1
                    index += 1
                }
                guard digits > 0 else { return nil }
            }
        }

        var offsetSeconds = 0
        if consume(UInt8(ascii: "Z")) {
            offsetSeconds = 0
        } else if index < bytes.count, bytes[index] == UInt8(ascii: "+") || bytes[index] == dash {
            let sign = bytes[index] == UInt8(ascii: "+") ? 1 : -1
            index += 1
            guard let offsetHour = number(2) else { return nil }
            _ = consume(colon)
            let offsetMinute = number(2) ?? 0
            offsetSeconds = sign * (offsetHour * 3600 + offsetMinute * 60)
        }
        guard index == bytes.count else { return nil }
        guard (1...12).contains(month), (1...31).contains(day), hour < 24, minute < 60, second < 61 else { return nil }

        var parts = tm()
        parts.tm_year = Int32(year - 1900)
        parts.tm_mon = Int32(month - 1)
        parts.tm_mday = Int32(day)
        parts.tm_hour = Int32(hour)
        parts.tm_min = Int32(minute)
        parts.tm_sec = Int32(second)
        let seconds = timegm(&parts)
        guard seconds != -1 else { return nil }
        return Date(timeIntervalSince1970: TimeInterval(seconds - offsetSeconds) + fraction)
    }
}
