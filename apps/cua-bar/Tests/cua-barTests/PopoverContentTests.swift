import Foundation
import Testing
@testable import cua_bar

struct PopoverContentTests {
    private func content(_ name: String) throws -> PopoverContent {
        PopoverContent(status: try Fixtures.status(name), now: Fixtures.now, calendar: Fixtures.utc)
    }

    private func content(of status: EngineStatus) -> PopoverContent {
        PopoverContent(status: status, now: Fixtures.now, calendar: Fixtures.utc)
    }

    // MARK: Empty states (R21: every tab says "없음" in one line)

    @Test func everyTabHasAOneLineEmptyStateWhenThereIsNothing() {
        let empty = content(of: EngineStatus())
        #expect(empty.connections.emptyText == "연결 없음")
        #expect(empty.connections.groups.isEmpty)
        // The lease list cannot be read here, so "no leases" would be a claim.
        #expect(empty.leases.emptyText == "기록상 남은 점유 없음")
        #expect(empty.leases.rows.isEmpty)
        #expect(empty.otherTools.emptyText == "다른 도구 없음")
        #expect(empty.otherTools.tools.isEmpty)
        #expect(empty.activity.emptyText == "기록 없음")
        #expect(empty.activity.rows.isEmpty)
    }

    @Test func tabsKnowTheirEmptyLine() {
        #expect(PopoverTab.connections.emptyText == "연결 없음")
        #expect(PopoverTab.leases.emptyText == "점유 없음")
        #expect(PopoverTab.otherTools.emptyText == "다른 도구 없음")
        #expect(PopoverTab.activity.emptyText == "기록 없음")
        #expect(PopoverTab.allCases.map(\.title) == ["연결", "브라우저 점유", "다른 도구", "기록"])
    }

    @Test func tabsWithContentHaveNoEmptyLine() throws {
        let full = try content("status-problem")
        #expect(full.connections.emptyText == nil)
        #expect(full.leases.emptyText == nil)
        #expect(full.otherTools.emptyText == nil)
        #expect(full.activity.emptyText == nil)
    }

    @Test func aNotRunningToolIsStillAToolSoTheTabIsNotEmpty() throws {
        var status = EngineStatus()
        status.otherTools = [OtherTool(name: "cmux-cua", running: false, pids: [], clients: [])]
        let content = content(of: status)
        #expect(content.otherTools.emptyText == nil)
        #expect(content.otherTools.tools.first?.statusText == "꺼져 있음")
    }

    // MARK: Connections

    @Test func connectionsAreGroupedByAgentWithEndedOnesFirst() throws {
        let connections = try content("status-problem").connections
        #expect(connections.groups.map(\.title) == ["Claude · 2", "Codex · 1"])
        #expect(connections.groups[0].rows.map(\.id) == ["claude-4001-1792300000", "claude-12345-1792320000"])
        #expect(connections.groups[1].rows.map(\.id) == ["codex-15888-1792319000"])
        #expect(connections.endedCount == 1)
    }

    @Test func aConnectionRowCarriesEverythingTheRowShows() throws {
        let rows = try content("status-problem").connections.groups.flatMap(\.rows)

        let ended = try #require(rows.first { $0.id == "claude-4001-1792300000" })
        #expect(ended.agent == .claude)
        #expect(ended.folder == "dev/unified-login")
        #expect(ended.path == "/Users/chenjing/dev/unified-login")
        #expect(ended.startedText == "07:11 시작")
        #expect(ended.memoryText == "320 MB")
        #expect(ended.state == StateDisplay(kind: .ended, text: "끝남"))
        #expect(ended.isBusy == false)
        #expect(ended.canRelease)
        #expect(ended.canStop)

        let active = try #require(rows.first { $0.id == "claude-12345-1792320000" })
        #expect(active.folder == "dev/computer-use")
        #expect(active.startedText == "09:39 시작")
        #expect(active.memoryText == "210 MB")
        #expect(active.state == StateDisplay(kind: .inUse, text: "사용 중"))

        let resting = try #require(rows.first { $0.id == "codex-15888-1792319000" })
        #expect(resting.agent == .codex)
        #expect(resting.folder == "dev/new-chat")
        #expect(resting.startedText == "04:35 시작")
        #expect(resting.memoryText == "180 MB")
        #expect(resting.state == StateDisplay(kind: .resting, text: "쉼 42분"))
        #expect(resting.canRelease == false) // can_release is false: the button must be off
        #expect(resting.canStop)
    }

    @Test func theBusyMarkerComesFromTheBusyFlag() throws {
        let rows = try content("status-working").connections.groups.flatMap(\.rows)
        #expect(rows.first { $0.id == "claude-12345-1792320000" }?.isBusy == true)
        #expect(rows.first { $0.id == "codex-15888-1792319000" }?.isBusy == false)
    }

