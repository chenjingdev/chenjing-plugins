import Foundation
import Testing
@testable import cua_bar

struct ActionMessagesTests {
    // MARK: Reasons (contract: "Reasons the app must handle", and its later additions)

    static let reasons: [(String, String)] = [
        ("request_in_flight", "도구 호출이 아직 끝나지 않았어요"),
        ("not_found", "대상을 찾지 못했어요"),
        ("no_trusted_scope", "놓을 점유가 없어요"),
        ("cleanup_not_confirmed", "정리가 확인되지 않았어요"),
        ("relay_unavailable", "중계기를 쓸 수 없어요"),
        ("unsupported", "하나만 골라 풀 방법이 없어요. 브라우저 점유 탭의 안내를 보세요"),
        ("quit_cancelled", "Codex가 종료를 취소했어요"),
        ("not_running", "Codex가 켜져 있지 않아요"),
        ("relaunch_failed", "Codex를 다시 열지 못했어요"),
        ("timeout", "시간이 너무 오래 걸렸어요"),
        ("needs_user", "Codex 대화의 점유는 직접 눌러야 풀 수 있어요"),
        ("session_live", "살아 있는 연결이 아직 이 세션을 쓰고 있어요"),
        ("unattributed", "주인을 몰라 끄지 않았어요"),
        ("protected", "앱이 건드리지 않는 프로세스예요"),
        ("unverified", "프로세스가 바뀌었거나 확인되지 않아 건드리지 않았어요"),
        ("permission_denied", "종료할 권한이 없어요"),
    ]

    @Test(arguments: ActionMessagesTests.reasons)
    func everyContractReasonHasItsOwnPlainLine(reason: String, text: String) {
        #expect(ActionMessages.reason(reason) == text)
    }

    @Test func allSixteenReasonsAreDistinctAndNoneIsTheUnknownLine() {
        #expect(Self.reasons.count == 16)
        #expect(Set(Self.reasons.map(\.1)).count == 16)
        #expect(!Self.reasons.map { ActionMessages.reason($0.0) }.contains(ActionMessages.unknownReason))
    }

    @Test(arguments: [nil, "", "something_new", "TIMEOUT", "request in flight"])
    func unknownOrMissingReasonsAreShownAsNotConfirmed(raw: String?) {
        #expect(ActionMessages.reason(raw) == "확인되지 않음")
    }

    @Test func severalReasonsAreNamedOnceEachAndAtMostTwo() {
        #expect(ActionMessages.why([]) == "확인되지 않음")
        #expect(ActionMessages.why(["protected", "protected"]) == "앱이 건드리지 않는 프로세스예요")
        #expect(ActionMessages.why(["protected", nil, "protected"]) == "앱이 건드리지 않는 프로세스예요, 확인되지 않음")
        #expect(ActionMessages.why(["protected", "permission_denied", "timeout"]) == "앱이 건드리지 않는 프로세스예요, 종료할 권한이 없어요 외")
        #expect(ActionMessages.why(["a", "b"]) == "확인되지 않음", "unknown reasons collapse into one")
    }

    // MARK: Release one connection

