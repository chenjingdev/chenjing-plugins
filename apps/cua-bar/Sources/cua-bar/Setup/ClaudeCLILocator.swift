import Darwin
import Foundation

/// Finds the Claude Code command line tool: the first executable regular file among the places
/// it is usually installed, in this order.
struct ClaudeCLILocator: Sendable {
    var home: URL
    /// Is the file at this path an executable regular file (a link is followed)? Injected so a
    /// test can say what exists without touching `/opt/homebrew` or `/usr/local`.
    var isExecutableFile: @Sendable (String) -> Bool

    init(
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        isExecutableFile: @escaping @Sendable (String) -> Bool = ClaudeCLILocator.isExecutableRegularFile
    ) {
        self.home = home
        self.isExecutableFile = isExecutableFile
    }

    /// `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, `~/.claude/local/claude`.
    var candidates: [String] {
        [
            home.appendingPathComponent(".local/bin/claude").path,
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude",
            home.appendingPathComponent(".claude/local/claude").path,
        ]
    }

    func locate() -> URL? {
        candidates.first(where: isExecutableFile).map { URL(fileURLWithPath: $0) }
    }

    /// `stat` follows links, so a `claude` that is a link to the real file counts, and a folder
    /// or a broken link does not.
    @Sendable
    static func isExecutableRegularFile(_ path: String) -> Bool {
        var info = stat()
        guard stat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return false }
        return access(path, X_OK) == 0
    }
}
