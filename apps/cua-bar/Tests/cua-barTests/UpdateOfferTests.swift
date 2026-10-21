import Foundation
import Testing
@testable import cua_bar

struct UpdateOfferTests {
    private func parse(_ json: String) throws -> UpdateOffer {
        try UpdateOffer.parse(Data(json.utf8))
    }

    private let eight = VersionNumber(0, 8, 0)

    @Test func theSitesDocumentIsRead() throws {
        let sha = String(repeating: "0123456789abcdef", count: 4)
        let offer = try parse(versionDocument("0.8.0", sha256: sha, size: 7_654_321))
        #expect(offer.version == eight)
        #expect(offer.file == "CUABar-v0.8.0-macos-arm64.dmg")
        #expect(offer.sha256 == sha)
        #expect(offer.size == 7_654_321)
    }

    @Test func theFileIsAlwaysAskedForOnTheSiteNeverAtTheDownloadAddressTheDocumentGives() throws {
        // The document's `download` points somewhere else; it is not followed.
        let offer = try parse(#"""
        {"version": "0.8.0", "file": "CUABar-v0.8.0-macos-arm64.dmg", "sha256": "\#(String(repeating: "a", count: 64))", "size": 10,
         "download": "https://evil.example/CUABar-v0.8.0-macos-arm64.dmg", "release": "https://evil.example/r"}
        """#)
        #expect(offer.url.absoluteString == "https://cua.chenjing.org/CUABar-v0.8.0-macos-arm64.dmg")
        #expect(UpdateSource.versionURL.absoluteString == "https://cua.chenjing.org/version")
    }

    @Test func aChecksumInUpperCaseIsKeptInLowerCase() throws {
        let offer = try parse(versionDocument(sha256: String(repeating: "AB", count: 32)))
        #expect(offer.sha256 == String(repeating: "ab", count: 32))
    }

    @Test func fieldsTheAppDoesNotKnowAreIgnored() throws {
        let offer = try parse(#"""
        {"version": "0.8.0", "file": "CUABar-v0.8.0-macos-arm64.dmg", "sha256": "\#(String(repeating: "a", count: 64))", "size": 10, "notes": ["x"], "future": {"a": 1}}
        """#)
        #expect(offer.version == eight)
    }

    @Test(arguments: [
        "CUABar-v0.8.0-macos-x86_64.dmg", "CUABar-v0.8.0-macos-arm64.zip", "CUABar-v0.8.0-macos-arm64.dmg.zip", "cuabar-v0.8.0-macos-arm64.dmg",
        "CUABar-V0.8.0-macos-arm64.dmg", "CUABar-0.8.0-macos-arm64.dmg", "CUABar-v0.8-macos-arm64.dmg", "CUABar-v0.8.0.1-macos-arm64.dmg",
        "CUABar-v0.8.0-beta-macos-arm64.dmg", "CUABar-v0.8.x-macos-arm64.dmg", "CUABar-v-macos-arm64.dmg", "../CUABar-v0.8.0-macos-arm64.dmg",
        "/CUABar-v0.8.0-macos-arm64.dmg", "sub/CUABar-v0.8.0-macos-arm64.dmg", "CUABar-v0.8.0-macos-arm64.dmg/../../x",
        "https://evil.example/CUABar-v0.8.0-macos-arm64.dmg", " CUABar-v0.8.0-macos-arm64.dmg", "CUABar-v0.8.0-macos-arm64.dmg ",
        "CUABar-v0.8.0-macos-arm64.dmg\\n", "CUABar-v0.8.0-macos-arm64\\ndmg", "other.dmg", "",
        // A file of another version than the document names is not this version's file.
        "CUABar-v0.8.1-macos-arm64.dmg", "CUABar-v0.7.9-macos-arm64.dmg", "CUABar-v0.08.0-macos-arm64.dmg",
    ])
    func onlyTheExactFileNameOfThatVersionIsTaken(file: String) {
        // JSON text, so "\\n" above is a line break inside the string.
        #expect(throws: UpdateOffer.Unusable(version: eight)) { try parse(versionDocument("0.8.0", file: file)) }
    }

    @Test(arguments: [
        String(repeating: "a", count: 63), String(repeating: "a", count: 65), String(repeating: "g", count: 64), "", "sha256:" + String(repeating: "a", count: 57),
        " " + String(repeating: "a", count: 63), String(repeating: "a", count: 63) + "\\n", String(repeating: "é", count: 32),
    ])
    func aChecksumThatIsNotSixtyFourHexDigitsIsRefused(sha: String) {
        #expect(throws: UpdateOffer.Unusable(version: eight)) { try parse(versionDocument("0.8.0", sha256: sha)) }
    }

    @Test(arguments: ["0", "-5", "\"1234\"", "true", "false", "1.5", "null", "[1]", "\(UpdateSource.fileSizeLimit + 1)", "99999999999999999999"])
    func aSizeThatIsNotAPlainPositiveNumberWithinTheLimitIsRefused(size: String) {
        let json = #"{"version": "0.8.0", "file": "CUABar-v0.8.0-macos-arm64.dmg", "sha256": "\#(String(repeating: "a", count: 64))", "size": \#(size)}"#
        #expect(throws: UpdateOffer.Unusable(version: eight)) { try parse(json) }
    }

    @Test func theLargestSizeAllowedIsTaken() throws {
        let offer = try parse(versionDocument("0.8.0", size: UpdateSource.fileSizeLimit))
        #expect(offer.size == UpdateSource.fileSizeLimit)
    }

    @Test func aMissingFieldIsRefusedButTheVersionIsStillKnown() {
        for json in [
            #"{"version": "0.8.0", "sha256": "\#(String(repeating: "a", count: 64))", "size": 5}"#,
            #"{"version": "0.8.0", "file": "CUABar-v0.8.0-macos-arm64.dmg", "size": 5}"#,
            #"{"version": "0.8.0", "file": "CUABar-v0.8.0-macos-arm64.dmg", "sha256": "\#(String(repeating: "a", count: 64))"}"#,
            #"{"version": "0.8.0"}"#,
        ] {
            #expect(throws: UpdateOffer.Unusable(version: eight)) { try parse(json) }
        }
    }

    @Test func aVersionThatIsNotThreeNumbersLeavesNothingToName() {
        for json in [
            versionDocument("0.8"), versionDocument("v0.8.0"), versionDocument("0.8.0-beta"), versionDocument("0.8.0.1"), versionDocument(""),
            #"{"version": 8, "file": "x", "sha256": "x", "size": 1}"#, #"{"file": "CUABar-v0.8.0-macos-arm64.dmg"}"#,
        ] {
            #expect(throws: UpdateOffer.Unusable(version: nil)) { try parse(json) }
        }
    }

    @Test func somethingThatIsNotAnObjectIsRefused() {
        for text in ["", "not json", "[]", "null", "42", #""0.8.0""#, "{", #"[{"version": "0.8.0"}]"#] {
            #expect(throws: UpdateOffer.Unusable(version: nil)) { try parse(text) }
        }
    }

    @Test func theFileNameIsMadeFromTheVersion() {
        #expect(UpdateOffer.fileName(for: VersionNumber(0, 10, 3)) == "CUABar-v0.10.3-macos-arm64.dmg")
    }

    // MARK: The request itself

    @Test func theVersionRequestIsOneAnonymousGetWithAFixedUserAgentAndTenSeconds() {
        let request = SiteUpdateTransport.versionRequest()
        #expect(request.url?.absoluteString == "https://cua.chenjing.org/version")
        #expect(request.httpMethod == "GET")
        #expect(request.timeoutInterval == 10)
        #expect(request.value(forHTTPHeaderField: "User-Agent") == "CUABar-update-check")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil, "no token")
        #expect(request.allHTTPHeaderFields?.keys.contains { $0.lowercased() == "cookie" } != true)
        #expect(request.httpShouldHandleCookies == false)
        #expect(request.httpBody == nil)
        #expect(request.cachePolicy == .reloadIgnoringLocalCacheData)
    }

    @Test func theFileIsAskedForOnTheSiteWithoutCompression() throws {
        let offer = try parse(versionDocument("0.8.0"))
        let request = SiteUpdateTransport.fileRequest(for: offer)
        #expect(request.url?.absoluteString == "https://cua.chenjing.org/CUABar-v0.8.0-macos-arm64.dmg")
        #expect(request.httpMethod == "GET")
        #expect(request.value(forHTTPHeaderField: "User-Agent") == "CUABar-update-check")
        #expect(request.value(forHTTPHeaderField: "Accept-Encoding") == "identity", "the bytes counted are the bytes of the file")
        #expect(request.httpShouldHandleCookies == false)
    }

    @Test func onlyAnHttpsAddressOnTheSiteIsFollowed() {
        #expect(SiteUpdateTransport.isOnTheSite(URL(string: "https://cua.chenjing.org/CUABar-v0.8.0-macos-arm64.dmg")))
        for address in [
            "http://cua.chenjing.org/x.dmg", "https://evil.example/x.dmg", "https://cua.chenjing.org.evil.example/x.dmg",
            "https://evil.example/cua.chenjing.org", "https://github.com/x/y", "ftp://cua.chenjing.org/x", "https://cua.chenjing.org:8443/x.dmg",
        ] {
            #expect(!SiteUpdateTransport.isOnTheSite(URL(string: address)), "\(address)")
        }
        #expect(!SiteUpdateTransport.isOnTheSite(nil))
    }
}