    @Test func unknownValuesInARowAreDashesNotGuesses() throws {
        let rows = try content("status-nulls").connections.groups.flatMap(\.rows)
        let row = try #require(rows.first)
        #expect(row.folder == "—")
        #expect(row.path == nil)
        #expect(row.startedText == "시작 시각 알 수 없음")
        #expect(row.memoryText == "—")
        #expect(row.state == StateDisplay(kind: .unknown, text: "알 수 없음"))
        #expect(row.canRelease == false)
        #expect(row.canStop == false)
    }

    @Test func otherAgentsGetTheirOwnGroupAfterClaudeAndCodex() throws {
        let content = try content("status-unknown-keys").connections
        #expect(content.groups.map(\.title) == ["Claude · 1", "gemini · 1"])
    }

    @Test func groupStopCountsPerGroup() throws {
        let problem = try content("status-problem").connections.stopCounts
        #expect(problem == GroupStopCounts(all: 3, claude: 2, codex: 1))
        #expect(problem.count(for: .all) == 3)
        #expect(problem.count(for: .claude) == 2)
        #expect(problem.count(for: .codex) == 1)

        let ready = try content("status-ready").connections.stopCounts
        #expect(ready == GroupStopCounts(all: 2, claude: 1, codex: 1))

        let none = content(of: EngineStatus()).connections.stopCounts
        #expect(none == GroupStopCounts(all: 0, claude: 0, codex: 0))
    }

    @Test func codexOnlyCountsConnectionsWithASessionBecauseTheEngineSkipsTheRest() throws {
        var status = try Fixtures.status("status-problem")
        // The Codex connection loses its session: an unrecorded runtime that may serve a Claude conversation.
        status.connections[2].sessionID = nil
        let counts = content(of: status).connections.stopCounts
        #expect(counts == GroupStopCounts(all: 3, claude: 2, codex: 0, unattributedCodex: 1))
        #expect(counts.count(for: .all) == 3, "--group all still stops it")
        #expect(counts.count(for: .codex) == 0, "--group codex skips it as unattributed")
        let connections = content(of: status).connections
        #expect(connections.stopButtons.map(\.title) == ["전체 끄기 3", "Claude만 2", "Codex만 0"])
        #expect(connections.stopButtons[2].isEnabled == false)
        #expect(connections.stopButtons[2].help.contains("주인을 모르는 1개는 빠져요"))
    }

    @Test func aCodexConnectionThatCannotBeStoppedIsNotCountedEvenWithASession() throws {
        var status = try Fixtures.status("status-problem")
        status.connections[2].canStop = false
        #expect(content(of: status).connections.stopCounts == GroupStopCounts(all: 2, claude: 2, codex: 0))
    }

    @Test func groupRowsAreHiddenWhenThereAreNoConnections() throws {
        #expect(content(of: EngineStatus()).connections.showsGroupButtons == false)
        #expect(try content("status-ready").connections.showsGroupButtons)
        #expect(try content("status-problem").connections.showsGroupButtons)
    }

    @Test func endedConnectionsTheEngineMayStopAreCounted() throws {
        let connections = try content("status-problem").connections
        #expect(connections.endedCount == 1)
        #expect(connections.endedStoppableCount == 1)
        var status = try Fixtures.status("status-problem")
        status.connections[0].canStop = false
        #expect(content(of: status).connections.endedStoppableCount == 0)
    }

    @Test func aRowKeepsTheContractStateNotOnlyHowItReads() throws {
        var status = try Fixtures.status("status-ready")
        // Active, but no call was ever recorded: it reads 알 수 없음 yet the contract says active.
        status.connections[0].idleSeconds = nil
        status.connections[0].lastCallAt = nil
        let rows = content(of: status).connections.groups.flatMap(\.rows)
        let row = try #require(rows.first { $0.id == status.connections[0].id })
        #expect(row.state == StateDisplay(kind: .unknown, text: "알 수 없음"))
        #expect(row.contractState == .active)
        #expect(row.sessionID == status.connections[0].sessionID)
        let ended = try content("status-problem").connections.groups.flatMap(\.rows).first { $0.contractState == .ended }
        #expect(ended?.id == "claude-4001-1792300000")
        let resting = try content("status-problem").connections.groups.flatMap(\.rows).first { $0.contractState == .idle }
        #expect(resting?.state.kind == .resting)
    }

