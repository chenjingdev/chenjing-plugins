import Foundation
import Testing
@testable import cua_bar

struct ActionMessagesTests {
    // MARK: Reasons (contract: "Reasons the app must handle", and its later additions)

    static let reasons: [(String, String)] = [
        ("request_in_flight", "도구 호출이 아직 끝나지 않았어요"),
        ("not_found", "대상을 찾지 못했어요"),
        ("no_trusted_scope", "풀 점유가 없어요"),
        ("cleanup_not_confirmed", "정리가 확인되지 않았어요"),
        ("relay_unavailable", "중계기를 쓸 수 없어요"),
        ("unsupported", "하나만 골라 풀 방법이 없어요. 목록 맨 아래 안내를 보세요"),
        ("quit_cancelled", "Codex가 종료를 취소했어요"),
        ("quit_pending", "Codex가 아직 꺼지는 중이에요"),
        ("not_running", "Codex가 켜져 있지 않아요"),
        ("relaunch_failed", "Codex를 다시 열지 못했어요"),
        ("timeout", "시간이 너무 오래 걸렸어요"),
        ("needs_user", "Codex 대화의 점유는 직접 눌러야 풀 수 있어요"),
        ("session_live", "살아 있는 연결이 아직 이 세션을 쓰고 있어요"),
        ("unattributed", "주인을 몰라 건드리지 않았어요"),
        ("protected", "앱이 건드리지 않는 프로세스예요"),
        ("unverified", "프로세스가 바뀌었거나 확인되지 않아 건드리지 않았어요"),
        ("permission_denied", "종료할 권한이 없어요"),
    ]

    @Test(arguments: ActionMessagesTests.reasons)
    func everyContractReasonHasItsOwnPlainLine(reason: String, text: String) {
        #expect(ActionMessages.reason(reason) == text)
    }

    @Test func allSeventeenReasonsAreDistinctAndNoneIsTheUnknownLine() {
        #expect(Self.reasons.count == 17)
        #expect(Set(Self.reasons.map(\.1)).count == 17)
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

    // MARK: 탭 풀기 on one connection

    @Test func releasedConnection() {
        #expect(ActionMessages.releaseConnection(ReleaseResult(ok: true, released: true, reason: nil, scopeCount: 2))
                == ActionOutcome(kind: .success, message: "탭을 풀었어요"))
    }

