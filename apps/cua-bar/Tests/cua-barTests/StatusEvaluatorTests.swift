import Foundation
import Testing
@testable import cua_bar

struct StatusEvaluatorTests {
    private let appVersion = "0.7.0"

    private func healthy() throws -> EngineStatus { try Fixtures.status("status-ready") }

    private func evaluate(_ status: EngineStatus, appVersion: String? = "0.7.0") -> StatusSummary {
        StatusEvaluator.evaluate(status, appVersion: appVersion)
    }

    // MARK: Icon state and tooltip

    @Test func readyShowsTheReadyIconAndCountsConnections() throws {
        let summary = evaluate(try healthy())
        #expect(summary.icon == .ready)
        #expect(summary.problem == nil)
        #expect(summary.tooltip == "CUA 준비됨 · Claude 1 · Codex 1")
        #expect(summary.stateLabel == "준비됨")
        #expect(summary.headline == "연결 Claude 1 · Codex 1")
        #expect(summary.nextStep == "없음")
        #expect(summary.accessibilityLabel == "CUA 준비됨")
        #expect(summary.fix == nil)
    }

    @Test func readyWithoutConnectionsSaysSo() throws {
        var status = try healthy()
        status.connections = []
        let summary = evaluate(status)
        #expect(summary.icon == .ready)
        #expect(summary.tooltip == "CUA 준비됨 · 연결 없음")
        #expect(summary.headline == "연결 없음")
    }

    @Test func codexBeingOffIsStillReadyBecauseClaudeStartsItOnDemand() throws {
        var status = try healthy()
        status.codex.running = false
        status.codex.pids = []
        status.host = HostInfo(state: .closed, since: nil)
        status.connections = []
        let summary = evaluate(status)
        #expect(summary.icon == .ready)
        #expect(summary.problem == nil)
        #expect(summary.nextStep == "없음 — Claude 대화를 열면 Codex가 뒤에서 켜져요")
    }

    @Test func aCodexFromBeforeTheUpdateIsStillReadyButTheCardSaysARestartAppliesTheSetup() throws {
        // S8: its connections were all unknown and could not be released, and nothing said why.
        var status = try healthy()
        status.host.startedBeforeSetup = true
        let summary = evaluate(status)
        #expect(summary.icon == .ready)
        #expect(summary.problem == nil, "nothing is broken: no alarm and no notification")
        #expect(summary.nextStep == "Codex를 다시 켜면 새 설정이 적용돼요")
        #expect(summary.warning == "갱신 전에 켜진 Codex라 그 연결은 상태를 모르거나 탭을 풀 수 없을 수 있어요")
        // A Codex that is no longer running needs no restart.
        status.codex.running = false
        status.codex.pids = []
        #expect(evaluate(status).warning == nil)
    }

    @Test func theRestartHintStaysWhileAnAIUsesTheScreen() throws {
        // S8: the card flipped between the hint and "없음" each time an AI used the screen.
        var status = try Fixtures.status("status-working")
        status.host.startedBeforeSetup = true
        let summary = evaluate(status)
        #expect(summary.icon == .working)
        #expect(summary.nextStep == "Codex를 다시 켜면 새 설정이 적용돼요")
        #expect(summary.warning == "갱신 전에 켜진 Codex라 그 연결은 상태를 모르거나 탭을 풀 수 없을 수 있어요")
        status.host.startedBeforeSetup = false
        #expect(evaluate(status).nextStep == "없음")
    }

    @Test func endedConnectionsAreNotCountedAsConnected() throws {
        let status = try Fixtures.status("status-problem")
        // 1 Claude alive, 1 Codex idle; the ended Claude one is a problem, not a connection.
        let alive = status.connections.filter { $0.state != .ended }
        #expect(alive.count == 2)
        var healthyStatus = try healthy()
        healthyStatus.connections = alive
        #expect(evaluate(healthyStatus).tooltip == "CUA 준비됨 · Claude 1 · Codex 1")
    }