    @Test func releasedConnection() {
        #expect(ActionMessages.releaseConnection(ReleaseResult(ok: true, released: true, reason: nil, scopeCount: 2))
                == ActionOutcome(kind: .success, message: "놓았어요"))
    }

    @Test func nothingToRelease() {
        #expect(ActionMessages.releaseConnection(ReleaseResult(ok: true, released: false, reason: "no_trusted_scope", scopeCount: 0))
                == ActionOutcome(kind: .info, message: "놓을 점유가 없어요"))
    }

    @Test func releaseRefusedBecauseACallIsStillRunning() {
        #expect(ActionMessages.releaseConnection(ReleaseResult(ok: false, released: false, reason: "request_in_flight", scopeCount: 0))
                == ActionOutcome(kind: .failure, message: "놓지 못했어요 — 도구 호출이 아직 끝나지 않았어요"))
    }

    @Test func releaseWithoutAReasonIsNotConfirmed() {
        #expect(ActionMessages.releaseConnection(ReleaseResult())
                == ActionOutcome(kind: .failure, message: "놓지 못했어요 — 확인되지 않음"))
    }

    // MARK: Release the ended ones (reads ok and every item)

    @Test func releasingTheEndedOnesReadsOkAndEachItem() {
        func ended(_ released: Bool, _ reason: String? = nil) -> EndedRelease { EndedRelease(connectionID: "x", released: released, reason: reason) }
        #expect(ActionMessages.releaseEnded(ReleaseEndedResult(ok: true, results: []))
                == ActionOutcome(kind: .info, message: "끝난 연결이 없어요"))
        #expect(ActionMessages.releaseEnded(ReleaseEndedResult(ok: true, results: [ended(true), ended(true)]))
                == ActionOutcome(kind: .success, message: "끝난 연결 2개를 놓았어요"))
        #expect(ActionMessages.releaseEnded(ReleaseEndedResult(ok: false, results: [ended(true), ended(true)]))
                == ActionOutcome(kind: .warning, message: "끝난 연결 2개를 놓았지만 마무리는 확인되지 않았어요"))
        #expect(ActionMessages.releaseEnded(ReleaseEndedResult(ok: false, results: [ended(true), ended(false, "request_in_flight")]))
                == ActionOutcome(kind: .warning, message: "끝난 연결 2개 중 1개를 놓았어요 — 나머지는 도구 호출이 아직 끝나지 않았어요"))
        #expect(ActionMessages.releaseEnded(ReleaseEndedResult(ok: false, results: [ended(false, "relay_unavailable")]))
                == ActionOutcome(kind: .failure, message: "끝난 연결 1개를 놓지 못했어요 — 중계기를 쓸 수 없어요"))
        #expect(ActionMessages.releaseEnded(ReleaseEndedResult(ok: false, results: [ended(false, "request_in_flight"), ended(false, "relay_unavailable")]))
                == ActionOutcome(kind: .failure, message: "끝난 연결 2개를 놓지 못했어요 — 도구 호출이 아직 끝나지 않았어요, 중계기를 쓸 수 없어요"))
    }

    @Test func anOkFalseAnswerWithNothingInItIsAFailureNeverNoEndedConnections() {
        #expect(ActionMessages.releaseEnded(ReleaseEndedResult(ok: false, results: []))
                == ActionOutcome(kind: .failure, message: "놓지 못했어요 — 확인되지 않음"))
        #expect(ActionMessages.releaseEnded(ReleaseEndedResult(ok: false, results: [], reason: "timeout"))
                == ActionOutcome(kind: .failure, message: "놓지 못했어요 — 시간이 너무 오래 걸렸어요"))
    }

    // MARK: Release by session id

    @Test func aReleasedSessionSaysHowManyTabsWhenTheEngineGaveANumber() {
        #expect(ActionMessages.releaseSession(SessionReleaseResult(ok: true, released: true, tabCount: 3))
                == ActionOutcome(kind: .success, message: "탭 3개를 놓았어요"))
        #expect(ActionMessages.releaseSession(SessionReleaseResult(ok: true, released: true, tabCount: 0))
                == ActionOutcome(kind: .success, message: "탭 0개를 놓았어요"))
        #expect(ActionMessages.releaseSession(SessionReleaseResult(ok: true, released: true, tabCount: nil))
                == ActionOutcome(kind: .success, message: "놓았어요"))
    }

    @Test func aSessionThatCouldNotBeReleasedGivesItsReason() {
        #expect(ActionMessages.releaseSession(SessionReleaseResult(ok: true, released: false, reason: "unsupported"))
                == ActionOutcome(kind: .failure, message: "풀지 못했어요 — 하나만 골라 풀 방법이 없어요. 브라우저 점유 탭의 안내를 보세요"))
        #expect(ActionMessages.releaseSession(SessionReleaseResult(ok: false, released: false, reason: "needs_user"))
                == ActionOutcome(kind: .failure, message: "풀지 못했어요 — Codex 대화의 점유는 직접 눌러야 풀 수 있어요"))
        #expect(ActionMessages.releaseSession(SessionReleaseResult(ok: false, released: false, reason: "session_live"))
                == ActionOutcome(kind: .failure, message: "풀지 못했어요 — 살아 있는 연결이 아직 이 세션을 쓰고 있어요"))
        #expect(ActionMessages.releaseSession(SessionReleaseResult())
                == ActionOutcome(kind: .failure, message: "풀지 못했어요 — 확인되지 않음"))
    }

    @Test func leftoverSessionsCountSessionsNeverLeases() {
        func done(_ tabs: Int? = nil) -> SessionReleaseResult { SessionReleaseResult(ok: true, released: true, tabCount: tabs) }
        func failed(_ reason: String) -> SessionReleaseResult { SessionReleaseResult(ok: true, released: false, reason: reason) }
        #expect(ActionMessages.releaseLeftovers([])
                == ActionOutcome(kind: .info, message: "Claude 대화의 점유 중 놓을 수 있는 것이 없어요"))
        #expect(ActionMessages.releaseLeftovers([done(), done()])
                == ActionOutcome(kind: .success, message: "남은 세션 2개의 점유를 놓았어요"))
        #expect(ActionMessages.releaseLeftovers([done(2), done(1)])
                == ActionOutcome(kind: .success, message: "남은 세션 2개의 점유를 놓았어요 (탭 3개)"))
        #expect(ActionMessages.releaseLeftovers([done(2), failed("cleanup_not_confirmed")])
                == ActionOutcome(kind: .warning, message: "남은 세션 2개 중 1개의 점유를 놓았어요 (탭 2개) — 나머지는 정리가 확인되지 않았어요"))
        #expect(ActionMessages.releaseLeftovers([failed("unsupported")])
                == ActionOutcome(kind: .failure, message: "남은 세션 1개의 점유를 놓지 못했어요 — 하나만 골라 풀 방법이 없어요. 브라우저 점유 탭의 안내를 보세요"))
    }

    // MARK: Stop one connection

    @Test func stopped() {
        #expect(ActionMessages.stopConnection(StopResult(ok: true, stopped: true, released: true), force: false)
                == ActionOutcome(kind: .success, message: "껐어요"))
        #expect(ActionMessages.stopConnection(StopResult(ok: true, stopped: true, released: true), force: true)
                == ActionOutcome(kind: .success, message: "강제로 껐어요"))
    }

    @Test func stoppedWithoutConfirmedCleanupPointsToTheLeases() {
        let result = StopResult(ok: true, stopped: true, released: false, reason: "cleanup_not_confirmed")
        #expect(ActionMessages.stopConnection(result, force: true)
                == ActionOutcome(kind: .warning, message: "강제로 껐지만 점유를 놓았는지는 확인되지 않았어요 — 브라우저 점유 탭을 보세요"))
    }

    @Test func aNormalStopIsNotBlockedByARefusedReleaseAndSaysWhatHappensNext() {
        let result = StopResult(ok: true, stopped: true, released: false, reason: "request_in_flight")
        #expect(ActionMessages.stopConnection(result, force: false)
                == ActionOutcome(kind: .warning, message: "껐어요. 도구 호출이 끝나지 않아 점유는 못 놓았어요 — 플러그인이 끝날 때 한 번 더 놓고, 남으면 브라우저 점유 탭에 보여요"))
    }

    @Test func stoppedButNotOkIsStillReportedAsStopped() {
        #expect(ActionMessages.stopConnection(StopResult(ok: false, stopped: true, released: true), force: false)
                == ActionOutcome(kind: .warning, message: "껐어요. 마무리는 확인되지 않았어요"))
    }

    @Test(arguments: ["request_in_flight", "protected", "unverified", "permission_denied", "unattributed", "not_found", nil])
    func notStoppedGivesTheReason(reason: String?) {
        let outcome = ActionMessages.stopConnection(StopResult(ok: false, stopped: false, released: false, reason: reason), force: false)
        #expect(outcome == ActionOutcome(kind: .failure, message: "끄지 못했어요 — \(ActionMessages.reason(reason))"))
    }

    // MARK: Group stop (reads ok and every item)

    private func entry(_ stopped: Bool, released: Bool = true, _ reason: String? = nil) -> GroupStopEntry {
        GroupStopEntry(connectionID: "x", stopped: stopped, released: released, reason: reason)
    }

    @Test func aCleanGroupStop() {
        let three = GroupStopResult(ok: true, stopped: 3, failed: 0, results: [entry(true), entry(true), entry(true)])
        #expect(ActionMessages.stopGroup(three, group: .all, force: false) == ActionOutcome(kind: .success, message: "연결 3개를 껐어요"))
        let claude = GroupStopResult(ok: true, stopped: 2, failed: 0, results: [entry(true), entry(true)])
        #expect(ActionMessages.stopGroup(claude, group: .claude, force: true)
                == ActionOutcome(kind: .success, message: "Claude 연결 2개를 강제로 껐어요"))
    }

    @Test func failuresAreCountedWithTheirReasons() {
        let result = GroupStopResult(ok: false, stopped: 2, failed: 2, results: [
            entry(true), entry(true), entry(false, released: false, "protected"), entry(false, released: false, "permission_denied"),
        ])
        #expect(ActionMessages.stopGroup(result, group: .all, force: false)
                == ActionOutcome(kind: .warning, message: "연결 2개를 껐어요 · 2개는 못 껐어요 — 앱이 건드리지 않는 프로세스예요, 종료할 권한이 없어요"))
    }

    @Test func unattributedConnectionsAreListedOnTheirOwn() {
        let result = GroupStopResult(ok: true, stopped: 1, failed: 0, results: [
            entry(true), entry(false, released: false, "unattributed"), entry(false, released: false, "unattributed"),
        ])
        #expect(ActionMessages.stopGroup(result, group: .codex, force: false)
                == ActionOutcome(kind: .warning, message: "Codex 연결 1개를 껐어요 · 주인을 몰라 끄지 않음 2개 — 하나씩 끄거나 전체로 끌 수 있어요"))
        let only = GroupStopResult(ok: true, stopped: 0, failed: 0, results: [entry(false, released: false, "unattributed")])
        #expect(ActionMessages.stopGroup(only, group: .codex, force: false)
                == ActionOutcome(kind: .warning, message: "주인을 몰라 끄지 않음 1개 — 하나씩 끄거나 전체로 끌 수 있어요"))
    }

    @Test func aStoppedConnectionWhoseTabsWereNotConfirmedReleasedIsMentioned() {
        let result = GroupStopResult(ok: true, stopped: 1, failed: 0, results: [entry(true, released: false, "cleanup_not_confirmed")])
        #expect(ActionMessages.stopGroup(result, group: .all, force: false)
                == ActionOutcome(kind: .warning, message: "연결 1개를 껐어요 · 점유를 놓았는지 확인되지 않은 연결 1개 — 브라우저 점유 탭을 보세요"))
    }

    @Test func aGroupStopThatStoppedNothingIsAFailureWithItsReason() {
        let result = GroupStopResult(ok: false, stopped: 0, failed: 2, results: [
            entry(false, released: false, "unverified"), entry(false, released: false, "unverified"),
        ])
        #expect(ActionMessages.stopGroup(result, group: .all, force: false)
                == ActionOutcome(kind: .failure, message: "연결 2개를 끄지 못했어요 — 프로세스가 바뀌었거나 확인되지 않아 건드리지 않았어요"))
    }

    @Test func anOkFalseAnswerWithNothingInItIsAFailureNeverNoConnectionsToStop() {
        #expect(ActionMessages.stopGroup(GroupStopResult(ok: false), group: .all, force: false)
                == ActionOutcome(kind: .failure, message: "끄지 못했어요 — 확인되지 않음"))
        #expect(ActionMessages.stopGroup(GroupStopResult(ok: false, reason: "not_running"), group: .all, force: false)
                == ActionOutcome(kind: .failure, message: "끄지 못했어요 — Codex가 켜져 있지 않아요"))
        #expect(ActionMessages.stopGroup(GroupStopResult(ok: true), group: .all, force: false)
                == ActionOutcome(kind: .info, message: "끌 연결이 없어요"))
    }

    @Test func anEngineThatOnlySendsCountsStillGetsHonestWords() {
        #expect(ActionMessages.stopGroup(GroupStopResult(ok: true, stopped: 3, failed: 0), group: .all, force: false)
                == ActionOutcome(kind: .success, message: "연결 3개를 껐어요"))
        #expect(ActionMessages.stopGroup(GroupStopResult(ok: false, stopped: 1, failed: 2), group: .codex, force: false)
                == ActionOutcome(kind: .warning, message: "Codex 연결 1개를 껐어요 · 2개는 못 껐어요 — 확인되지 않음"))
        #expect(ActionMessages.stopGroup(GroupStopResult(ok: false, stopped: 0, failed: 2), group: .all, force: false)
                == ActionOutcome(kind: .failure, message: "연결 2개를 끄지 못했어요 — 확인되지 않음"))
    }

    @Test func aCleanLookingResultThatIsNotOkSaysSo() {
        let result = GroupStopResult(ok: false, stopped: 1, failed: 0, results: [entry(true)])
        #expect(ActionMessages.stopGroup(result, group: .all, force: false)
                == ActionOutcome(kind: .warning, message: "연결 1개를 껐어요 · 마무리는 확인되지 않았어요"))
    }

    // MARK: Stop the ended ones

    @Test func stoppingTheEndedOnesOneByOne() {
        let ok = StopResult(ok: true, stopped: true, released: true)
        #expect(ActionMessages.stopEnded([ok, ok]) == ActionOutcome(kind: .success, message: "끝난 연결 2개를 껐어요"))
        let refused = StopResult(ok: false, stopped: false, released: false, reason: "protected")
        #expect(ActionMessages.stopEnded([ok, refused])
                == ActionOutcome(kind: .warning, message: "끝난 연결 1개를 껐어요 · 1개는 못 껐어요 — 앱이 건드리지 않는 프로세스예요"))
        #expect(ActionMessages.stopEnded([]) == ActionOutcome(kind: .info, message: "끌 연결이 없어요"))
    }

    // MARK: Restart Codex

    @Test func aRestartThatWorked() {
        #expect(ActionMessages.restartCodex(RestartResult(ok: true)) == ActionOutcome(kind: .success, message: "Codex를 다시 켰어요"))
    }

    @Test func aCancelledQuitEndsThereWithNothingMoreToDo() {
        let outcome = ActionMessages.restartCodex(RestartResult(ok: false, reason: "quit_cancelled"))
        #expect(outcome == ActionOutcome(kind: .info, message: "Codex가 종료를 취소했어요"))
        #expect(outcome.followUp == nil)
    }

    @Test func aFailedRelaunchOffersTheOneClickThatOpensCodex() {
        let outcome = ActionMessages.restartCodex(RestartResult(ok: false, reason: "relaunch_failed"))
        #expect(outcome.kind == .failure)
        #expect(outcome.message == "Codex를 껐지만 다시 열지 못했어요")
        #expect(outcome.followUp == ActionOutcome.FollowUp(title: "Codex 열기", action: .openCodex))
    }

    @Test func otherRestartFailuresGiveTheirReason() {
        #expect(ActionMessages.restartCodex(RestartResult(ok: false, reason: "not_running"))
                == ActionOutcome(kind: .failure, message: "Codex를 다시 켜지 못했어요 — Codex가 켜져 있지 않아요"))
        #expect(ActionMessages.restartCodex(RestartResult(ok: false, reason: "mystery"))
                == ActionOutcome(kind: .failure, message: "Codex를 다시 켜지 못했어요 — 확인되지 않음"))
    }

    // MARK: A command that could not run: one fixed line, never what it printed

    @Test func everyEngineErrorHasOneFixedLine() {
        #expect(EngineError.pluginMissing.message == "Claude 플러그인이 없어요")
        #expect(EngineError.setupNeeded(installPath: "/x").message == "연결 설정이 아직 안 됐어요")
        #expect(EngineError.timeout.message == "응답이 없어 기다리다 멈췄어요")
        #expect(EngineError.commandFailed(exitCode: 3, message: "boom").message == "명령이 오류로 끝났어요")
        #expect(EngineError.launchFailed("nope").message == "명령을 실행하지 못했어요")
        #expect(EngineError.invalidOutput("EngineStatus").message == "명령의 출력을 읽지 못했어요")
        #expect(EngineError.unsupportedSchema(2).message == "앱이 모르는 출력 판이에요")
    }

    @Test func whatTheCommandPrintedNeverReachesTheMessage() {
        let secret = "Traceback (most recent call last): File \"/Users/someone/secret/plugin.py\", line 9"
        let errors: [EngineError] = [
            .commandFailed(exitCode: 70, message: secret), .launchFailed(secret), .invalidOutput(secret),
            .setupNeeded(installPath: "/Users/someone/secret"),
        ]
        for error in errors {
            for lead in ["놓지 못했어요", "끄지 못했어요"] {
                let outcome = ActionMessages.failure(of: lead, error: error)
                #expect(outcome.kind == .failure)
                #expect(!outcome.message.contains("Traceback"))
                #expect(!outcome.message.contains("secret"))
                #expect(!outcome.message.contains("70"))
            }
        }
        #expect(ActionMessages.failure(of: "놓지 못했어요", error: .timeout)
                == ActionOutcome(kind: .failure, message: "놓지 못했어요 — 응답이 없어 기다리다 멈췄어요"))
    }

    @Test func onlyATimeoutCountsAsTheEnginesTimeoutReason() {
        #expect(EngineError.timeout.reasonCode == "timeout")
        #expect(EngineError.pluginMissing.reasonCode == nil)
        #expect(EngineError.commandFailed(exitCode: 1, message: "").reasonCode == nil)
    }
}
