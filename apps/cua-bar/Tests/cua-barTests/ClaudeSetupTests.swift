import Foundation
import Testing
@testable import cua_bar

/// What the app reads of Claude Code (`~/.claude.json`, and the skill folders 0.8.x left) and what it changes there.
/// Everything runs over a throwaway home, and `claude` is a stand-in that is never run for real.
struct ClaudeSetupTests {
    private func make(
        _ home: TempHome, found: Bool = true, responses: @escaping @Sendable (StepRunner.Call) throws -> ProcessOutput = { _ in StepRunner.ok() }
    ) -> (claude: ClaudeIntegration, runner: StepRunner) {
        let path = home.claudeCLI.path
        let runner = StepRunner(handler: responses)
        return (ClaudeIntegration(home: home.url, claude: ClaudeCLILocator(home: home.url, isExecutableFile: { found && $0 == path }), runner: runner), runner)
    }

    // MARK: The MCP server in ~/.claude.json

    @Test func noFileNoServersOrNoCuaMeansMissing() throws {
        let home = try TempHome()
        defer { home.remove() }
        let (claude, _) = make(home)
        #expect(claude.mcpState(launcher: home.launcher) == .missing, "no file")
        try home.writeClaudeConfig(["numStartups": 3])
        #expect(claude.mcpState(launcher: home.launcher) == .missing, "no mcpServers")
        try home.writeClaudeConfig(["mcpServers": ["other": ["command": "/usr/bin/other"]]])
        #expect(claude.mcpState(launcher: home.launcher) == .missing, "others only")
    }

    @Test func theAppsOwnServerWithTheLauncherAndNoArgumentsIsReady() throws {
        let home = try TempHome()
        defer { home.remove() }
        let (claude, _) = make(home)
        try home.addMcp(command: home.launcher, others: ["other": ["command": "/usr/bin/other"]])
        #expect(claude.mcpState(launcher: home.launcher) == .ready)
        #expect(claude.mcpState(launcher: nil) == .ready, "the engine said nothing: the default launcher")
        #expect(claude.mcpState(launcher: "relative/path") == .ready, "and a path that is not absolute is not believed")
    }

    @Test func theAppsOwnServerThatIsNotWhatTheAppInstallsIsOutdated() throws {
        let home = try TempHome()
        defer { home.remove() }
        let (claude, _) = make(home)
        try home.addMcp(command: home.engineCopies.appendingPathComponent("0.6.0/start-mcp.sh").path)
        #expect(claude.mcpState(launcher: home.launcher) == .outdated, "a version folder, from before the one launcher")
        try home.addMcp(command: home.launcher, args: ["--x"])
        #expect(claude.mcpState(launcher: home.launcher) == .outdated, "arguments")
        try home.addMcp(command: home.launcher)
        #expect(claude.mcpState(launcher: "/other/home/.local/share/codex-cua/engine/current/start-mcp.sh") == .outdated, "another launcher reported")
    }

    @Test func aServerThatIsNotUnderTheEngineFolderIsNotTheAppsAndNeverOutdated() throws {
        let home = try TempHome()
        defer { home.remove() }
        let (claude, _) = make(home)
        for command in [
            "/Users/someone/.claude/plugins/cache/chenjing-plugins/cua/0.7.0/start-mcp.sh",
            home.url.appendingPathComponent(".local/share/codex-cua/engine-other/start-mcp.sh").path,
            home.url.appendingPathComponent(".local/share/codex-cua/start-mcp.sh").path,
            "/usr/local/bin/cua",
        ] {
            try home.addMcp(command: command)
            #expect(claude.mcpState(launcher: home.launcher) == .conflict, "\(command)")
        }
        try home.addMcp(command: "/x", type: "http")
        try home.writeClaudeConfig(["mcpServers": ["cuabar": ["type": "http", "url": "https://example.com/mcp"]]])
        #expect(claude.mcpState(launcher: home.launcher) == .conflict, "a server without a command")
        try home.writeClaudeConfig(["mcpServers": ["cuabar": "oops"]])
        #expect(claude.mcpState(launcher: home.launcher) == .conflict)
    }