    @Test func workingWhenTheEngineSaysSomeoneUsedTheScreenInTheLastTenSeconds() throws {
        let summary = evaluate(try Fixtures.status("status-working"))
        #expect(summary.icon == .working)
        #expect(summary.problem == nil)
        #expect(summary.tooltip == "CUA 작업 중 · Claude(dev/x)가 화면을 쓰는 중")
        #expect(summary.stateLabel == "작업 중")
        #expect(summary.headline == "Claude(dev/x)가 화면을 쓰는 중")
        #expect(summary.accessibilityLabel == "CUA 작업 중")
    }

    @Test func workingNamesTheAgentAloneWhenTheFolderIsUnknown() throws {
        var status = try Fixtures.status("status-working")
        status.connections[0].cwd = nil
        #expect(evaluate(status).tooltip == "CUA 작업 중 · Claude가 화면을 쓰는 중")
    }

    @Test func workingFallsBackToTheAgentInTheConnectionIdWhenTheConnectionIsGone() throws {
        var status = try Fixtures.status("status-working")
        status.connections = []
        status.screen.activeConnectionID = "codex-15888-1792319000"
        #expect(evaluate(status).tooltip == "CUA 작업 중 · Codex가 화면을 쓰는 중")
        status.screen.activeConnectionID = "weird"
        #expect(evaluate(status).tooltip == "CUA 작업 중 · AI가 화면을 쓰는 중")
    }

    @Test func aToolCallStillInFlightKeepsTheIconWorkingEvenAfterTenSeconds() throws {
        var status = try Fixtures.status("status-working")
        status.screen.activeConnectionID = nil
        status.connections[0].busy = true
        status.connections[0].idleSeconds = 40
        let summary = evaluate(status)
        #expect(summary.icon == .working)
        #expect(summary.tooltip == "CUA 작업 중 · Claude(dev/x)가 화면을 쓰는 중")
    }

    @Test func noRecentCallMeansReadyNotWorking() throws {
        var status = try Fixtures.status("status-working")
        status.screen.activeConnectionID = nil
        status.connections[0].busy = false
        #expect(evaluate(status).icon == .ready)
    }

    @Test func problemBeatsWorkingAndReady() throws {
        var status = try Fixtures.status("status-working")
        status.codex.installed = false
        let summary = evaluate(status)
        #expect(summary.icon == .problem)
        #expect(summary.tooltip == "CUA 문제 · Codex 앱이 없어요")
    }

    @Test func theProblemFixtureMatchesTheTooltipExample() throws {
        let summary = evaluate(try Fixtures.status("status-problem"))
        #expect(summary.icon == .problem)
        #expect(summary.tooltip == "CUA 문제 · Codex가 연결 없이 켜져 있어요")
        #expect(summary.stateLabel == "문제")
        #expect(summary.accessibilityLabel == "CUA 문제: Codex가 연결 없이 켜져 있어요")
    }

    @Test func theContractExampleIsAProblemBecauseOfTheLeftoverLease() throws {
        let summary = evaluate(try Fixtures.status("contract-example"))
        #expect(summary.icon == .problem)
        #expect(summary.problem?.kind == .leasesMaybeLeft)
    }

    @Test func iconsAreThreeDistinctStatesWithDistinctDescriptions() {
        #expect(IconState.allCases.count == 3)
        #expect(Set(IconState.allCases.map(\.accessibilityDescription)).count == 3)
    }

    // MARK: Every problem: next step, fix

    struct ProblemCase: Sendable, CustomTestStringConvertible {
        var name: String
        var kind: ProblemKind
        var title: String
        var nextStep: String
        var fix: CUAAction?
        var fixLabel: String?
        var warning: String? = nil
        var testDescription: String { name }
    }