    @Test func nothingToReleaseIsASuccess() {
        #expect(ActionMessages.releaseConnection(ReleaseResult(ok: true, released: false, reason: "no_trusted_scope", scopeCount: 0))
                == ActionOutcome(kind: .success, message: "풀 점유가 없어요"))
    }

    @Test func nobodyToAskIsNotNothingToRelease() {
        // `ok: false` with the same reason: there was no endpoint to ask, so the runtime may still hold tabs (P4).
        #expect(ActionMessages.releaseConnection(ReleaseResult(ok: false, released: false, reason: "no_trusted_scope", scopeCount: 0))
                == ActionOutcome(kind: .warning, message: "탭을 풀 길을 확인하지 못했어요"))
    }

    @Test func releaseRefusedBecauseACallIsStillRunning() {
        #expect(ActionMessages.releaseConnection(ReleaseResult(ok: false, released: false, reason: "request_in_flight", scopeCount: 0))
                == ActionOutcome(kind: .failure, message: "탭을 풀지 못했어요 — 도구 호출이 아직 끝나지 않았어요"))
    }

    @Test func releaseWithoutAReasonIsNotConfirmed() {
        #expect(ActionMessages.releaseConnection(ReleaseResult())
                == ActionOutcome(kind: .failure, message: "탭을 풀지 못했어요 — 확인되지 않음"))
    }

    // MARK: 탭 풀기 by session id

    @Test func aReleasedSessionSaysHowManyTabsWhenTheEngineGaveANumber() {
        #expect(ActionMessages.releaseSession(SessionReleaseResult(ok: true, released: true, tabCount: 3))
                == ActionOutcome(kind: .success, message: "탭 3개를 풀었어요"))
        #expect(ActionMessages.releaseSession(SessionReleaseResult(ok: true, released: true, tabCount: 0))
                == ActionOutcome(kind: .success, message: "탭 0개를 풀었어요"))
        #expect(ActionMessages.releaseSession(SessionReleaseResult(ok: true, released: true, tabCount: nil))
                == ActionOutcome(kind: .success, message: "탭을 풀었어요"))
    }

    @Test func aSessionThatCouldNotBeReleasedGivesItsReason() {
        #expect(ActionMessages.releaseSession(SessionReleaseResult(ok: true, released: false, reason: "unsupported"))
                == ActionOutcome(kind: .failure, message: "탭을 풀지 못했어요 — 하나만 골라 풀 방법이 없어요. 목록 맨 아래 안내를 보세요"))
        #expect(ActionMessages.releaseSession(SessionReleaseResult(ok: false, released: false, reason: "needs_user"))
                == ActionOutcome(kind: .failure, message: "탭을 풀지 못했어요 — Codex 대화의 점유는 직접 눌러야 풀 수 있어요"))
        #expect(ActionMessages.releaseSession(SessionReleaseResult(ok: false, released: false, reason: "session_live"))
                == ActionOutcome(kind: .failure, message: "탭을 풀지 못했어요 — 살아 있는 연결이 아직 이 세션을 쓰고 있어요"))
        #expect(ActionMessages.releaseSession(SessionReleaseResult())
                == ActionOutcome(kind: .failure, message: "탭을 풀지 못했어요 — 확인되지 않음"))
    }

    // MARK: 정리 (one connection)

    private func stopped(
        ok: Bool = true, released: Bool = true, reason: String? = nil, forced: Bool = false, releasesTabs: Bool = true
    ) -> TidyStep {
        TidyStep(stop: StopResult(ok: ok, stopped: true, released: released, reason: reason), forced: forced, releasesTabs: releasesTabs)
    }

    @Test func aCleanTidyIsOneShortLine() {
        #expect(ActionMessages.tidy(stopped()) == ActionOutcome(kind: .success, message: "정리했어요"))
    }

    @Test func aTidyThatHadToBeForcedSaysSo() {
        #expect(ActionMessages.tidy(stopped(forced: true))
                == ActionOutcome(kind: .success, message: "정리했어요 — 제때 안 꺼져서 강제로 껐어요"))
    }

    @Test func aTidyWithNothingToReleaseIsAPlainSuccess() {
        // P4: `released` stays literal, with `no_trusted_scope` when there was nothing to release.
        #expect(ActionMessages.tidy(stopped(released: false, reason: "no_trusted_scope"))
                == ActionOutcome(kind: .success, message: "정리했어요"))
    }

    @Test func aTidyWhoseTabsWereNotConfirmedReleasedPointsAtTheListNotAtAGoneTab() {
        let outcome = ActionMessages.tidy(stopped(released: false))
        #expect(outcome.kind == .warning)
        #expect(outcome.message == "정리했어요 — 탭을 풀었는지는 확인되지 않았어요. 남았으면 목록에 점유로 보여요")
        #expect(!outcome.message.contains("브라우저 점유 탭"))
        let inFlight = ActionMessages.tidy(stopped(released: false, reason: "request_in_flight"))
        #expect(inFlight.kind == .warning)
        #expect(inFlight.message == "정리했어요 — 도구 호출이 끝나지 않아 탭은 못 풀었어요. 플러그인이 끝날 때 한 번 더 풀고, 남으면 목록에 점유로 보여요")
        #expect(ActionMessages.tidy(stopped(ok: false))
                == ActionOutcome(kind: .warning, message: "정리했어요 — 마무리는 확인되지 않았어요"))
        // Forced and unconfirmed: both are said.
        #expect(ActionMessages.tidy(stopped(released: false, forced: true)).message
                == "정리했어요 — 제때 안 꺼져서 강제로 껐어요. 탭을 풀었는지는 확인되지 않았어요. 남았으면 목록에 점유로 보여요")
    }

    @Test func aCmuxConnectionHasNoReleaseStepSoItsStopIsAPlainOne() {
        // No release step exists for cmux-cua: `released: false` with no reason is a plain stop.
        #expect(ActionMessages.tidy(stopped(released: false, releasesTabs: false))
                == ActionOutcome(kind: .success, message: "정리했어요"))
        #expect(ActionMessages.tidy(stopped(ok: false, released: false, releasesTabs: false))
                == ActionOutcome(kind: .warning, message: "정리했어요 — 마무리는 확인되지 않았어요"))
    }

    @Test(arguments: ["request_in_flight", "protected", "unverified", "permission_denied", "unattributed", "not_found", "timeout", nil])
    func aTidyThatStoppedNothingGivesTheReason(reason: String?) {
        let step = TidyStep(stop: StopResult(ok: false, stopped: false, released: false, reason: reason), forced: false, releasesTabs: true)
        #expect(ActionMessages.tidy(step) == ActionOutcome(kind: .failure, message: "정리하지 못했어요 — \(ActionMessages.reason(reason))"))
    }

    @Test func whenTheAppMayOnlyReleaseItSaysItReleasedOnlyTheTabs() {
        let released = TidyStep(release: ReleaseResult(ok: true, released: true, reason: nil, scopeCount: 1))
        #expect(ActionMessages.tidy(released)
                == ActionOutcome(kind: .success, message: "탭만 풀었어요 — 이 연결은 앱이 끌 수 없어요"))
        let nothing = TidyStep(release: ReleaseResult(ok: true, released: false, reason: "no_trusted_scope", scopeCount: 0))
        #expect(nothing.kind == .tabsOnly, "nothing to release is not a failure")
        let refused = TidyStep(release: ReleaseResult(ok: false, released: false, reason: "request_in_flight", scopeCount: 0))
        #expect(ActionMessages.tidy(refused)
                == ActionOutcome(kind: .failure, message: "정리하지 못했어요 — 도구 호출이 아직 끝나지 않았어요"))
    }

    // MARK: 모두 정리 (reads every step)

    @Test func tidyAllCountsWhatWentAndSaysWhyTheRestDidNot() {
        let done = TidyStep(kind: .cleaned)
        let tabsOnly = TidyStep(kind: .tabsOnly)
        let failed = TidyStep.failed("protected")
        #expect(ActionMessages.tidyAll([done, done, done]) == ActionOutcome(kind: .success, message: "3개 정리했어요"))
        #expect(ActionMessages.tidyAll([done, tabsOnly]) == ActionOutcome(kind: .success, message: "2개 정리했어요"))
        #expect(ActionMessages.tidyAll([done, done, failed])
                == ActionOutcome(kind: .warning, message: "2개 정리, 1개는 못 했어요 — 앱이 건드리지 않는 프로세스예요"))
        #expect(ActionMessages.tidyAll([failed])
                == ActionOutcome(kind: .failure, message: "정리하지 못했어요 — 앱이 건드리지 않는 프로세스예요"))
        #expect(ActionMessages.tidyAll([failed, .failed("permission_denied"), .failed("protected")])
                == ActionOutcome(kind: .failure, message: "3개를 정리하지 못했어요 — 앱이 건드리지 않는 프로세스예요, 종료할 권한이 없어요"))
        #expect(ActionMessages.tidyAll([done, failed, .failed(nil)]).message
                == "1개 정리, 2개는 못 했어요 — 앱이 건드리지 않는 프로세스예요, 확인되지 않음")
        #expect(ActionMessages.tidyAll([]) == ActionOutcome(kind: .info, message: "정리할 것이 없어요"))
    }

    @Test func aLeftoverSessionStepIsCleanedOnlyWhenTheEngineReleasedIt() {
        #expect(TidyStep(session: SessionReleaseResult(ok: true, released: true, tabCount: 2)).kind == .cleaned)
        let notConfirmed = TidyStep(session: SessionReleaseResult(ok: true, released: false, reason: "cleanup_not_confirmed"))
        #expect(notConfirmed == TidyStep.failed("cleanup_not_confirmed"))
        #expect(TidyStep(session: SessionReleaseResult()) == TidyStep.failed(nil))
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

    @Test func aQuitStillUnderWaySaysTheAppWillOpenCodexOnceItIsOff() {
        let outcome = ActionMessages.restartCodex(RestartResult(ok: false, reason: "quit_pending"))
        #expect(outcome == ActionOutcome(kind: .info, message: "Codex가 아직 꺼지는 중이에요 — 꺼지면 다시 켤게요"))
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
            for lead in ["탭을 풀지 못했어요", "정리하지 못했어요"] {
                let outcome = ActionMessages.failure(of: lead, error: error)
                #expect(outcome.kind == .failure)
                #expect(!outcome.message.contains("Traceback"))
                #expect(!outcome.message.contains("secret"))
                #expect(!outcome.message.contains("70"))
            }
        }
        #expect(ActionMessages.failure(of: "정리하지 못했어요", error: .timeout)
                == ActionOutcome(kind: .failure, message: "정리하지 못했어요 — 응답이 없어 기다리다 멈췄어요"))
    }

    @Test func onlyATimeoutCountsAsTheEnginesTimeoutReason() {
        #expect(EngineError.timeout.reasonCode == "timeout")
        #expect(EngineError.pluginMissing.reasonCode == nil)
        #expect(EngineError.commandFailed(exitCode: 1, message: "").reasonCode == nil)
    }
}