    @Test func theEngineFolderCountsWhetherItIsWrittenWithLinksOrWithout() throws {
        let home = try TempHome()
        defer { home.remove() }
        // A support folder that is a link: the engine writes real paths.
        let real = home.url.appendingPathComponent("elsewhere/engine", isDirectory: true)
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home.engineCopies.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: home.engineCopies, withDestinationURL: real)
        let (claude, _) = make(home)
        try home.addMcp(command: real.resolvingSymlinksInPath().appendingPathComponent("current/start-mcp.sh").path)
        #expect(claude.mcpState(launcher: real.resolvingSymlinksInPath().appendingPathComponent("current/start-mcp.sh").path) == .ready)
        #expect(claude.mcpState(launcher: nil) == .outdated, "the app's, but not the launcher it would add by default")
    }

    @Test func aFileThatCannotBeReadIsUnknownAndNeverAConflict() throws {
        let home = try TempHome()
        defer { home.remove() }
        let (claude, _) = make(home)
        try home.write("{not json", to: home.claudeConfig)
        #expect(claude.mcpState(launcher: home.launcher) == .unknown)
        try home.writeClaudeConfig(["mcpServers": "oops"])
        #expect(claude.mcpState(launcher: home.launcher) == .unknown)
    }

    @Test func claudeCodeIsFoundWhereItIsInstalled() throws {
        let home = try TempHome()
        defer { home.remove() }
        #expect(make(home, found: true).claude.claudeCodeFound)
        #expect(!make(home, found: false).claude.claudeCodeFound)
        let state = make(home, found: false).claude.inspect(launcher: nil)
        #expect(!state.claudeCodeFound)
        #expect(state.mcp == .missing)
    }

    // MARK: The big file is not read again when it did not change

    @Test func theConfigIsParsedAgainOnlyWhenTheFileChanged() throws {
        let home = try TempHome()
        defer { home.remove() }
        let (claude, _) = make(home)
        #expect(claude.configParseCount == 0)
        try home.addMcp(command: home.launcher)
        for _ in 0..<5 { #expect(claude.mcpState(launcher: home.launcher) == .ready) }
        #expect(claude.configParseCount == 1, "five looks at an unchanged file")

        // The same size, written again: the file is not the same any more.
        try home.addMcp(command: home.launcher.replacingOccurrences(of: "current", with: "curren2"))
        #expect(claude.mcpState(launcher: home.launcher) == .outdated)
        #expect(claude.configParseCount == 2)
        for _ in 0..<3 { _ = claude.mcpState(launcher: home.launcher) }
        #expect(claude.configParseCount == 2)

        // Replaced by a file that cannot be read, and then taken away.
        try home.write("{not json", to: home.claudeConfig)
        #expect(claude.mcpState(launcher: home.launcher) == .unknown)
        #expect(claude.configParseCount == 3)
        try FileManager.default.removeItem(at: home.claudeConfig)
        #expect(claude.mcpState(launcher: home.launcher) == .missing)
    }

    @Test func aCopyOfTheIntegrationSharesWhatWasRead() throws {
        let home = try TempHome()
        defer { home.remove() }
        let (claude, _) = make(home)
        let copy = claude
        try home.addMcp(command: home.launcher)
        _ = claude.mcpState(launcher: nil)
        _ = copy.mcpState(launcher: nil)
        #expect(claude.configParseCount == 1)
        #expect(copy.configParseCount == 1)
    }

    @Test func theCachedReadStillAnswersForWhateverLauncherIsAsked() throws {
        let home = try TempHome()
        defer { home.remove() }
        let (claude, _) = make(home)
        try home.addMcp(command: home.launcher)
        #expect(claude.mcpState(launcher: home.launcher) == .ready)
        #expect(claude.mcpState(launcher: "/elsewhere/.local/share/codex-cua/engine/current/start-mcp.sh") == .outdated)
        #expect(claude.mcpState(launcher: nil) == .ready)
        #expect(claude.configParseCount == 1)
    }

    // MARK: The skill folder 0.8.x put in

    @Test func onlyAMarkedRealFolderIsTheSkill08xLeft() throws {
        // Since 0.8.10 the app installs no skill; the one 0.8.x put in is told (F9). Without the mark it is the person's.
        let home = try TempHome()
        defer { home.remove() }
        let (claude, _) = make(home)
        #expect(!claude.retiredSkillPresent(), "nothing there")
        try home.addSkill(version: nil, body: "the user's own cuabar skill\n")
        #expect(!claude.retiredSkillPresent(), "no mark: the person's own")
        #expect(!claude.leftovers().retiredSkill)
        try home.addSkill(version: "0.8.9")
        #expect(claude.retiredSkillPresent())
        #expect(claude.leftovers().retiredSkill)
        #expect(claude.inspect(launcher: nil).retiredSkill)
        try home.write("not json", to: home.skillFolder.appendingPathComponent(".cua-bar.json"))
        #expect(claude.retiredSkillPresent(), "a mark nobody can read is still the app's file")
        // A link named cuabar, even to a marked folder, or a file, is not the app's folder.
        try FileManager.default.removeItem(at: home.skillFolder)
        let target = home.url.appendingPathComponent("my-skills/cuabar", isDirectory: true)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        try home.write(#"{"version": "0.8.9"}"#, to: target.appendingPathComponent(".cua-bar.json"))
        try FileManager.default.createSymbolicLink(at: home.skillFolder, withDestinationURL: target)
        #expect(!claude.retiredSkillPresent(), "a link")
        try FileManager.default.removeItem(at: home.skillFolder)
        try home.write("a file", to: home.skillFolder)
        #expect(!claude.retiredSkillPresent(), "a file")
    }

    // MARK: Taking away what is the app's, and nothing else

    @Test func removalTakesTheAppsServerThroughClaudeCodeAndLeavesTheSkill08xPutIn() async throws {
        let home = try TempHome()
        defer { home.remove() }
        try home.addMcp(command: home.launcher, others: ["other": ["command": "/usr/bin/other"]])
        try home.addSkill(version: "0.8.9")
        let (claude, runner) = make(home) { call in
            // `claude mcp remove` takes only cuabar out of the file.
            try home.writeClaudeConfig(["mcpServers": ["other": ["command": "/usr/bin/other"]]])
            return StepRunner.ok()
        }
        let removal = await claude.removeAppOwned()
        #expect(removal == ClaudeIntegration.Removal(mcpStays: false, removedAnything: true, retiredSkillStays: true))
        #expect(runner.calls.map(\.arguments) == [["mcp", "remove", "-s", "user", "cuabar"]])
        #expect(runner.calls.first?.executable == home.claudeCLI.path)
        #expect(FileManager.default.fileExists(atPath: home.skillFolder.appendingPathComponent("SKILL.md").path),
                "the app does not remove it (F9): the result gives the command")
        #expect(claude.mcpState(launcher: home.launcher) == .missing)
    }

    @Test func removalLeavesAServerAndASkillTheAppDidNotPutThere() async throws {
        let home = try TempHome()
        defer { home.remove() }
        try home.addMcp(command: "/Users/someone/.claude/plugins/cache/chenjing-plugins/cua/0.7.0/start-mcp.sh")
        try home.addSkill(version: nil, body: "the user's own\n")
        let before = try Data(contentsOf: home.claudeConfig)
        let (claude, runner) = make(home)
        let removal = await claude.removeAppOwned()
        #expect(removal == ClaudeIntegration.Removal(mcpStays: false), "nothing of the app's was there, and no mark on the skill")
        #expect(runner.calls.isEmpty)
        #expect(try Data(contentsOf: home.claudeConfig) == before)
        #expect(try String(contentsOf: home.skillFolder.appendingPathComponent("SKILL.md"), encoding: .utf8) == "the user's own\n")
    }

    @Test func aServerClaudeCodeCannotTakeAwayStaysAndIsToldWhetherThereIsNoCommandOrItRefuses() async throws {
        for found in [false, true] {
            let home = try TempHome()
            defer { home.remove() }
            try home.addMcp(command: home.launcher)
            let (claude, _) = make(home, found: found) { _ in StepRunner.failed() }
            let removal = await claude.removeAppOwned()
            #expect(removal == ClaudeIntegration.Removal(mcpStays: true), "claude found: \(found)")
        }
    }

    @Test func aConfigFileThatCannotBeReadMeansTheServerMayStayAndIsToldSoWithoutAnyCommand() async throws {
        let home = try TempHome()
        defer { home.remove() }
        try home.write("{not json", to: home.claudeConfig)
        let (claude, runner) = make(home)
        let removal = await claude.removeAppOwned()
        #expect(removal == ClaudeIntegration.Removal(mcpStays: true))
        #expect(runner.calls.isEmpty, "nothing is asked of Claude Code about a file nobody can read")
        #expect(try String(contentsOf: home.claudeConfig, encoding: .utf8) == "{not json", "and the file is left as it is")
    }

    @Test func removalWithNothingThereDoesNothing() async throws {
        let home = try TempHome()
        defer { home.remove() }
        let (claude, runner) = make(home)
        #expect(await claude.removeAppOwned() == ClaudeIntegration.Removal(mcpStays: false))
        #expect(runner.calls.isEmpty)
    }

    // MARK: The bundle and the Codex app

    @Test func theBundledEngineIsFoundByItsSetupScript() throws {
        let home = try TempHome()
        defer { home.remove() }
        let resources = home.url.appendingPathComponent("Fake.app/Contents/Resources", isDirectory: true)
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        let bundle = try #require(Bundle(url: home.url.appendingPathComponent("Fake.app")) ?? Bundle(path: home.url.appendingPathComponent("Fake.app").path))
        #expect(BundledEngine.locate(in: bundle) == nil, "a bundle with no engine, as a development build has")
        try home.write("#!/bin/sh\n", to: resources.appendingPathComponent("engine/setup.sh"))
        let found = try #require(BundledEngine.locate(in: bundle))
        #expect(found.setupScript.lastPathComponent == "setup.sh")
    }

    @Test func codexIsFoundInTheEnginesPlacesAndByItsBundleId() throws {
        let home = try TempHome()
        defer { home.remove() }
        func app(_ root: String, _ name: String, id: String) throws {
            try home.write(
                "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>\(id)</string></dict></plist>",
                to: URL(fileURLWithPath: root).appendingPathComponent("\(name)/Contents/Info.plist"))
        }
        let userApps = home.url.appendingPathComponent("Applications").path
        let locator = CodexLocator(home: home.url, environment: [:])
        #expect(!locator.isInstalled() || FileManager.default.fileExists(atPath: "/Applications/Codex.app") || FileManager.default.fileExists(atPath: "/Applications/ChatGPT.app"))
        try app(userApps, "Other.app", id: "com.openai.codex")
        try app(userApps, "Codex.app", id: "com.example.other")
        let userOnly = CodexLocator(home: home.url, environment: [:], isCodexBundle: { path in
            path.hasPrefix(home.url.path) && CodexLocator.looksLikeCodex(path)
        })
        #expect(!userOnly.isInstalled(), "wrong id or wrong name")
        try app(userApps, "ChatGPT.app", id: "com.openai.codex")
        #expect(userOnly.isInstalled())
        // An explicit choice is the only one considered.
        let chosen = CodexLocator(home: home.url, environment: ["CODEX_CUA_APP_PATH": userApps + "/Other.app"])
        #expect(chosen.isInstalled())
        let wrongChoice = CodexLocator(home: home.url, environment: ["CODEX_CUA_APP_PATH": userApps + "/Nope.app"])
        #expect(!wrongChoice.isInstalled())
    }
}