    static let cases: [ProblemCase] = [
        ProblemCase(name: "codex_missing", kind: .codexMissing, title: "Codex 앱이 없어요",
             nextStep: "Codex 앱을 받아 설치해 주세요", fix: .openCodexDownload, fixLabel: "받는 곳 열기"),
        ProblemCase(name: "version_mismatch", kind: .versionMismatch, title: "앱과 플러그인 판이 달라요",
             nextStep: "앱 0.7.0 · 플러그인 0.6.0 — 맞는 판을 받아 주세요", fix: .matchPluginVersion, fixLabel: "맞는 판 받기"),
        ProblemCase(name: "setup_incomplete", kind: .setupIncomplete, title: "Codex 연결용 래퍼가 깨졌어요",
             nextStep: "고치기를 누르면 설정을 다시 맞춰요", fix: .runSetup, fixLabel: "고치기"),
        ProblemCase(name: "codex_without_host", kind: .codexWithoutHost, title: "Codex가 연결 없이 켜져 있어요",
             nextStep: "다시 켜면 Claude가 붙어요", fix: .restartCodex, fixLabel: "다시 켜기",
             warning: "하던 Codex 작업이 끊길 수 있어요"),
        // One line's problem: the card says what to do, the button is on that line.
        ProblemCase(name: "ended_connections", kind: .endedConnections, title: "끝난 연결이 1개 남아 있어요",
             nextStep: "목록 맨 위의 정리를 눌러 주세요", fix: nil, fixLabel: nil),
        ProblemCase(name: "leases_maybe_left", kind: .leasesMaybeLeft, title: "점유가 남았을 수 있어요",
             nextStep: "목록 맨 위의 탭 풀기를 눌러 주세요", fix: nil, fixLabel: nil),
    ]

    /// Builds a status in which exactly the problem of `kind` is present.
    private func status(causing kind: ProblemKind) throws -> EngineStatus {
        var status = try healthy()
        switch kind {
        case .codexMissing:
            status.codex = CodexInfo(installed: false, appPath: nil, appVersion: nil, running: false, pids: [])
        case .pluginMissing, .engineUnreadable:
            break
        case .versionMismatch:
            status.plugin.version = "0.6.0"
        case .setupIncomplete:
            status.setup.wrapper = "broken"
        case .codexWithoutHost:
            status.host.state = .closed
        case .endedConnections:
            status.connections[0].state = .ended
        case .leasesMaybeLeft:
            status.leases.maybeLeft = [LeftoverLease(sessionID: "019a-1", agent: .claude, connectionID: "claude-1-1", cwd: "/a/b", endedAt: Fixtures.now, releasable: true)]
        }
        return status
    }

    @Test(arguments: StatusEvaluatorTests.cases)
    func eachProblemHasItsLineAndItsFixButton(_ item: ProblemCase) throws {
        let summary = evaluate(try status(causing: item.kind))
        let problem = try #require(summary.problem)
        #expect(problem.kind == item.kind)
        #expect(problem.title == item.title)
        #expect(problem.nextStep == item.nextStep)
        #expect(problem.fix == item.fix)
        #expect(problem.fixLabel == item.fixLabel)
        #expect(problem.warning == item.warning)
        #expect(summary.icon == .problem)
        #expect(summary.stateLabel == "문제")
        #expect(summary.headline == item.title)
        #expect(summary.nextStep == item.nextStep)
        #expect(summary.fix == item.fix)
        #expect(summary.warning == item.warning)
        #expect(summary.tooltip == "CUA 문제 · \(item.title)")
    }

    // MARK: Priority: first match wins

    @Test func priorityOrderIsCodexPluginVersionSetupHostEndedLeases() throws {
        var status = try healthy()
        status.codex = CodexInfo(installed: false, appPath: nil, appVersion: nil, running: false, pids: [])
        status.plugin.version = "0.6.0"
        status.setup.wrapper = "broken"
        status.host.state = .closed
        status.connections[0].state = .ended
        status.leases.maybeLeft = [LeftoverLease(sessionID: "019a-1", agent: .claude, connectionID: nil, cwd: nil, endedAt: nil, releasable: true)]

        // codex_missing > version_mismatch > setup_incomplete > codex_without_host > ended_connections > leases_maybe_left
        #expect(evaluate(status).problem?.kind == .codexMissing)
        status.codex = CodexInfo(installed: true, appPath: "/Applications/ChatGPT.app", appVersion: "1", running: true, pids: [1])
        #expect(evaluate(status).problem?.kind == .versionMismatch)
        status.plugin.version = "0.7.0"
        #expect(evaluate(status).problem?.kind == .setupIncomplete)
        status.setup.wrapper = "ready"
        #expect(evaluate(status).problem?.kind == .codexWithoutHost)
        status.host.state = .ready
        #expect(evaluate(status).problem?.kind == .endedConnections)
        status.connections[0].state = .active
        #expect(evaluate(status).problem?.kind == .leasesMaybeLeft)
        status.leases.maybeLeft = []
        #expect(evaluate(status).problem == nil)
    }