    @Test func aRowAfterARefusedReleaseOffersRetryStopAndForceStop() throws {
        let rows = try content("status-problem").connections.groups.flatMap(\.rows)
        let row = try #require(rows.first { $0.id == "claude-12345-1792320000" })
        #expect(ConnectionRow.refusedNote == "작업이 끝나지 않아 못 놓음")
        #expect(row.refusedButtons.map(\.title) == ["다시 하기", "끄기", "강제 종료"])
        #expect(row.refusedButtons.map(\.action) == [
            .retryRelease("claude-12345-1792320000"),
            .stopConnection("claude-12345-1792320000", force: false),
            .stopConnection("claude-12345-1792320000", force: true),
        ])
        // A normal stop is not blocked by a refused release.
        #expect(row.refusedButtons[1].isEnabled)
    }

    @Test func theActivityTabKeepsItsDiagnosisButtonWithoutAStatus() {
        for isLoading in [true, false] {
            let placeholder = ActivityContent.placeholder(isLoading: isLoading)
            #expect(placeholder.rows.isEmpty)
            #expect(placeholder.copyButton.action == .copyDiagnosis)
            #expect(placeholder.copyButton.isEnabled)
            #expect(placeholder.copyButton.title == "진단 복사")
        }
        #expect(ActivityContent.placeholder(isLoading: true).emptyText == "불러오는 중…")
        #expect(ActivityContent.placeholder(isLoading: false).emptyText == "상태를 읽지 못해서 기록을 보일 수 없어요")
    }

    @Test func groupStopCountsOnlyWhatTheEngineMayStopAndOnlyClaudeAndCodex() throws {
        var status = try Fixtures.status("status-problem")
        status.connections[2].canStop = false // the Codex one
        status.connections.append(Connection(id: "gemini-1-1", agent: .other("gemini"), state: .active, canStop: true))
        let counts = content(of: status).connections.stopCounts
        #expect(counts == GroupStopCounts(all: 2, claude: 2, codex: 0))
    }

    // MARK: Leases (R14: no counts, "점유가 남았을 수 있음")

    @Test func unreadableLeasesShowTheLeftoverSessionsAsMaybeLeft() throws {
        let leases = try content("status-problem").leases
        #expect(leases.notice == "점유 목록을 읽지 못해서, 끝난 연결 기록으로 보여요")
        #expect(leases.rows.count == 2)

        let first = leases.rows[0]
        #expect(first.kind == .maybeLeft)
        #expect(first.agent == .claude)
        #expect(first.folder == "dev/y")
        #expect(first.statusText == "점유가 남았을 수 있음")
        #expect(first.detail == "11:40에 끝남 · 세션 019a1b2c")
        #expect(first.sessionID == "019a1b2c-0009")
        #expect(first.canReleaseSession)
        #expect(first.hint == nil)

        let second = leases.rows[1]
        #expect(second.agent == .codex)
        #expect(second.folder == "z/app")
        #expect(second.sessionID == nil)
        #expect(second.canReleaseSession == false)
        #expect(second.hint == "콕 집어 풀 방법이 없어요")
    }

    @Test func readableLeasesListTheItemsAndKeepTheLeftoversToo() throws {
        var status = try Fixtures.status("status-problem")
        status.leases.readable = true
        status.leases.items = [LeaseItem(sessionID: "019a-live", agent: .claude, connectionID: "claude-12345-1792320000",
                                         cwd: "/Users/chenjing/dev/computer-use", since: nil, releasable: true)]
        let leases = content(of: status).leases
        #expect(leases.notice == nil)
        #expect(leases.rows.map(\.kind) == [.held, .maybeLeft, .maybeLeft])
        #expect(leases.rows[0].statusText == "점유 중")
        #expect(leases.rows[0].folder == "dev/computer-use")
        #expect(leases.rows[0].canReleaseSession)
    }

    @Test func readableLeasesWithNothingHeldSayNone() throws {
        let leases = try content("status-ready").leases
        #expect(leases.rows.isEmpty)
        #expect(leases.emptyText == "점유 없음")
        #expect(leases.notice == nil)
    }

    @Test func unreadableLeasesWithNothingLeftStillSayNoneButExplainWhy() throws {
        var status = try Fixtures.status("status-ready")
        status.leases.readable = false
        let leases = content(of: status).leases
        #expect(leases.emptyText == "기록상 남은 점유 없음")
        #expect(leases.notice == "점유 목록을 읽지 못해요. 끝난 연결 기록으로만 알 수 있어요")
    }

    // MARK: Extension reset guidance (F3 case)

    @Test func guidanceListsTheLiveConnectionsAResetWouldCut() throws {
        let guidance = try content("status-problem").leases.guidance
        #expect(guidance.title == "그래도 안 풀리면 — 막힌 탭 닫기 · 확장 초기화")
        // Smallest remedy first (spec ruling): close the blocked tab, and only then reset the extension.
        #expect(guidance.steps == [
            "막힌 탭이 있으면 그 탭을 닫아요. 그 탭의 점유만 풀려서 다른 대화는 끊기지 않아요.",
            "그래도 안 풀리면 Chrome에서 chrome://extensions 페이지를 열어 ChatGPT 확장을 껐다가 다시 켜요.",
        ])
        #expect(guidance.warning == "확장을 껐다 켜면 이 Chrome을 쓰는 모든 CUA 연결의 점유가 한꺼번에 풀려요. 다른 작업 중에는 하지 마세요.")
        #expect(guidance.liveConnectionsTitle == "확장을 껐다 켜면 끊길 살아 있는 연결")
        // The ended Claude connection is not alive; the other two are.
        #expect(guidance.liveConnections == ["Claude · dev/computer-use", "Codex · dev/new-chat"])
        #expect(guidance.needsAttention) // one leftover has no per-session release
    }

    @Test func guidanceSaysNoneWhenNothingIsAlive() throws {
        var status = try Fixtures.status("status-problem")
        status.connections = []
        let guidance = content(of: status).leases.guidance
        #expect(guidance.liveConnections.isEmpty)
        #expect(guidance.liveConnectionsEmptyText == "없음")
    }

    @Test func guidanceIsCalmWhenEveryLeftoverCanBeReleasedOneByOne() throws {
        let guidance = try content("status-ready").leases.guidance
        #expect(guidance.needsAttention == false)
        #expect(guidance.liveConnections == ["Claude · dev/computer-use", "Codex · dev/new-chat"])
    }

    // MARK: Other tools and the screen

    @Test func whoUsesTheScreenNowComesFromTheActiveConnection() throws {
        let screen = try content("status-working").otherTools.screen
        #expect(screen.isActive)
        // The same words as the tooltip.
        #expect(screen.text == "Claude(dev/x)가 화면을 쓰는 중")
        #expect(screen.detail == "방금 호출")
    }

    @Test func nobodyUsingTheScreenIsSaidPlainly() throws {
        let screen = try content("status-problem").otherTools.screen
        #expect(screen.isActive == false)
        #expect(screen.text == "지금 화면을 쓰는 연결 없음")
        #expect(screen.detail == "마지막 호출 30초 전")
    }

    @Test func noRecordAtAllHasNoDetail() {
        let screen = content(of: EngineStatus()).otherTools.screen
        #expect(screen.isActive == false)
        #expect(screen.detail == nil)
    }

    @Test func otherToolsShowTheirStateProcessesAndClients() throws {
        let tools = try content("status-problem").otherTools.tools
        #expect(tools.count == 1)
        let tool = tools[0]
        #expect(tool.name == "cmux-cua")
        #expect(tool.isRunning)
        #expect(tool.statusText == "실행 중")
        #expect(tool.detail == "프로세스 2개")
        #expect(tool.clients == ["Claude · dev/z"])
    }

    @Test func aToolWithoutClientsHasNoClientLines() throws {
        let tool = try #require(try content("status-working").otherTools.tools.first)
        #expect(tool.clients.isEmpty)
    }

    // MARK: Activity

    @Test func activityRowsCarryTimeAgentFolderToolResultAndDuration() throws {
        let rows = try content("status-problem").activity.rows
        #expect(rows.count == 3)
        let first = rows[0]
        #expect(first.timeText == "11:59:30")
        #expect(first.agent == .claude)
        #expect(first.folder == "dev/computer-use")
        #expect(first.tool == "js")
        #expect(first.ok == true)
        #expect(first.durationText == "1.2초")
        let failed = rows[1]
        #expect(failed.ok == false)
        #expect(failed.durationText == "87ms")
        // The connection may be gone from the list; the row then keeps a dash instead of inventing a folder.
        var status = try Fixtures.status("status-problem")
        status.connections = []
        #expect(content(of: status).activity.rows[0].folder == "—")
    }

    @Test func activityRowsKeepTheEnginesNewestFirstOrderAndHaveUniqueIDs() throws {
        var status = try Fixtures.status("status-problem")
        let entry = status.activity[0]
        status.activity = [entry, entry, entry]
        let rows = content(of: status).activity.rows
        #expect(Set(rows.map(\.id)).count == 3)
        #expect(content(of: try Fixtures.status("status-problem")).activity.rows.map(\.timeText) == ["11:59:30", "11:58:12", "09:02:00"])
    }

    @Test func missingActivityValuesAreShownAsDashes() throws {
        let row = try #require(try content("status-nulls").activity.rows.first)
        #expect(row.timeText == "—")
        #expect(row.tool == "—")
        #expect(row.ok == nil)
        #expect(row.durationText == "—")
        #expect(row.folder == "—")
    }
}
