import Darwin
import Foundation

/// Finds the Claude Code command line tool: the first executable regular file among the places
/// it is usually installed, in this order. No login shell is run to ask where `claude` is on the PATH.
struct ClaudeCLILocator: Sendable {
    var home: URL
    /// Is the file at this path an executable regular file (a link is followed)? Injected so a
    /// test can say what exists without touching `/opt/homebrew` or `/usr/local`.
    var isExecutableFile: @Sendable (String) -> Bool
    /// The names in a folder (none when it is not there). Injected like the check above, so a test says
    /// which Node versions an nvm folder holds.
    var namesInFolder: @Sendable (String) -> [String]

    init(
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        isExecutableFile: @escaping @Sendable (String) -> Bool = ClaudeCLILocator.isExecutableRegularFile,
        namesInFolder: @escaping @Sendable (String) -> [String] = ClaudeCLILocator.namesInRealFolder
    ) {
        self.home = home
        self.isExecutableFile = isExecutableFile
        self.namesInFolder = namesInFolder
    }

    /// The places `claude` is installed at by its own installer, Homebrew, and the package managers that put a
    /// global command in a folder of their own: `~/.local/bin/claude`, `/opt/homebrew/bin/claude`,
    /// `/usr/local/bin/claude`, `~/.claude/local/claude`, `~/.bun/bin/claude`, `~/.volta/bin/claude`,
    /// `~/.npm-global/bin/claude`, `~/Library/pnpm/claude`.
    var fixedCandidates: [String] {
        [
            home.appendingPathComponent(".local/bin/claude").path,
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude",
            home.appendingPathComponent(".claude/local/claude").path,
            home.appendingPathComponent(".bun/bin/claude").path,
            home.appendingPathComponent(".volta/bin/claude").path,
            home.appendingPathComponent(".npm-global/bin/claude").path,
            home.appendingPathComponent("Library/pnpm/claude").path,
        ]
    }

    /// `~/.nvm/versions/node/<version>/bin/claude` for every Node version nvm holds, the highest version first.
    var nvmCandidates: [String] {
        let versions = home.appendingPathComponent(".nvm/versions/node").path
        return namesInFolder(versions).sorted(by: Self.isHigher).map { versions + "/" + $0 + "/bin/claude" }
    }

    var candidates: [String] { fixedCandidates + nvmCandidates }

    func locate() -> URL? {
        // The Node folders are listed only when nothing before them is there.
        let found = fixedCandidates.first(where: isExecutableFile) ?? nvmCandidates.first(where: isExecutableFile)
        return found.map { URL(fileURLWithPath: $0) }
    }

    /// `v22.1.0` before `v20.11.1` before `v9.0.0`: the numbers are compared as numbers. A name that is not a
    /// version comes after every version.
    static func isHigher(_ lhs: String, _ rhs: String) -> Bool {
        switch (numbers(in: lhs), numbers(in: rhs)) {
        case (let left?, let right?):
            return left == right ? lhs > rhs : left.lexicographicallyPrecedes(right) == false
        case (_?, nil): return true
        case (nil, _?): return false
        case (nil, nil): return lhs > rhs
        }
    }

    private static func numbers(in name: String) -> [Int]? {
        let core = name.hasPrefix("v") ? String(name.dropFirst()) : name
        let parts = core.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        guard !parts.isEmpty, !parts.contains(where: { $0 == nil }) else { return nil }
        return parts.compactMap { $0 }
    }

    /// `stat` follows links, so a `claude` that is a link to the real file counts, and a folder
    /// or a broken link does not.
    @Sendable
    static func isExecutableRegularFile(_ path: String) -> Bool {
        var info = stat()
        guard stat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return false }
        return access(path, X_OK) == 0
    }

    @Sendable
    static func namesInRealFolder(_ path: String) -> [String] {
        (try? FileManager.default.contentsOfDirectory(atPath: path)) ?? []
    }
}
