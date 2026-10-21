import Foundation

/// Where an update comes from: one site, and nothing else is asked or opened for it (F4, R7).
enum UpdateSource {
    /// The download site. The address the person is sent to when an update could not be made by itself.
    static let site = URL(string: "https://cua.chenjing.org")!
    /// What the newest version is, and the checksum of its file.
    static let versionURL = URL(string: "https://cua.chenjing.org/version")!
    /// The Developer ID team the app is signed by; an app of another team is never put in its place.
    static let teamIdentifier = "S3KC8R8VDL"
    static let bundleName = "CUABar.app"
    /// A disk image of the app is a few megabytes; a file larger than this is not one.
    static let fileSizeLimit = 512 * 1024 * 1024
    /// `/version` is a few hundred bytes.
    static let versionDocumentLimit = 64 * 1024

    /// The file lives on the site itself: `https://cua.chenjing.org/<file>`.
    static func fileURL(_ file: String) -> URL {
        site.appendingPathComponent(file)
    }

    /// The app bundle this process runs from; nil when it does not run from one (`swift run`), and then the app
    /// never looks for an update or replaces anything.
    static func runningBundle(of bundle: Bundle = .main) -> URL? {
        guard bundle.bundleURL.pathExtension == "app", bundle.bundleIdentifier == SingleInstance.bundleIdentifier else { return nil }
        return bundle.bundleURL
    }
}

/// The newest version `/version` names: the version, the disk image that holds it, the image's SHA-256 and size.
///
/// Only what is spelled exactly right is taken. The image is `CUABar-v<version>-macos-arm64.dmg` of that same
/// version, the checksum is 64 hexadecimal digits, the size a plain positive number. The `download` address in
/// the document is never followed: the file is always asked for under `UpdateSource.site`.
struct UpdateOffer: Equatable, Sendable {
    var version: VersionNumber
    var file: String
    /// Lower case.
    var sha256: String
    var size: Int

    /// Where the image is taken from.
    var url: URL { UpdateSource.fileURL(file) }

    /// The name the image of this version has: `CUABar-v0.8.1-macos-arm64.dmg`.
    static func fileName(for version: VersionNumber) -> String {
        "CUABar-v\(version)-macos-arm64.dmg"
    }

    /// `/version` could not be used. `version` is what it named, when that much could be read: a newer version
    /// that cannot be fetched is still worth telling about.
    struct Unusable: Error, Equatable {
        var version: VersionNumber?
    }

    static func parse(_ data: Data) throws -> UpdateOffer {
        struct Head: Decodable { var version: String }
        struct Fields: Decodable {
            var version: String
            var file: String
            var sha256: String
            var size: Int
        }
        let decoder = JSONDecoder()
        guard let head = try? decoder.decode(Head.self, from: data), let version = VersionNumber(strict: head.version) else {
            throw Unusable(version: nil)
        }
        guard
            let fields = try? decoder.decode(Fields.self, from: data),
            // The name carries the version it holds, so a mismatch is not a file of this version.
            fields.file == fileName(for: version),
            isChecksum(fields.sha256),
            fields.size > 0, fields.size <= UpdateSource.fileSizeLimit
        else { throw Unusable(version: version) }
        return UpdateOffer(version: version, file: fields.file, sha256: fields.sha256.lowercased(), size: fields.size)
    }

    private static func isChecksum(_ text: String) -> Bool {
        text.utf8.count == 64 && text.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) || ($0 >= 0x41 && $0 <= 0x46) }
    }
}