    @Test func pluginMissingOutranksEverythingElseBecauseThereIsNoStatusToRead() {
        let summary = StatusEvaluator.summary(for: .pluginMissing)
        let problem = summary.problem
        #expect(problem?.kind == .pluginMissing)
        #expect(problem?.title == "Claude 플러그인이 없어요")
        #expect(problem?.nextStep == "Claude 플러그인을 설치해 주세요")
        #expect(problem?.fix == .installPlugin)
        #expect(problem?.fixLabel == "설치")
        #expect(summary.icon == .problem)
        #expect(summary.tooltip == "CUA 문제 · Claude 플러그인이 없어요")
    }

    @Test func codexMissingIsNotMaskedByTheMissingPluginRule() throws {
        // codex_missing is only decidable from a status document; it still comes first among those.
        var status = try healthy()
        status.codex.installed = false
        status.plugin.version = nil
        #expect(evaluate(status).problem?.kind == .codexMissing)
    }

    // MARK: Version

    @Test func versionMismatchNeedsBothVersionsToBeKnown() throws {
        var status = try healthy()
        status.plugin.version = "0.6.0"
        #expect(evaluate(status, appVersion: nil).problem == nil)
        status.plugin.version = nil
        #expect(evaluate(status, appVersion: "0.7.0").problem == nil)
        status.plugin.version = "0.7.0"
        #expect(evaluate(status, appVersion: "0.7.0").problem == nil)
        status.plugin.version = "0.8.0"
        #expect(evaluate(status, appVersion: "0.7.0").problem?.kind == .versionMismatch)
    }

    @Test func aNewerSchemaIsReportedAsAVersionProblemWithoutReadingTheRest() {
        let summary = StatusEvaluator.summary(for: .unsupportedSchema(2))
        #expect(summary.problem?.kind == .versionMismatch)
        #expect(summary.problem?.fix == .matchPluginVersion)
        #expect(summary.problem?.title == "앱이 이 플러그인 판을 읽지 못해요")
        #expect(summary.icon == .problem)
    }

    // MARK: Setup

    @Test(arguments: [
        ("command", "missing", "연결 명령이 없어요"),
        ("dependencies", "missing", "필요한 구성 요소가 없어요"),
        ("login_environment", "missing", "로그인 환경이 설정되지 않았어요"),
        ("login_environment", "stale", "로그인 환경이 옛 설정이에요"),
        ("login_environment", "conflict", "로그인 환경이 다른 설정과 겹쳐요"),
        ("wrapper", "missing", "Codex 연결용 래퍼가 없어요"),
        ("wrapper", "broken", "Codex 연결용 래퍼가 깨졌어요"),
        ("relay", "unavailable", "중계기를 쓸 수 없어요"),
    ])
    func everySetupFailureIsASetupProblemWithTheFixButton(field: String, value: String, title: String) throws {
        var status = try healthy()
        switch field {
        case "command": status.setup.command = value
        case "dependencies": status.setup.dependencies = value
        case "login_environment": status.setup.loginEnvironment = value
        case "wrapper": status.setup.wrapper = value
        default: status.setup.relay = value
        }
        let problem = try #require(evaluate(status).problem)
        #expect(problem.kind == .setupIncomplete)
        #expect(problem.title == title)
        #expect(problem.fix == .runSetup)
        #expect(problem.fixLabel == "고치기")
    }

