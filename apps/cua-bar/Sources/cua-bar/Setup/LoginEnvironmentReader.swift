import Foundation

/// What the check tab needs to say what a login environment conflict is made of: the agent file at the app's
/// own place, and the value in launchd. Both are only read.
struct LoginEnvironmentReading: Equatable, Sendable {
    /// The `Label` of `~/Library/LaunchAgents/com.chenjingdev.codex-cua.env.plist` when that file is somebody else's
    /// (another label); nil when there is no such file or it is the app's own.
    var agentLabel: String?
    /// `launchctl getenv CODEX_CLI_PATH`; nil when it is unset or could not be read.
    var launchdValue: String?
}

/// Reads the login environment without changing it: the plist's label and `launchctl getenv CODEX_CLI_PATH`.
/// The tab asks only while the engine's status calls the login environment a conflict or stale.
struct LoginEnvironmentReader: Sendable {
    /// The label the app's own agent has (the engine's `LOGIN_LABEL`).
    static let appLabel = "com.chenjingdev.codex-cua.env"
    static let launcherKey = "CODEX_CLI_PATH"

    var home: URL
    var runner: any ProcessRunning
    var timeout: Duration

    init(home: URL = FileManager.default.homeDirectoryForCurrentUser, runner: any ProcessRunning = SystemProcessRunner(), timeout: Duration = .seconds(5)) {
        self.home = home
        self.runner = runner
        self.timeout = timeout
    }

    var agentFile: URL { home.appendingPathComponent("Library/LaunchAgents/\(Self.appLabel).plist") }

    /// The value the app's setup puts into `CODEX_CLI_PATH`.
    var appLauncherValue: String {
        home.appendingPathComponent(".local/share/codex-cua/start-desktop-cli.sh").path
    }

    func read() async -> LoginEnvironmentReading {
        LoginEnvironmentReading(agentLabel: foreignAgentLabel(), launchdValue: await launchdValue())
    }

    private func foreignAgentLabel() -> String? {
        guard
            let data = try? Data(contentsOf: agentFile),
            let plist = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any],
            let label = plist["Label"] as? String, label != Self.appLabel
        else { return nil }
        return label
    }

    private func launchdValue() async -> String? {
        do {
            let output = try await runner.run(
                URL(fileURLWithPath: "/bin/launchctl"), arguments: ["getenv", Self.launcherKey], timeout: timeout)
            guard output.exitCode == 0 else { return nil }
            let value = String(decoding: output.stdout, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            return value.isEmpty ? nil : value
        } catch {
            return nil
        }
    }
}
