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

    private func rows(_ content: PopoverContent) -> [ConnectionRow] { content.connections.groups.flatMap(\.rows) }

    private func tidyRows(_ content: PopoverContent) -> [TidyRow] { content.connections.tidy?.rows ?? [] }

    // MARK: Empty states (R21: a tab with nothing says "없음" in one line)

    @Test func theListSaysNoConnectionInOneLineWhenThereIsNothing() {
        let empty = content(of: EngineStatus())
        #expect(empty.connections.emptyText == "연결 없음")
        #expect(empty.connections.groups.isEmpty)
        #expect(empty.connections.tidy == nil, "no 손볼 것 head, no 모두 정리")
        #expect(empty.connections.tools.isEmpty)
        #expect(empty.activity.emptyText == "기록 없음")
        #expect(empty.activity.rows.isEmpty)
        // The screen line and the folded guidance are always there.
        #expect(empty.connections.screen.line == "지금 화면을 쓰는 연결 없음")
        #expect(empty.connections.guidance.title == "브라우저 탭이 계속 막히면")
    }

    @Test func thereAreThreeTabsAndEachKnowsItsEmptyLine() {
        #expect(PopoverTab.allCases == [.connections, .activity, .check])
        #expect(PopoverTab.allCases.map(\.title) == ["연결", "기록", "점검"])
        #expect(PopoverTab.connections.emptyText == "연결 없음")
        #expect(PopoverTab.activity.emptyText == "기록 없음")
    }

    @Test func aListWithContentHasNoEmptyLine() throws {
        let full = try content("status-problem")
        #expect(full.connections.emptyText == nil)
        #expect(full.activity.emptyText == nil)
        #expect(try content("status-ready").connections.emptyText == nil)
    }

    @Test func aToolThatIsNotRunningIsOneLineAndNoConnection() throws {
        var status = EngineStatus()
        status.otherTools = [OtherTool(name: "cmux-cua", running: false, pids: [], clients: [])]
        let connections = content(of: status).connections
        #expect(connections.tools.map(\.title) == ["cmux-cua · 꺼져 있음"])
        #expect(connections.tools.first?.clients.isEmpty == true)
        #expect(connections.emptyText == "연결 없음", "a tool that is off is not a connection")
    }

    // MARK: Live connections: one 탭 풀기 each

    @Test func liveConnectionsAreGroupedByAgentAndTheEndedOnesLeaveTheGroups() throws {
        let connections = try content("status-problem").connections
        #expect(connections.groups.map(\.title) == ["Claude · 1", "Codex · 1"])
        #expect(connections.groups[0].rows.map(\.id) == ["claude-12345-1792320000"])
        #expect(connections.groups[1].rows.map(\.id) == ["codex-15888-1792319000"])
        // The ended Claude connection is a line of 손볼 것, not of the Claude group.
        #expect(tidyRows(try content("status-problem")).compactMap(\.endedRow).map(\.id) == ["claude-4001-1792300000"])
    }

    @Test func aLiveRowCarriesEverythingTheRowShowsAndOneButton() throws {
        let rows = try rows(content("status-problem"))
        let active = try #require(rows.first { $0.id == "claude-12345-1792320000" })
        #expect(active.agent == .claude)
        #expect(active.folder == "dev/computer-use")
        #expect(active.path == "/Users/chenjing/dev/computer-use")
        #expect(active.startedText == "09:39 시작")
        #expect(active.memoryText == "210 MB")
        #expect(active.state == StateDisplay(kind: .inUse, text: "사용 중"))
        #expect(active.isBusy == false)
        #expect(active.canRelease)
        // It is active, so its hover says what a press may cut off.
        #expect(active.button == ButtonSpec(
            title: "탭 풀기", action: .releaseConnection("claude-12345-1792320000"),
            help: "이 AI가 잡고 있는 브라우저 탭만 풀어요. 아직 일하는 중이면 하던 브라우저 작업이 끊겨요"))

        let resting = try #require(rows.first { $0.id == "codex-15888-1792319000" })
        #expect(resting.agent == .codex)
        #expect(resting.folder == "dev/new-chat")
        #expect(resting.startedText == "04:35 시작")
        #expect(resting.memoryText == "180 MB")
        #expect(resting.state == StateDisplay(kind: .resting, text: "쉼 42분"))
        #expect(resting.canRelease == false)
        // can_release is false: the button is off and says why.
        #expect(resting.button.title == "탭 풀기")
        #expect(resting.button.isEnabled == false)
        #expect(resting.button.help == "탭을 풀 길이 확인되지 않은 연결이에요. 중계기가 없거나 기록이 없을 때 그래요")
    }

    @Test func theBusyMarkerComesFromTheBusyFlag() throws {
        let rows = try rows(content("status-working"))
        #expect(rows.first { $0.id == "claude-12345-1792320000" }?.isBusy == true)
        #expect(rows.first { $0.id == "codex-15888-1792319000" }?.isBusy == false)
    }

    @Test func unknownValuesInARowAreDashesNotGuesses() throws {
        var status = try Fixtures.status("status-nulls")
        // On its first call: listed, though nothing about it is known yet.
        status.connections[0].busy = true
        let row = try #require(rows(content(of: status)).first)
        #expect(row.folder == "—")
        #expect(row.path == nil)
        #expect(row.startedText == "시작 시각 알 수 없음")
        #expect(row.memoryText == "—")
        #expect(row.state == StateDisplay(kind: .unknown, text: "알 수 없음"))
        #expect(row.canRelease == false)
        #expect(row.canStop == false)
        #expect(row.button.isEnabled == false, "nothing known: nothing may be offered")
    }

    @Test func aConnectionThatNeverMadeACallIsNotListed() throws {
        var status = try Fixtures.status("status-ready")
        let unused = Connection(id: "claude-777-1792300000", agent: .claude, state: .active, canRelease: true)
        status.connections.append(unused)
        #expect(!rows(content(of: status)).contains { $0.id == unused.id }, "it holds no tab: there is nothing to see or release")
        status.connections[status.connections.count-1].lastCallAt = Fixtures.now.addingTimeInterval(-60)
        #expect(rows(content(of: status)).contains { $0.id == unused.id }, "listed once it has made a call")
    }

    @Test func aConnectionThatHoldsNothingIsNotListedThoughAnExtensionResetStillNamesIt() throws {
        var status = try Fixtures.status("status-ready")
        let id = status.connections[0].id
        let live = status.connections.filter { $0.state != .ended }.count
        status.connections[0].holds = false      // its AI ended its turn a moment ago, or a 탭 풀기 did
        var connections = content(of: status).connections
        #expect(!connections.groups.flatMap(\.rows).contains { $0.id == id })
        #expect(connections.guidance.liveConnections.count == live, "an extension reset cuts it off all the same")
        status.connections[0].holds = true
        #expect(rows(content(of: status)).contains { $0.id == id }, "a turn its AI has not ended")
        status.connections[0].holds = false
        status.connections[0].busy = true
        connections = content(of: status).connections
        #expect(connections.groups.flatMap(\.rows).contains { $0.id == id }, "a call in flight is listed whatever it holds")
    }

    @Test func otherAgentsGetTheirOwnGroupAfterClaudeAndCodex() throws {
        let content = try content("status-unknown-keys").connections
        #expect(content.groups.map(\.title) == ["Claude · 1", "gemini · 1"])
    }

    @Test func aRowKeepsTheContractStateNotOnlyHowItReads() throws {
        var status = try Fixtures.status("status-ready")
        // Active, with no idle time: it reads 알 수 없음 yet the contract says active.
        status.connections[0].idleSeconds = nil
        let row = try #require(rows(content(of: status)).first { $0.id == status.connections[0].id })
        #expect(row.state == StateDisplay(kind: .unknown, text: "알 수 없음"))
        #expect(row.contractState == .active)
        #expect(row.sessionID == status.connections[0].sessionID)
        let ended = try #require(tidyRows(content("status-problem")).compactMap(\.endedRow).first)
        #expect(ended.contractState == .ended)
        let resting = try rows(content("status-problem")).first { $0.contractState == .idle }
        #expect(resting?.state.kind == .resting)
    }

    @Test func aRowAfterARefusedReleaseKeepsOnlyTabReleaseAndNeverStopsALiveAI() throws {
        let row = try #require(rows(content("status-problem")).first { $0.id == "claude-12345-1792320000" })
        #expect(ConnectionRow.refusedNote == "작업이 끝나지 않아 못 풀었어요")
        #expect(row.retryButton.title == "탭 풀기")
        #expect(row.retryButton.action == .retryRelease("claude-12345-1792320000"))
        #expect(row.retryButton.isEnabled)
    }

    // MARK: 손볼 것: ended connections, leases, connections nobody owns

    @Test func anEndedRowHasOneButtonTidyAndTheOnesTheAppCannotTidyHaveItOffWithAReason() throws {
        let ended = try #require(tidyRows(content("status-problem")).compactMap(\.endedRow).first)
        #expect(ended.state == StateDisplay(kind: .ended, text: "끝남"))
        #expect(ended.folder == "dev/unified-login")
        #expect(ended.startedText == "07:11 시작")
        #expect(ended.button == ButtonSpec(
            title: "정리", action: .tidy("claude-4001-1792300000"),
            help: "탭을 풀고 남은 연결을 꺼요. AI가 이미 없어서 끊길 것이 없어요. 제때 안 꺼지면 강제로 꺼요"))

        var status = try Fixtures.status("status-problem")
        status.connections[0].canStop = false
        let releaseOnly = try #require(tidyRows(content(of: status)).compactMap(\.endedRow).first)
        #expect(releaseOnly.button.isEnabled)
        #expect(releaseOnly.button.help == "탭만 풀어요. 이 연결은 앱이 끌 수 없어요")
        status.connections[0].canRelease = false
        let neither = try #require(tidyRows(content(of: status)).compactMap(\.endedRow).first)
        #expect(neither.button.title == "정리")
        #expect(neither.button.isEnabled == false)
        #expect(neither.button.help == "탭을 풀 길이 없고, 신원을 확인하지 못한 프로세스라 앱이 끌 수도 없어요")
    }

    @Test func anEndedLineTheAppCannotTidySaysWhyOnTheLineItselfAndNotOnlyOnHover() throws {
        var status = try Fixtures.status("status-problem")
        let ended = try #require(tidyRows(content(of: status)).compactMap(\.endedRow).first)
        #expect(ended.hint == nil, "one the app can tidy needs no explanation")

        status.connections[0].canStop = false
        status.connections[0].canRelease = false
        let stuck = try #require(tidyRows(content(of: status)).compactMap(\.endedRow).first)
        #expect(stuck.hint == "정리할 수 없어요 — 탭을 풀 길이 없고, 신원을 확인하지 못한 프로세스라 앱이 끌 수도 없어요")
        #expect(stuck.hint == ConnectionRow.cannotTidyHint)
        #expect(stuck.button.isEnabled == false)

        // A connection nobody owns that the app may not stop, and one an old engine does not name.
        var cmux = try Fixtures.status("status-cmux")
        cmux.otherTools[0].clients[1].canStop = false
        let protected = try #require(tidyRows(content(of: cmux)).compactMap(\.orphanRow).first)
        #expect(protected.hint == "정리할 수 없어요 — 신원을 확인하지 못한 프로세스라 앱이 끌 수 없어요")
        cmux.otherTools[0].clients[1].canStop = true
        #expect(try #require(tidyRows(content(of: cmux)).compactMap(\.orphanRow).first).hint == nil)
        cmux.otherTools[0].clients[1].id = nil
        let unnamed = try #require(tidyRows(content(of: cmux)).compactMap(\.orphanRow).first)
        #expect(unnamed.hint == "정리할 수 없어요 — 엔진이 이 연결의 이름을 알려 주지 않아요")
        #expect(unnamed.button == nil)
    }

    @Test func anEndedLineWhoseTabsTheAppReleasedAndMayDoNoMoreWithSaysSoAndItsButtonIsOff() throws {
        var status = try Fixtures.status("status-problem")
        status.connections[0].canStop = false // release only
        let id = status.connections[0].id
        let before = try #require(tidyRows(PopoverContent(status: status, now: Fixtures.now, calendar: Fixtures.utc)).compactMap(\.endedRow).first)
        #expect(before.hint == nil)
        #expect(before.button.isEnabled)
        let settled = PopoverContent(status: status, now: Fixtures.now, calendar: Fixtures.utc, tabsReleased: [id])
        let after = try #require(tidyRows(settled).compactMap(\.endedRow).first)
        #expect(after.hint == "탭은 풀었어요 — 앱이 끌 수 없는 연결이에요")
        #expect(after.hint == ConnectionRow.tabsReleasedHint)
        #expect(after.button.isEnabled == false)
        #expect(after.button.help == "이 연결은 앱이 끌 수 없어요. 탭은 이미 풀었어요")
        // One the app can stop is never settled, whatever was released before.
        status.connections[0].canStop = true
        let stoppable = PopoverContent(status: status, now: Fixtures.now, calendar: Fixtures.utc, tabsReleased: [id])
        #expect(try #require(tidyRows(stoppable).compactMap(\.endedRow).first).button.isEnabled)
    }

    @Test func aHeldSessionOfAnEndedConnectionIsNotAlsoListedAsHeld() throws {
        var status = try Fixtures.status("status-problem")
        status.leases.readable = true
        // 019a1b2c-0003 is the ended Claude connection's own session; 019a1b2c-0001 the live one's.
        status.leases.items = [
            LeaseItem(sessionID: "019a1b2c-0003", agent: .claude, connectionID: "claude-4001-1792300000", cwd: nil, since: nil, releasable: true),
            LeaseItem(sessionID: "019a1b2c-0001", agent: .claude, connectionID: "claude-12345-1792320000", cwd: nil, since: nil, releasable: true),
            LeaseItem(sessionID: "019a-other", agent: .claude, connectionID: nil, cwd: "/Users/chenjing/dev/o", since: nil, releasable: true),
        ]
        let tidy = try #require(content(of: status).connections.tidy)
        let held = tidy.rows.compactMap(\.leaseRow).filter { $0.kind == .held }
        #expect(held.map(\.sessionID) == ["019a-other"], "the ended line has its own 정리; nothing is on the list twice")
        #expect(tidy.rows.compactMap(\.endedRow).map(\.id) == ["claude-4001-1792300000"])
        #expect(tidy.title == "손볼 것 4개", "the ended line, the held one and the two leftovers")
    }

    @Test func theTidyListIsEndedNewestFirstThenLeasesThenConnectionsNobodyOwns() throws {
        var status = try Fixtures.status("status-cmux")
        status.connections.append(Connection(
            id: "claude-1-1", agent: .claude, state: .ended, startedAt: Fixtures.now.addingTimeInterval(-3600), canStop: true))
        status.connections.append(Connection(
            id: "codex-2-2", agent: .codex, state: .ended, startedAt: Fixtures.now.addingTimeInterval(-60), canStop: true))
        status.leases.maybeLeft = [LeftoverLease(sessionID: "019a-left", agent: .claude, connectionID: nil, cwd: nil, endedAt: nil, releasable: true)]
        let tidy = try #require(content(of: status).connections.tidy)
        #expect(tidy.title == "손볼 것 4개")
        #expect(tidy.rows.map(\.id) == ["ended-codex-2-2", "ended-claude-1-1", "lease-left-019a-left", "orphan-cmux-13440-1792229400"])
        #expect(tidy.tidyAllButton == ButtonSpec(
            title: "모두 정리", action: .tidyAll, help: "끝난 연결과 남은 점유를 한 번에 정리해요"))
    }

    @Test func nothingToTidyMeansNoHeadAtAll() throws {
        #expect(try content("status-ready").connections.tidy == nil)
        #expect(try content("status-working").connections.tidy == nil)
        #expect(try content("status-cmux").connections.tidy?.rows.map(\.id) == ["orphan-cmux-13440-1792229400"])
    }

    // MARK: Leases (R14: no counts, "점유가 남았을 수 있음")

    @Test func unreadableLeasesShowTheLeftoverSessionsAsMaybeLeftWithOneNotice() throws {
        let tidy = try #require(content("status-problem").connections.tidy)
        #expect(tidy.notice == "점유 목록을 읽지 못해서, 끝난 연결 기록으로 보여요")
        let leases = tidy.rows.compactMap(\.leaseRow)
        #expect(leases.count == 2)

        let first = leases[0]
        #expect(first.kind == .maybeLeft)
        #expect(first.agent == .claude)
        #expect(first.folder == "dev/y")
        #expect(first.statusText == "점유가 남았을 수 있음")
        #expect(first.detail == "11:40에 끝남", "the session reads like code: it is in the button's hint only")
        #expect(first.sessionID == "019a1b2c-0009")
        #expect(first.canReleaseSession)
        #expect(first.hint == nil)
        #expect(first.releaseButton == ButtonSpec(
            title: "탭 풀기", action: .releaseSession("019a1b2c-0009", user: true), help: "이 대화가 남긴 점유만 풀어요 (세션 019a1b2c)"))

        let second = leases[1]
        #expect(second.agent == .codex)
        #expect(second.folder == "z/app")
        #expect(second.sessionID == nil)
        #expect(second.canReleaseSession == false)
        #expect(second.releaseButton == nil, "no button where there is no way")
        #expect(second.hint == "풀 방법이 없어요 — 아래 안내를 따라 주세요")
    }

    // MARK: One session, one line (S16)

    /// The runtime of a conversation that ended (an ended connection), and the dead bridge that opened its session,
    /// which the engine still lists as a lease: the engine cannot aim at the session while the runtime serves it.
    private func runtimeAndItsDeadBridge(leaseReleasable: Bool = false, leaseSession: String = "019a-c21") throws -> EngineStatus {
        var status = try Fixtures.status("status-ready")
        status.connections = [Connection(
            id: "claude-31806-1792419210", agent: .claude, state: .ended, cwd: "/Users/chenjing/dev/c21",
            startedAt: Fixtures.now.addingTimeInterval(-60), sessionID: "019a-c21", canRelease: true, canStop: true)]
        status.leases.maybeLeft = [LeftoverLease(
            sessionID: leaseSession, agent: .claude, connectionID: "claude-31569-1792419209", cwd: "/Users/chenjing/dev/c21",
            endedAt: nil, releasable: leaseReleasable)]
        return status
    }

    @Test func aLeaseTheEndedConnectionStillServesIsNotASecondLine() throws {
        let connections = content(of: try runtimeAndItsDeadBridge()).connections
        let tidy = try #require(connections.tidy)
        #expect(tidy.rows.map(\.id) == ["ended-claude-31806-1792419210"], "one session, one line, and its 정리 is the way")
        #expect(tidy.title == "손볼 것 1개")
        #expect(tidy.notice == nil, "no lease line, so nothing to say about the unreadable list")
        #expect(connections.guidance.needsAttention == false, "and no advice to reset the extension for what 정리 does")
    }

    @Test func aLeaseTheEngineCanAimAtKeepsItsOwnLineBesideTheEndedConnection() throws {
        let tidy = try #require(content(of: try runtimeAndItsDeadBridge(leaseReleasable: true)).connections.tidy)
        #expect(tidy.rows.map(\.id) == ["ended-claude-31806-1792419210", "lease-left-019a-c21"])
    }

    @Test func aLeaseOfAnotherSessionKeepsItsLineAndItsAdvice() throws {
        let connections = content(of: try runtimeAndItsDeadBridge(leaseSession: "019a-other")).connections
        let tidy = try #require(connections.tidy)
        #expect(tidy.rows.map(\.id) == ["ended-claude-31806-1792419210", "lease-left-019a-other"])
        #expect(connections.guidance.needsAttention)
    }

    @Test func anEndedConnectionTheAppCanOnlyReleaseStillTakesTheLeaseLineAway() throws {
        var status = try runtimeAndItsDeadBridge()
        status.connections[0].canStop = false // the app may not stop it, but its 정리 still releases the tabs
        let tidy = try #require(content(of: status).connections.tidy)
        #expect(tidy.rows.map(\.id) == ["ended-claude-31806-1792419210"])
    }

    @Test func anEndedLineTheAppHasDoneAllItCanForIsNoButtonAndTheLeaseKeepsItsLine() throws {
        var status = try runtimeAndItsDeadBridge()
        status.connections[0].canStop = false // the app may only release it
        let settled = PopoverContent(status: status, now: Fixtures.now, calendar: Fixtures.utc, tabsReleased: ["claude-31806-1792419210"])
        // Its tabs are released in this run and its 정리 is off: the lease still there is not behind a button that works.
        let tidy = try #require(settled.connections.tidy)
        #expect(tidy.rows.map(\.id) == ["ended-claude-31806-1792419210", "lease-left-019a-c21"])
        #expect(settled.connections.guidance.needsAttention)
        // Before that, its 정리 is the way, as ever.
        #expect(try #require(content(of: status).connections.tidy).rows.map(\.id) == ["ended-claude-31806-1792419210"])
    }

    @Test func anEndedConnectionTheAppCannotTidyLeavesTheLeaseLineAndItsAdviceAsTheOnlyWayOn() throws {
        var status = try runtimeAndItsDeadBridge()
        status.connections[0].canStop = false
        status.connections[0].canRelease = false // 정리 is off: neither stop nor release
        let connections = content(of: status).connections
        let tidy = try #require(connections.tidy)
        #expect(tidy.rows.map(\.id) == ["ended-claude-31806-1792419210", "lease-left-019a-c21"])
        #expect(connections.guidance.needsAttention, "the extension reset is what is left, so its advice opens")
    }

    // MARK: One session, one line — a live connection holds it (build 7)

    /// What a person had on screen: a live Claude bridge (resting) whose thread's relay died with a scope open. The dead
    /// record lists the bridge's own session, so the lease cannot be aimed at while the bridge holds it.
    private func liveConnectionAndItsDeadRelay(state: ConnectionState = .idle, canRelease: Bool = true) throws -> EngineStatus {
        var status = try Fixtures.status("status-ready")
        status.connections = [Connection(
            id: "claude-23601-1792412520", agent: .claude, state: state, cwd: "/Users/chenjing/dev/unified-login",
            startedAt: Fixtures.now.addingTimeInterval(-3600), lastCallAt: Fixtures.now.addingTimeInterval(-600), idleSeconds: 600,
            sessionID: "019a-live", canRelease: canRelease, canStop: true)]
        status.leases.maybeLeft = [LeftoverLease(
            sessionID: "019a-live", agent: .codex, connectionID: "codex-23654-1792412521", cwd: "/Users/chenjing/dev/unified-login",
            endedAt: Fixtures.now.addingTimeInterval(-7200), releasable: false)]
        return status
    }

    @Test func aLeaseALiveConnectionHoldsIsNotASecondLine() throws {
        for state in [ConnectionState.idle, .active] {
            let connections = content(of: try liveConnectionAndItsDeadRelay(state: state)).connections
            #expect(connections.tidy == nil, "the live line's 탭 풀기 is the one place to press: \(state)")
            #expect(connections.groups.flatMap(\.rows).map(\.id) == ["claude-23601-1792412520"])
            #expect(connections.guidance.needsAttention == false, "and no advice to reset the extension")
        }
    }

    @Test func aLiveConnectionWithItsButtonOffLeavesTheLeaseLineAndItsAdvice() throws {
        let connections = content(of: try liveConnectionAndItsDeadRelay(canRelease: false)).connections
        let tidy = try #require(connections.tidy)
        #expect(tidy.rows.map(\.id) == ["lease-left-019a-live"], "no button to press on the live line: the lease keeps its own")
        #expect(connections.guidance.needsAttention)
    }

    @Test func aLiveConnectionOfAnotherSessionTakesNothingAway() throws {
        var status = try liveConnectionAndItsDeadRelay()
        status.connections[0].sessionID = "019a-other"
        #expect(try #require(content(of: status).connections.tidy).rows.map(\.id) == ["lease-left-019a-live"])
    }

    @Test func aLeaseTheEngineCanAimAtKeepsItsLineBesideTheLiveConnectionToo() throws {
        var status = try liveConnectionAndItsDeadRelay()
        status.leases.maybeLeft[0].releasable = true
        #expect(try #require(content(of: status).connections.tidy).rows.map(\.id) == ["lease-left-019a-live"])
    }

    @Test func aSessionALiveBridgeLeftUnderAnEarlierHostIsItsLineWhetherCodexIsOnOrNot() throws {
        // The engine names the live connection the lease's holder, and its 탭 풀기 releases the session by id. With Codex
        // on (releasable) the lease was a second line for the same session, and a problem on the card.
        var status = try liveConnectionAndItsDeadRelay()
        status.connections[0].holds = true
        status.leases.maybeLeft = [LeftoverLease(
            sessionID: "019a-earlier", agent: .claude, connectionID: "claude-23601-1792412520",
            cwd: "/Users/chenjing/dev/unified-login", endedAt: nil, releasable: true)]
        for releasable in [true, false] {
            status.leases.maybeLeft[0].releasable = releasable
            let connections = content(of: status).connections
            #expect(connections.tidy == nil, "releasable \(releasable)")
            #expect(connections.groups.flatMap(\.rows).map(\.id) == ["claude-23601-1792412520"], "releasable \(releasable)")
            #expect(StatusEvaluator.problem(in: status, appVersion: status.engine.version) == nil, "releasable \(releasable)")
        }
    }

    @Test func theLeaseNoticeIsSaidOnlyWhereThereIsALeaseLine() throws {
        // An unreadable list with nothing left: no lease line, so no notice and no head.
        var status = try Fixtures.status("status-ready")
        status.leases.readable = false
        #expect(content(of: status).connections.tidy == nil)
        // Readable: lease lines without the notice.
        var readable = try Fixtures.status("status-problem")
        readable.leases.readable = true
        #expect(content(of: readable).connections.tidy?.notice == nil)
        // An ended connection alone does not need the notice either.
        var endedOnly = try Fixtures.status("status-problem")
        endedOnly.leases.maybeLeft = []
        #expect(content(of: endedOnly).connections.tidy?.notice == nil)
    }

    @Test func readableLeasesListTheHeldOnesNobodyAliveOwnsAndKeepTheLeftoversToo() throws {
        var status = try Fixtures.status("status-problem")
        status.leases.readable = true
        status.leases.items = [
            // A live connection's own session is not for tidying.
            LeaseItem(sessionID: "019a1b2c-0001", agent: .claude, connectionID: "claude-12345-1792320000",
                      cwd: "/Users/chenjing/dev/computer-use", since: nil, releasable: true),
            LeaseItem(sessionID: "019a-held", agent: .claude, connectionID: nil, cwd: "/Users/chenjing/dev/h", since: nil, releasable: true),
            // The same session as a leftover is listed once.
            LeaseItem(sessionID: "019a1b2c-0009", agent: .claude, connectionID: nil, cwd: nil, since: nil, releasable: true),
        ]
        let leases = try #require(content(of: status).connections.tidy).rows.compactMap(\.leaseRow)
        #expect(leases.map(\.kind) == [.held, .maybeLeft, .maybeLeft])
        #expect(leases[0].statusText == "점유 중")
        #expect(leases[0].folder == "dev/h")
        #expect(leases[0].canReleaseSession)
        #expect(leases[0].releaseButton?.action == .releaseSession("019a-held", user: true))
    }

    // MARK: 모두 정리

    @Test func tidyAllIsShownOnlyWhenItHasTwoOrMoreLinesToDo() throws {
        // Only a Codex chat's lease is left: its own row releases it, and nothing else would.
        var status = try Fixtures.status("status-ready")
        status.leases.maybeLeft = [LeftoverLease(sessionID: "019a-codex", agent: .codex, connectionID: nil, cwd: nil, endedAt: nil, releasable: true)]
        #expect(try #require(content(of: status).connections.tidy).tidyAllButton == nil)

        // An ended connection nobody can tidy and no lease at all.
        var stuck = try Fixtures.status("status-ready")
        stuck.connections[0].state = .ended
        stuck.connections[0].canStop = false
        stuck.connections[0].canRelease = false
        #expect(try #require(content(of: stuck).connections.tidy).tidyAllButton == nil)

        // One line to do: its own 정리 is the one place to press, so 모두 정리 would only press it twice.
        var one = try Fixtures.status("status-ready")
        one.connections[0].state = .ended
        one.leases.maybeLeft = status.leases.maybeLeft // beside a Codex chat's lease, which 모두 정리 leaves alone
        let tidy = try #require(content(of: one).connections.tidy)
        #expect(tidy.rows.count == 2)
        #expect(tidy.tidyAllButton == nil)

        // Two: then it saves a press.
        one.connections[1].state = .ended
        #expect(try #require(content(of: one).connections.tidy).tidyAllButton == ButtonSpec(
            title: "모두 정리", action: .tidyAll, help: "끝난 연결과 남은 점유를 한 번에 정리해요"))
    }

    @Test func tidyAllTargetsEndedConnectionsClaudeLeasesAndOrphansButNoCodexChatNorLiveCmux() throws {
        var status = try Fixtures.status("status-cmux")
        status.connections.append(Connection(id: "claude-1-1", agent: .claude, state: .ended, startedAt: Fixtures.now, canStop: true))
        status.connections.append(Connection(id: "codex-2-2", agent: .codex, state: .ended, startedAt: Fixtures.now.addingTimeInterval(-5), canRelease: true))
        status.connections.append(Connection(id: "claude-3-3", agent: .claude, state: .ended, startedAt: Fixtures.now.addingTimeInterval(-9)))
        status.leases.maybeLeft = [
            LeftoverLease(sessionID: "019a-claude", agent: .claude, connectionID: nil, cwd: nil, endedAt: nil, releasable: true),
            LeftoverLease(sessionID: "019a-claude-no-way", agent: .claude, connectionID: nil, cwd: nil, endedAt: nil, releasable: false),
            LeftoverLease(sessionID: "019a-codex", agent: .codex, connectionID: nil, cwd: nil, endedAt: nil, releasable: true),
        ]
        #expect(TidyPlan.items(in: status) == [
            .connection("claude-1-1", .stop),
            .connection("codex-2-2", .releaseOnly),
            .session("019a-claude"),
            // The orphan goes in; the live cmux-cua connection (cmux-12892) is not here at all.
            .connection("cmux-13440-1792229400", .stop),
        ])
    }

    // MARK: Guidance (F3 case)

    @Test func guidanceListsTheLiveConnectionsAResetWouldCut() throws {
        let guidance = try content("status-problem").connections.guidance
        #expect(guidance.title == "브라우저 탭이 계속 막히면")
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
        let guidance = content(of: status).connections.guidance
        #expect(guidance.liveConnections.isEmpty)
        #expect(guidance.liveConnectionsEmptyText == "없음")
    }

    @Test func guidanceIsCalmWhenEveryLeftoverCanBeReleasedOneByOne() throws {
        let guidance = try content("status-ready").connections.guidance
        #expect(guidance.needsAttention == false)
        #expect(guidance.liveConnections == ["Claude · dev/computer-use", "Codex · dev/new-chat"])
    }

    // MARK: The screen line and the other tools

    @Test func whoUsesTheScreenNowComesFromTheActiveConnection() throws {
        let screen = try content("status-working").connections.screen
        #expect(screen.isActive)
        // The same words as the tooltip.
        #expect(screen.text == "Claude(dev/x)가 화면을 쓰는 중")
        #expect(screen.detail == "방금 호출")
        #expect(screen.line == "Claude(dev/x)가 화면을 쓰는 중 · 방금 호출")
    }

    @Test func nobodyUsingTheScreenIsSaidPlainly() throws {
        let screen = try content("status-problem").connections.screen
        #expect(screen.isActive == false)
        #expect(screen.text == "지금 화면을 쓰는 연결 없음")
        #expect(screen.detail == "마지막 호출 30초 전")
        #expect(screen.line == "지금 화면을 쓰는 연결 없음 · 마지막 호출 30초 전")
    }

    @Test func noRecordAtAllHasNoDetail() {
        let screen = content(of: EngineStatus()).connections.screen
        #expect(screen.isActive == false)
        #expect(screen.detail == nil)
    }

    @Test func aRunningToolIsOneHeadLineWithItsProcessesAndItsLiveClients() throws {
        let tools = try content("status-problem").connections.tools
        #expect(tools.count == 1)
        let tool = tools[0]
        #expect(tool.name == "cmux-cua")
        #expect(tool.isRunning)
        #expect(tool.title == "cmux-cua · 실행 중 · 프로세스 2개")
        // This fixture is an engine that does not name its clients: the row reads as it always did, with no button.
        let client = try #require(tool.clients.first)
        #expect(tool.clients.count == 1)
        #expect(client.title == "Claude · dev/z")
        #expect(client.connectionID == nil)
        #expect(client.button == nil)
    }

    @Test func aToolWithoutClientsHasNoClientLines() throws {
        let tool = try #require(try content("status-working").connections.tools.first)
        #expect(tool.clients.isEmpty)
        #expect(tool.title == "cmux-cua · 실행 중 · 프로세스 2개")
    }

    // MARK: Activity

    @Test func activityRowsCarryTimeAgentFolderToolResultAndDuration() throws {
        let rows = try content("status-problem").activity.rows
        #expect(rows.count == 3)
        let first = rows[0]
        #expect(first.timeText == "11:59:30")
        #expect(first.agent == .claude)
        #expect(first.folder == "dev/computer-use")
        #expect(first.tool == "화면 조작")
        #expect(first.ok == true)
        #expect(first.durationText == "1.2초")
        let failed = rows[1]
        #expect(failed.ok == false)
        #expect(failed.durationText == "87ms")
        // The connection may be gone from the list; the row then keeps a dash instead of inventing a folder.
        var status = try Fixtures.status("status-problem")
        status.connections = []
        #expect(content(of: status).activity.rows[0].folder == "—")
        // Unless the line names its own folder, as a writer of 0.8.2 on does: it outlives the connection.
        status.activity[0].cwd = "/Users/chenjing/dev/gone-project"
        #expect(content(of: status).activity.rows[0].folder == "dev/gone-project")
    }

    @Test func aFailedRowSaysWhyWhenTheLineSaysSoInAWordWorthShowing() throws {
        var status = try Fixtures.status("status-problem")
        let entry = status.activity[1]
        #expect(entry.ok == false)
        status.activity = ["timeout", "screen_locked", "error", nil, "something new"].map { word in
            var line = entry
            line.error = word
            return line
        }
        #expect(content(of: status).activity.rows.map(\.failureText) == ["시간 초과", "화면 잠김", nil, nil, nil])
        // A call that worked has no reason, whatever its line says.
        status.activity = [ActivityEntry(tool: "js", ok: true, ms: 5, error: "timeout")]
        #expect(content(of: status).activity.rows.map(\.failureText) == [nil])
    }

    @Test func aFailedRowShowsWhatItsAnswerSaidAndTheTabCarriesTheSwitch() throws {
        var status = try Fixtures.status("status-problem")
        #expect(content(of: status).activity.keepsErrorText == false)
        #expect(content(of: status).activity.rows.map(\.failureDetail) == [nil, nil, nil])
        status.settings.errorText = true
        status.activity[1].errorText = "TypeError: Cannot read properties of undefined"
        status.activity[0].errorText = "kept by mistake for a call that worked"
        let activity = content(of: status).activity
        #expect(activity.keepsErrorText == true)
        #expect(activity.rows.map(\.failureDetail) == [nil, "TypeError: Cannot read properties of undefined", nil])
        // Without a status there is no switch to show: its value is unknown.
        #expect(ActivityContent.placeholder(isLoading: false).keepsErrorText == nil)
    }

    @Test func aRestartOfCodexCutsClaudesCUAOnlyWhileClaudeWorksThroughItsReadyHost() throws {
        var status = try Fixtures.status("status-ready")
        #expect(content(of: status).claudeWorksThroughCodex)
        status.host.state = .closed
        #expect(!content(of: status).claudeWorksThroughCodex, "no host: nothing of Claude's runs through Codex")
        status = try Fixtures.status("status-ready")
        status.connections.removeAll { $0.agent == .claude }
        #expect(!content(of: status).claudeWorksThroughCodex)
    }

    @Test func activityRowsKeepTheEnginesNewestFirstOrderAndHaveUniqueIDs() throws {
        var status = try Fixtures.status("status-problem")
        let entry = status.activity[0]
        status.activity = [entry, entry, entry]
        let rows = content(of: status).activity.rows
        #expect(Set(rows.map(\.id)).count == 3)
        #expect(content(of: try Fixtures.status("status-problem")).activity.rows.map(\.timeText) == ["11:59:30", "11:58:12", "09:02:00"])
    }

    @Test func anActivityRowOfAnotherDaySaysItsDay() throws {
        // The log holds 200 lines over days: yesterday's read as today's.
        var status = try Fixtures.status("status-problem")
        status.activity[0].at = Fixtures.now.addingTimeInterval(-86400 - 30)
        let rows = content(of: status).activity.rows
        #expect(rows[0].timeText == "10/17 11:59:30")
        #expect(rows[1].timeText == "11:58:12", "today's keep the time alone")
    }

    @Test func toolNamesAreShownInWordsAndUnknownOnesAsTheEngineWroteThem() {
        #expect(Format.tool("js") == "화면 조작")
        #expect(Format.tool("turn_ended") == "차례 끝 · 탭 풀기")
        #expect(Format.tool("js_reset") == "런타임 초기화")
        #expect(Format.tool("list_tabs") == "list_tabs")
        #expect(Format.tool(nil) == "—")
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