    @Test(arguments: [
        ("login_environment", "unknown"),
        ("relay", "inactive"),
        ("relay", "active"),
        ("wrapper", "ready"),
        ("dependencies", "ready"),
    ])
    func setupStatesThatAreNotFailuresAreNotProblems(field: String, value: String) throws {
        var status = try healthy()
        switch field {
        case "login_environment": status.setup.loginEnvironment = value
        case "relay": status.setup.relay = value
        case "wrapper": status.setup.wrapper = value
        default: status.setup.dependencies = value
        }
        #expect(evaluate(status).problem == nil)
    }

    @Test func severalSetupFailuresAreNamedInOneLine() throws {
        var status = try healthy()
        status.setup.wrapper = "broken"
        status.setup.relay = "unavailable"
        let problem = try #require(evaluate(status).problem)
        #expect(problem.title == "연결 설정에 문제가 있어요 — 래퍼 · 중계기")
        #expect(problem.fix == .runSetup)
    }

    @Test func setupNeededBeforeAnyStatusExistsOffersTheSameFix() {
        let summary = StatusEvaluator.summary(for: .setupNeeded(installPath: "/x/cua/0.7.0"))
        #expect(summary.problem?.kind == .setupIncomplete)
        #expect(summary.problem?.title == "연결 설정이 아직 안 됐어요")
        #expect(summary.problem?.fix == .runSetup)
        #expect(summary.icon == .problem)
    }

    // MARK: Codex without host

    @Test(arguments: [
        (HostState.ready, false), (.starting, false), (.stopping, false),
        (.closed, true), (.missing, true), (.unknown("unknown"), true),
    ])
    func hostStatesThatLeaveARunningCodexWithoutAConnection(state: HostState, isProblem: Bool) throws {
        var status = try healthy()
        status.host.state = state
        #expect((evaluate(status).problem?.kind == .codexWithoutHost) == isProblem)
    }

    @Test func aStoppedCodexNeverNeedsARestart() throws {
        var status = try healthy()
        status.codex.running = false
        status.host.state = .missing
        #expect(evaluate(status).problem == nil)
    }

    // MARK: Ended and leftover: the card talks, the line has the button

    @Test func endedConnectionsAreCounted() throws {
        var status = try Fixtures.status("status-problem")
        status.host.state = .ready
        let problem = try #require(evaluate(status).problem)
        #expect(problem.kind == .endedConnections)
        #expect(problem.title == "끝난 연결이 1개 남아 있어요")
        status.connections[1].state = .ended
        #expect(evaluate(status).problem?.title == "끝난 연결이 2개 남아 있어요")
    }

    @Test func anEndedConnectionOrALeftoverStaysAProblemForTheIconButTheCardHasNoButton() throws {
        var ended = try healthy()
        ended.connections[0].state = .ended
        var left = try healthy()
        left.leases.maybeLeft = [LeftoverLease(sessionID: "019a-1", agent: .claude, connectionID: nil, cwd: nil, endedAt: nil, releasable: true)]
        for (status, kind) in [(ended, ProblemKind.endedConnections), (left, .leasesMaybeLeft)] {
            let summary = evaluate(status)
            #expect(summary.icon == .problem)
            #expect(summary.stateLabel == "문제")
            #expect(summary.problem?.kind == kind)
            #expect(summary.fix == nil)
            #expect(summary.fixLabel == nil)
            #expect(summary.problem?.fix == nil)
        }
    }

    @Test func onlyAProblemOfTheWholeAppHasAFixButton() throws {
        for kind in ProblemKind.allCases where kind != .pluginMissing && kind != .engineUnreadable {
            let problem = try #require(evaluate(try status(causing: kind)).problem)
            let wholeApp: Set<ProblemKind> = [.codexMissing, .versionMismatch, .setupIncomplete, .codexWithoutHost]
            #expect((problem.fix != nil) == wholeApp.contains(kind), "\(kind)")
            #expect((problem.fixLabel != nil) == (problem.fix != nil), "\(kind)")
        }
    }

