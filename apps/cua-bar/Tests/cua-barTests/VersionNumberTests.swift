import Foundation
import Testing
@testable import cua_bar

struct VersionNumberTests {
    @Test func versionsAreComparedAsNumbersNotAsText() {
        #expect(VersionNumber("0.10.0")! > VersionNumber("0.9.0")!)
        #expect(VersionNumber("0.7.10")! > VersionNumber("0.7.9")!)
        #expect(VersionNumber("1.0.0")! > VersionNumber("0.99.99")!)
        #expect(VersionNumber("0.7.0")! == VersionNumber("0.7.0")!)
        // The text order says the opposite for every one of these.
        #expect("0.9.0" > "0.10.0")
        #expect("0.7.9" > "0.7.10")
    }

    @Test func aSuffixIsAllowedButNotCompared() {
        #expect(VersionNumber("0.7.0-beta.1") == VersionNumber(0, 7, 0))
        #expect(VersionNumber("0.7.0+build5") == VersionNumber(0, 7, 0))
        #expect(VersionNumber(" 0.7.0\n") == VersionNumber(0, 7, 0))
    }

    @Test(arguments: ["", "0.7", "0.7.0.1", "v0.7.0", "0.7.x", "-1.0.0", "1..0", ".1.2", "1.2.", "٣.٠.٠", "99999999999999999999.0.0", "abc"])
    func anythingElseIsNotAVersion(text: String) {
        #expect(VersionNumber(text) == nil)
        #expect(VersionNumber(strict: text) == nil)
    }

    @Test func nilIsNotAVersion() {
        #expect(VersionNumber(nil) == nil)
    }

    @Test func strictMeansNothingAfterTheThirdNumber() {
        #expect(VersionNumber(strict: "0.7.0") == VersionNumber(0, 7, 0))
        #expect(VersionNumber(strict: "0.7.0-beta") == nil)
        #expect(VersionNumber(strict: " 0.7.0") == nil)
    }

    @Test func itPrintsAsXYZ() {
        #expect(VersionNumber(0, 10, 3).description == "0.10.3")
    }
}
