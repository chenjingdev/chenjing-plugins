import Foundation
@testable import cua_bar

enum FixtureError: Error { case missing(String) }

enum Fixtures {
    static func data(_ name: String) throws -> Data {
        guard let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures") else {
            throw FixtureError.missing(name)
        }
        return try Data(contentsOf: url)
    }

    static func status(_ name: String) throws -> EngineStatus {
        try JSONDecoder().decode(EngineStatus.self, from: data(name))
    }

    /// The `generated_at` of the "ready", "working", "problem" and contract fixtures.
    static let now = Date(timeIntervalSince1970: 1_792_324_800)

    static var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }
}