    @Test func leftoverLeasesGetNoCountBecauseTheListCannotBeRead() throws {
        var status = try Fixtures.status("status-problem")
        status.host.state = .ready
        status.connections.removeAll { $0.state == .ended }
        let problem = try #require(evaluate(status).problem)
        #expect(problem.kind == .leasesMaybeLeft)
        #expect(problem.title == "점유가 남았을 수 있어요")
        #expect(problem.nextStep == "목록 맨 위의 탭 풀기를 눌러 주세요")
        #expect(problem.fix == nil)
    }

    @Test func leftoverLeasesNobodyCanReleaseOneByOneSendThePersonToTheGuidanceAtTheBottom() throws {
        var status = try healthy()
        status.leases.maybeLeft = [LeftoverLease(sessionID: nil, agent: .codex, connectionID: nil, cwd: nil, endedAt: nil, releasable: false)]
        let problem = try #require(evaluate(status).problem)
        #expect(problem.kind == .leasesMaybeLeft)
        #expect(problem.fix == nil)
        #expect(problem.fixLabel == nil)
        #expect(problem.nextStep == "하나씩 풀 방법이 없어요 — 목록 맨 아래 안내를 따라 주세요")
    }

    @Test func onlyCodexSessionsToAimAtSendThePersonToTheirRows() throws {
        var status = try healthy()
        status.leases.maybeLeft = [LeftoverLease(sessionID: "019a-codex", agent: .codex, connectionID: nil, cwd: nil, endedAt: nil, releasable: true)]
        let problem = try #require(evaluate(status).problem)
        // 모두 정리 never releases a Codex chat; its own row's 탭 풀기 does.
        #expect(problem.fix == nil)
        #expect(problem.nextStep == "목록 맨 위의 탭 풀기를 눌러 주세요")
        // A Claude session's line has 탭 풀기 too, and the card names the button the line has, not 정리.
        status.leases.maybeLeft.append(LeftoverLease(sessionID: "019a-claude", agent: .claude, connectionID: nil, cwd: nil, endedAt: nil, releasable: true))
        #expect(evaluate(status).problem?.nextStep == "목록 맨 위의 탭 풀기를 눌러 주세요")
    }

    @Test func endedConnectionsTheAppCannotTidyAreSaidSoOnTheCard() throws {
        var status = try healthy()
        status.connections[0].state = .ended
        status.connections[0].canRelease = false // a 0.5.0 bridge has no control socket: it can still be stopped
        #expect(try #require(evaluate(status).problem).nextStep == "목록 맨 위의 정리를 눌러 주세요")
        status.connections[0].canStop = false
        status.connections[0].canRelease = true // only its tabs can be released
        #expect(try #require(evaluate(status).problem).nextStep == "목록 맨 위의 정리를 눌러 주세요")
        // Nothing the app can do with any of them.
        status.connections[0].canRelease = false
        let problem = try #require(evaluate(status).problem)
        #expect(problem.kind == .endedConnections)
        #expect(problem.nextStep == "앱이 정리할 수 없는 연결이에요 — 목록에서 까닭을 보세요")
        #expect(problem.fix == nil)
        // One that can be tidied among them is enough to point at the list.
        status.connections[1].state = .ended
        #expect(try #require(evaluate(status).problem).nextStep == "목록 맨 위의 정리를 눌러 주세요")
    }

