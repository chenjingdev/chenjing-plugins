import Foundation

/// One published release of this app on GitHub.
struct ReleaseInfo: Equatable, Sendable {
    var version: VersionNumber
    var tag: String
    /// The release's page, what "새 버전 x.y.z" opens.
    var url: URL

    /// The footer button: "새 버전 0.8.0".
    var buttonTitle: String { "새 버전 \(version)" }
}

enum ReleaseSource {
    static let repository = "chenjingdev/chenjing-plugins"
    /// The tag every app release carries: `cua-bar--v<major>.<minor>.<patch>`. The repository also
    /// holds other things' releases (`pact--v0.3.1`), which are none of this app's business.
    static let tagPrefix = "cua-bar--v"
    static let listURL = URL(string: "https://api.github.com/repos/\(repository)/releases?per_page=50")!
    /// The releases page, for when no particular release is known.
    static let releasesPage = URL(string: "https://github.com/\(repository)/releases")!
}

enum ReleaseParseError: Error, Equatable {
    case notAReleaseList
}

enum ReleaseParser {
    /// The highest published app release in the list GitHub returned (nil when it has none).
    ///
    /// Only a tag spelled exactly `cua-bar--v<x>.<y>.<z>` counts, a draft or a prerelease never
    /// does, and versions are compared as numbers. Throws when the document is not a JSON list.
    static func latestAppRelease(in data: Data) throws -> ReleaseInfo? {
        guard let list = try? JSONSerialization.jsonObject(with: data) as? [Any] else {
            throw ReleaseParseError.notAReleaseList
        }
        var best: ReleaseInfo?
        for case let entry as [String: Any] in list {
            if (entry["draft"] as? Bool) == true || (entry["prerelease"] as? Bool) == true { continue }
            guard let tag = entry["tag_name"] as? String, let version = version(ofTag: tag) else { continue }
            if let current = best, current.version >= version { continue }
            best = ReleaseInfo(version: version, tag: tag, url: pageURL(for: tag, given: entry["html_url"] as? String))
        }
        return best
    }

    /// `cua-bar--v0.7.0` is 0.7.0; anything else (`cua-bar--v0.7`, `cua-bar--v0.7.0-beta`,
    /// `pact--v0.3.1`) is not an app release.
    static func version(ofTag tag: String) -> VersionNumber? {
        guard tag.hasPrefix(ReleaseSource.tagPrefix) else { return nil }
        return VersionNumber(strict: String(tag.dropFirst(ReleaseSource.tagPrefix.count)))
    }

    /// The `html_url` GitHub gave when it is a plain https page on github.com; otherwise the
    /// release page its tag makes.
    static func pageURL(for tag: String, given: String?) -> URL {
        if let given, let url = URL(string: given), url.scheme == "https", url.host == "github.com" { return url }
        return URL(string: "https://github.com/\(ReleaseSource.repository)/releases/tag/\(tag)") ?? ReleaseSource.releasesPage
    }
}
