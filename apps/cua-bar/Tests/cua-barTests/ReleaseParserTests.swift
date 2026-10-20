import Foundation
import Testing
@testable import cua_bar

struct ReleaseParserTests {
    private func parse(_ json: String) throws -> ReleaseInfo? {
        try ReleaseParser.latestAppRelease(in: Data(json.utf8))
    }

    @Test func theHighestStableAppReleaseWinsAndEverythingElseIsIgnored() throws {
        let release = try #require(try ReleaseParser.latestAppRelease(in: Fixtures.data("releases-mixed")))
        // 0.7.10, not 0.7.9 (which sorts higher as text), and not the draft 0.9.0, the prerelease
        // 0.8.0, the beta tag, pact--v0.3.1, "cua-bar--v0.7", "xcua-bar--v9.9.9" or "v2.0.0".
        #expect(release.version == VersionNumber(0, 7, 10))
        #expect(release.tag == "cua-bar--v0.7.10")
        #expect(release.url.absoluteString == "https://github.com/chenjingdev/chenjing-plugins/releases/tag/cua-bar--v0.7.10")
    }

    @Test func otherTagsAloneMeanNoRelease() throws {
        #expect(try parse(#"[{"tag_name": "pact--v0.3.1", "draft": false, "prerelease": false, "html_url": "https://github.com/x/y/releases/tag/pact--v0.3.1"}]"#) == nil)
        #expect(try parse("[]") == nil)
    }

    @Test func aDraftAndAPrereleaseNeverCountEvenAlone() throws {
        #expect(try parse(#"[{"tag_name": "cua-bar--v1.0.0", "draft": true, "prerelease": false}]"#) == nil)
        #expect(try parse(#"[{"tag_name": "cua-bar--v1.0.0", "draft": false, "prerelease": true}]"#) == nil)
    }

    @Test(arguments: [
        "cua-bar--v1.2", "cua-bar--v1.2.3.4", "cua-bar--v1.2.3-rc.1", "cua-bar--v1.2.3+5", "cua-bar--v", "cua-bar--v1.2.x",
        "cua-bar-v1.2.3", "CUA-BAR--v1.2.3", "cua-bar--V1.2.3", "cua-bar--v 1.2.3", "xcua-bar--v1.2.3", "cua-bar--v-1.2.3",
        "cua-bar--v99999999999999999999.0.0", "pact--v1.2.3", "v1.2.3",
    ])
    func onlyTheExactTagSpellingIsAnAppRelease(tag: String) throws {
        #expect(ReleaseParser.version(ofTag: tag) == nil)
        #expect(try parse(#"[{"tag_name": "\#(tag)", "draft": false, "prerelease": false}]"#) == nil)
    }

    @Test func theExactTagSpellingIsRead() {
        #expect(ReleaseParser.version(ofTag: "cua-bar--v0.7.0") == VersionNumber(0, 7, 0))
        #expect(ReleaseParser.version(ofTag: "cua-bar--v10.20.30") == VersionNumber(10, 20, 30))
    }

    @Test func releasesWithoutDraftOrPrereleaseFieldsAreTakenAsPublished() throws {
        let release = try parse(#"[{"tag_name": "cua-bar--v0.7.1", "html_url": "https://github.com/chenjingdev/chenjing-plugins/releases/tag/cua-bar--v0.7.1"}]"#)
        #expect(release?.version == VersionNumber(0, 7, 1))
    }

    @Test func entriesThatAreNotObjectsOrLackATagAreSkipped() throws {
        let release = try parse(#"[1, "x", null, {"name": "no tag"}, {"tag_name": 5}, {"tag_name": "cua-bar--v0.7.2"}]"#)
        #expect(release?.version == VersionNumber(0, 7, 2))
    }

    @Test func aDocumentThatIsNotAListIsAnError() {
        for text in [#"{"message": "API rate limit exceeded"}"#, "not json", "", "42", "null"] {
            #expect(throws: ReleaseParseError.notAReleaseList) { try parse(text) }
        }
    }

    @Test func anOddPageAddressIsReplacedByTheOneTheTagMakes() throws {
        let tagPage = "https://github.com/chenjingdev/chenjing-plugins/releases/tag/cua-bar--v0.7.5"
        for given in [#""http://github.com/x/y""#, #""https://evil.example/cua""#, #""javascript:alert(1)""#, #""file:///etc/passwd""#, #""""#, "null", "5"] {
            let release = try parse(#"[{"tag_name": "cua-bar--v0.7.5", "draft": false, "prerelease": false, "html_url": \#(given)}]"#)
            #expect(release?.url.absoluteString == tagPage, "html_url \(given)")
        }
        #expect(try parse(#"[{"tag_name": "cua-bar--v0.7.5"}]"#)?.url.absoluteString == tagPage)
    }

    @Test func aPlainGithubPageIsKept() throws {
        let release = try parse(#"[{"tag_name": "cua-bar--v0.7.5", "html_url": "https://github.com/chenjingdev/chenjing-plugins/releases/tag/cua-bar--v0.7.5"}]"#)
        #expect(release?.url.host == "github.com")
        #expect(release?.url.scheme == "https")
    }

    @Test func theButtonSaysTheVersion() throws {
        let release = try #require(try ReleaseParser.latestAppRelease(in: Fixtures.data("releases-mixed")))
        #expect(release.buttonTitle == "새 버전 0.7.10")
    }
}