    @Test func onceTheTabsOfTheOnlyEndedConnectionsThatCannotBeStoppedAreReleasedTheCardSaysSoAndNotToTidyAgain() throws {
        var status = try healthy()
        status.connections[0].state = .ended
        status.connections[0].canStop = false // the app may only release it
        let id = status.connections[0].id
        // Not known to be released: 정리 is still the way, and the card never claims what it does not know.
        #expect(evaluate(status).problem?.nextStep == "목록 맨 위의 정리를 눌러 주세요")
        #expect(StatusEvaluator.evaluate(status, appVersion: "0.7.0", tabsReleased: ["claude-other"]).problem?.nextStep
                == "목록 맨 위의 정리를 눌러 주세요")
        // Known: that is all there is to say, and it is still a problem for the icon, with no button.
        let summary = StatusEvaluator.evaluate(status, appVersion: "0.7.0", tabsReleased: [id])
        #expect(summary.problem?.kind == .endedConnections)
        #expect(summary.problem?.title == "끝난 연결이 1개 남아 있어요")
        #expect(summary.problem?.nextStep == "앱이 끌 수 없는 끝난 연결이에요 — 탭은 풀었어요")
        #expect(summary.icon == .problem)
        #expect(summary.fix == nil)
        // A connection the app can stop, or one whose tabs are not yet released, keeps the card pointing at 정리.
        status.connections[1].state = .ended
        #expect(StatusEvaluator.evaluate(status, appVersion: "0.7.0", tabsReleased: [id]).problem?.nextStep == "목록 맨 위의 정리를 눌러 주세요")
        status.connections[1].canStop = false
        #expect(StatusEvaluator.evaluate(status, appVersion: "0.7.0", tabsReleased: [id]).problem?.nextStep == "목록 맨 위의 정리를 눌러 주세요")
        let both = status.connections.map(\.id)
        #expect(StatusEvaluator.evaluate(status, appVersion: "0.7.0", tabsReleased: Set(both)).problem?.nextStep
                == "앱이 끌 수 없는 끝난 연결이에요 — 탭은 풀었어요")
        // Nothing the app can do with it at all: it says that instead.
        status.connections[0].canRelease = false
        status.connections[1].canRelease = false
        #expect(StatusEvaluator.evaluate(status, appVersion: "0.7.0", tabsReleased: Set(both)).problem?.nextStep
                == "앱이 정리할 수 없는 연결이에요 — 목록에서 까닭을 보세요")
        // One whose tabs were released beside one the app can do nothing for: the card does not say the
        // second one's tabs were released, and each line says its own reason.
        status.connections[0].canRelease = true
        #expect(StatusEvaluator.evaluate(status, appVersion: "0.7.0", tabsReleased: Set(both)).problem?.nextStep
                == "앱이 정리할 수 없는 연결이에요 — 목록에서 까닭을 보세요")
    }

    @Test func noTooltipSaysCUATwice() throws {
        var summaries: [StatusSummary] = [StatusEvaluator.loading]
        for kind in ProblemKind.allCases where kind != .pluginMissing && kind != .engineUnreadable {
            summaries.append(evaluate(try status(causing: kind)))
        }
        for error in [EngineError.pluginMissing, .timeout, .setupNeeded(installPath: "/x"), .unsupportedSchema(2),
                      .commandFailed(exitCode: 1, message: "x"), .launchFailed("x"), .invalidOutput("x")] {
            summaries.append(StatusEvaluator.summary(for: error))
        }
        summaries.append(evaluate(try Fixtures.status("status-working")))
        summaries.append(evaluate(try healthy()))
        for summary in summaries {
            #expect(summary.tooltip.components(separatedBy: "CUA").count - 1 == 1, "\(summary.tooltip)")
            #expect(summary.accessibilityLabel.components(separatedBy: "CUA").count - 1 <= 1, "\(summary.accessibilityLabel)")
        }
    }

    // MARK: Unreadable engine and placeholder

    @Test func anUnreadableEngineIsAProblemWithARetryButton() {
        let summary = StatusEvaluator.summary(for: .timeout)
        #expect(summary.icon == .problem)
        #expect(summary.problem?.kind == .engineUnreadable)
        #expect(summary.problem?.title == "상태를 읽지 못했어요")
        #expect(summary.problem?.fix == .refresh)
        #expect(summary.problem?.fixLabel == "다시 읽기")
        #expect(summary.tooltip == "CUA 문제 · 상태를 읽지 못했어요")
    }

    @Test func beforeTheFirstAnswerTheSummaryIsAPlaceholder() {
        let summary = StatusEvaluator.loading
        #expect(summary.isPlaceholder)
        #expect(summary.tooltip == "CUA 확인 중…")
        #expect(summary.problem == nil)
        #expect(evaluate(EngineStatus()).isPlaceholder == false)
    }

    @Test func aStatusWithNothingInItIsReadyNotAProblem() {
        let summary = evaluate(EngineStatus())
        #expect(summary.icon == .ready)
        #expect(summary.problem == nil)
    }
}
