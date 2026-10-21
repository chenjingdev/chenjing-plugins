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

    /// What only a file signed by CUA Bar's own developer satisfies: a Developer ID Application certificate (the
    /// intermediate and the leaf carry Apple's Developer ID markers) of the team, chained to Apple. The system checks
    /// it against the signature (`codesign --verify -R`, `SecCodeCheckValidity`); nothing is read out of what a tool
    /// prints, and an ad hoc signature, another team's, or text that only claims the team all fail it.
    /// `identifier`: the name the code is signed as, left out for a file that is not the app.
    static func requirement(identifier: String?) -> String {
        var clauses = ["anchor apple generic"]
        if let identifier { clauses.append(#"identifier "\#(identifier)""#) }
        clauses += [
            "certificate 1[field.1.2.840.113635.100.6.2.6] exists",
            "certificate leaf[field.1.2.840.113635.100.6.1.13] exists",
            #"certificate leaf[subject.OU] = "\#(teamIdentifier)""#,
        ]
        return clauses.joined(separator: " and ")
    }

    /// The app: signed by the team, as CUA Bar.
    static let appRequirement = requirement(identifier: SingleInstance.bundleIdentifier)
    /// The disk image: signed by the team, whatever its name. Checked before it is mounted, so that an image of
    /// someone else is never opened.
    static let imageRequirement = requirement(identifier: nil)
    /// A disk image of the app is a few megabytes; a file larger than this is not one.
    static let fileSizeLimit = 512 * 1024 * 1024
    /// `/version` is a few hundred bytes.
    static let versionDocumentLimit = 64 * 1024

    /// The file lives on the site itself: `https://cua.chenjing.org/<file>`.
    static func fileURL(_ file: String) -> URL {
        site.appendingPathComponent(file)
    }

    /// The app bundle this process runs from; nil when it does not run from one (`swift run`).
    static func runningBundle(of bundle: Bundle = .main) -> URL? {
        guard bundle.bundleURL.pathExtension == "app", bundle.bundleIdentifier == SingleInstance.bundleIdentifier else { return nil }
        return bundle.bundleURL
    }

    /// The app bundle this process may replace: the one it runs from, when this process is the app CUA Bar's developer
    /// ships (`isOfficialBuild`: signed as `appRequirement` says). A development build, a local build signed ad hoc
    /// among them, gets nil: it looks for no update, shows no button and replaces nothing.
    static func replaceableBundle(of bundle: Bundle = .main, isOfficialBuild: () -> Bool = OfficialBuild.runningProcessIsOfficial) -> URL? {
        guard let url = runningBundle(of: bundle), isOfficialBuild() else { return nil }
        return url
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
