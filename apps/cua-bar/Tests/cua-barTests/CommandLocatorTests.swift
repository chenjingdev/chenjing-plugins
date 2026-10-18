import Foundation
import Testing
@testable import cua_bar

struct CommandLocatorTests {
    @Test func thePresenceOfThePluginIsReadFromTheRegistryAndItsFolder() throws {
        let home = try TempHome()
        defer { home.remove() }
        let locator = CommandLocator(home: home.url)
        #expect(locator.pluginPresence() == .absent)                     // Claude Code has installed nothing
        try home.write(#"{"version": 2, "plugins": {"other@market": [{"scope": "user", "installPath": "/x"}]}}"#, to: locator.registryURL)
        #expect(locator.pluginPresence() == .absent)
        try home.installPlugin(createFolder: false)
        #expect(locator.pluginPresence() == .broken)
        try home.installPlugin()
        #expect(locator.pluginPresence() == .present)
        try home.write("{not json", to: locator.registryURL)
        #expect(locator.pluginPresence() == .unknown)
    }

    @Test func theAuthoredCommandWinsWhenItsMarkerIsInTheFirstThreeLines() throws {
        let home = try TempHome()
        defer { home.remove() }
        try home.writeCommand("#!/usr/bin/env python3\n# codex-cua authored command v1\nprint(1)\n")
        let location = CommandLocator(home: home.url).locate()
        #expect(location == .ready(home.command))

        try home.writeCommand("#!/bin/sh\n\n# codex-cua authored command v1\n")
        #expect(CommandLocator(home: home.url).locate() == .ready(home.command))
    }

    @Test func aMarkerBelowTheThirdLineIsNotOurs() throws {
        let home = try TempHome()
        defer { home.remove() }
        try home.writeCommand("#!/bin/sh\n\n\n# codex-cua authored command v1\n")
        #expect(CommandLocator(home: home.url).locate() == .pluginMissing)
    }

    @Test func someoneElsesCodexCuaIsNotOurs() throws {
        let home = try TempHome()
        defer { home.remove() }
        try home.writeCommand("#!/bin/sh\necho not ours\n")
        #expect(CommandLocator(home: home.url).locate() == .pluginMissing)
    }

    @Test func aBinaryAtThePathIsNotOurs() throws {
        let home = try TempHome()
        defer { home.remove() }
        try FileManager.default.createDirectory(at: home.command.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0xCF, 0xFA, 0xED, 0xFE, 0x00, 0x01, 0x02]).write(to: home.command)
        #expect(CommandLocator(home: home.url).locate() == .pluginMissing)
    }

    @Test func aRegisteredPluginWithoutTheCommandIsInstalledButNotSetUp() throws {
        let home = try TempHome()
        defer { home.remove() }
        let install = try home.installPlugin()
        #expect(CommandLocator(home: home.url).locate() == .installedNotSetUp(installPath: install))
    }

    @Test func theCommandBeatsTheRegistry() throws {
        let home = try TempHome()
        defer { home.remove() }
        try home.installPlugin()
        try home.writeCommand()
        #expect(CommandLocator(home: home.url).locate() == .ready(home.command))
    }

    @Test func onlyTheUserScopedRecordCounts() throws {
        let home = try TempHome()
        defer { home.remove() }
        try home.installPlugin(scope: "project")
        #expect(CommandLocator(home: home.url).locate() == .pluginMissing)
    }

    @Test func aRegistryEntryWhoseFolderIsGoneIsNotAnInstalledPlugin() throws {
        let home = try TempHome()
        defer { home.remove() }
        try home.installPlugin(createFolder: false)
        #expect(CommandLocator(home: home.url).locate() == .pluginMissing)
    }

    @Test func anEmptyOrBrokenRegistryMeansNotInstalled() throws {
        let home = try TempHome()
        defer { home.remove() }
        #expect(CommandLocator(home: home.url).locate() == .pluginMissing)
        try home.write("not json", to: home.url.appendingPathComponent(".claude/plugins/installed_plugins.json"))
        #expect(CommandLocator(home: home.url).locate() == .pluginMissing)
        try home.write(#"{"plugins": {"cua@chenjing-plugins": "oops"}}"#, to: home.url.appendingPathComponent(".claude/plugins/installed_plugins.json"))
        #expect(CommandLocator(home: home.url).locate() == .pluginMissing)
    }
}
