import Foundation

/// A version compared as numbers: `0.10.0` is newer than `0.9.0`, which comparing the text gets wrong.
struct VersionNumber: Comparable, Hashable, Sendable, CustomStringConvertible {
    var major: Int
    var minor: Int
    var patch: Int

    init(_ major: Int, _ minor: Int, _ patch: Int) {
        self.major = major
        self.minor = minor
        self.patch = patch
    }

    /// `1.2.3`, optionally followed by `-pre` or `+build` (written down but not compared).
    /// nil for anything else, and for nil.
    init?(_ text: String?) {
        guard let text else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let core = trimmed.prefix { $0 != "-" && $0 != "+" }
        guard let parts = Self.numbers(in: String(core)) else { return nil }
        self.init(parts[0], parts[1], parts[2])
    }

    /// Exactly `x.y.z` with nothing around it, the way a release tag spells a version.
    init?(strict text: String) {
        guard let parts = Self.numbers(in: text) else { return nil }
        self.init(parts[0], parts[1], parts[2])
    }

    /// Three runs of ASCII digits joined by dots. Anything else (a sign, a space, a Unicode
    /// digit, a number too large to hold) is not a version.
    private static func numbers(in text: String) -> [Int]? {
        let pieces = text.split(separator: ".", omittingEmptySubsequences: false)
        guard pieces.count == 3 else { return nil }
        var values: [Int] = []
        for piece in pieces {
            guard !piece.isEmpty, piece.utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }), let value = Int(piece) else { return nil }
            values.append(value)
        }
        return values
    }

    static func < (lhs: VersionNumber, rhs: VersionNumber) -> Bool {
        (lhs.major, lhs.minor, lhs.patch) < (rhs.major, rhs.minor, rhs.patch)
    }

    var description: String { "\(major).\(minor).\(patch)" }
}