/// `claude` run for real (a script in a throwaway home): an npm-style one needs the `node` beside it, and one whose
/// interpreter is nowhere cannot start.
struct ClaudeCommandStartTests {
    private func integration(_ home: TempHome) -> ClaudeIntegration {
        let path = home.claudeCLI.path
        return ClaudeIntegration(
            home: home.url, claude: ClaudeCLILocator(home: home.url, isExecutableFile: { $0 == path }), runner: SystemProcessRunner(),
            commandTimeout: .seconds(20))
    }

    private func executable(_ text: String, at url: URL, in home: TempHome) throws {
        try home.write(text, to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    }

    @Test func anNpmStyleClaudeFindsTheNodeBesideIt() async throws {
        let home = try TempHome()
        defer { home.remove() }
        let folder = home.claudeCLI.deletingLastPathComponent()
        let ran = home.url.appendingPathComponent("node-ran")
        // The stand-in for node notes that it ran the script with the arguments.
        try executable("#!/bin/sh\necho \"$@\" > '\(ran.path)'\nexit 0\n", at: folder.appendingPathComponent("node"), in: home)
        try executable("#!/usr/bin/env node\n", at: home.claudeCLI, in: home)
        #expect(await integration(home).addMCP(command: "/x/start-mcp.sh") == .succeeded)
        let line = try String(contentsOf: ran, encoding: .utf8)
        #expect(line.hasPrefix(home.claudeCLI.path + " mcp add -s user cuabar -- /x/start-mcp.sh"))
    }

    @Test func aClaudeWhoseInterpreterIsNowhereCannotStart() async throws {
        let home = try TempHome()
        defer { home.remove() }
        try executable("#!/usr/bin/env cua-bar-test-no-such-interpreter\n", at: home.claudeCLI, in: home)
        #expect(await integration(home).addMCP(command: "/x/start-mcp.sh") == .cannotStart)
        #expect(await integration(home).removeMCP() == .cannotStart)
    }

    @Test func aClaudeThatRunsAndFailsIsAFailureNotACannotStart() async throws {
        let home = try TempHome()
        defer { home.remove() }
        try executable("#!/bin/sh\nexit 1\n", at: home.claudeCLI, in: home)
        #expect(await integration(home).addMCP(command: "/x/start-mcp.sh") == .failed)
    }

    @Test func pathFirstPutsTheFoldersInFrontOnce() {
        let changed = SystemProcessRunner.environment(["PATH": "/usr/bin:/n:/bin", "HOME": "/h"], pathFirst: ["/n", "/m"])
        #expect(changed["PATH"] == "/n:/m:/usr/bin:/bin")
        #expect(changed["HOME"] == "/h")
        #expect(SystemProcessRunner.environment([:], pathFirst: ["/n"])["PATH"] == "/n")
    }
}
