import Foundation
import Testing
@testable import cua_bar

struct ActionMessagesTests {
    // MARK: Reasons (contract: "Reasons the app must handle")

    @Test(arguments: [
        ("request_in_flight", "도구 호출이 아직 끝나지 않았어요"),
        ("not_found", "대상을 찾지 못했어요"),
        ("no_trusted_scope", "놓을 점유가 없어요"),
        ("cleanup_not_confirmed", "정리가 확인되지 않았어요"),
        ("relay_unavailable", "중계기를 쓸 수 없어요"),
        ("unsupported", "하나만 골라 풀 방법이 없어요. 확장 초기화 안내를 보세요"),
        ("quit_cancelled", "Codex가 종료되지 않았어요 (종료를 취소했을 수 있어요)"),
        ("not_running", "켜져 있지 않아요"),
        ("relaunch_failed", "다시 열지 못했어요"),
        ("timeout", "시간이 너무 오래 걸렸어요"),
    ])
    func everyContractReasonHasPlainText(reason: String, text: String) {
        #expect(ActionMessages.reason(reason) == text)
    }

    @Test func unknownOrMissingReasonsAreShownAsNotConfirmed() {
        #expect(ActionMessages.reason("something_new") == "확인되지 않음")
        #expect(ActionMessages.reason(nil) == "확인되지 않음")
        #expect(ActionMessages.reason("") == "확인되지 않음")
    }

    // MARK: Release

    @Test func releasedConnection() {
        let outcome = ActionMessages.releaseConnection(ReleaseResult(ok: true, released: true, reason: nil, scopeCount: 2))
        #expect(outcome == ActionOutcome(kind: .success, message: "놓아줬어요"))
    }

    @Test func nothingToRelease() {
        let outcome = ActionMessages.releaseConnection(ReleaseResult(ok: true, released: false, reason: "no_trusted_scope", scopeCount: 0))
        #expect(outcome == ActionOutcome(kind: .info, message: "놓을 점유가 없어요"))
    }

    @Test func releaseRefusedBecauseACallIsStillRunning() {
        let outcome = ActionMessages.releaseConnection(ReleaseResult(ok: false, released: false, reason: "request_in_flight", scopeCount: 0))
        #expect(outcome == ActionOutcome(kind: .failure, message: "놓지 못했어요 — 도구 호출이 아직 끝나지 않았어요"))
    }

    @Test func releaseWithoutAReasonIsNotConfirmed() {
        let outcome = ActionMessages.releaseConnection(ReleaseResult())
        #expect(outcome == ActionOutcome(kind: .failure, message: "놓지 못했어요 — 확인되지 않음"))
    }

    @Test func endedReleaseCountsWhatWorked() {
        #expect(ActionMessages.releaseEnded(ReleaseEndedResult(ok: true, results: [])) == ActionOutcome(kind: .info, message: "끝난 연결이 없어요"))
        let all = ReleaseEndedResult(ok: true, results: [EndedRelease(connectionID: "a", released: true), EndedRelease(connectionID: "b", released: true)])
        #expect(ActionMessages.releaseEnded(all) == ActionOutcome(kind: .success, message: "끝난 연결 2개를 놓아줬어요"))
        let some = ReleaseEndedResult(ok: false, results: [
            EndedRelease(connectionID: "a", released: true),
            EndedRelease(connectionID: "b", released: false, reason: "request_in_flight"),
        ])
        #expect(ActionMessages.releaseEnded(some) == ActionOutcome(kind: .warning, message: "끝난 연결 2개 중 1개를 놓아줬어요 — 도구 호출이 아직 끝나지 않았어요"))
        let none = ReleaseEndedResult(ok: false, results: [EndedRelease(connectionID: "a", released: false, reason: "relay_unavailable")])
        #expect(ActionMessages.releaseEnded(none) == ActionOutcome(kind: .failure, message: "끝난 연결 1개를 놓지 못했어요 — 중계기를 쓸 수 없어요"))
    }

    @Test func sessionRelease() {
        #expect(ActionMessages.releaseSession(ReleaseResult(ok: true, released: true)) == ActionOutcome(kind: .success, message: "점유를 풀었어요"))
        let refused = ActionMessages.releaseSession(ReleaseResult(ok: true, released: false, reason: "unsupported"))
        #expect(refused == ActionOutcome(kind: .failure, message: "풀지 못했어요 — 하나만 골라 풀 방법이 없어요. 확장 초기화 안내를 보세요"))
    }

    // MARK: Stop

    @Test func stopped() {
        let normal = ActionMessages.stopConnection(StopResult(ok: true, stopped: true, released: true), force: false)
        #expect(normal == ActionOutcome(kind: .success, message: "껐어요"))
        let forced = ActionMessages.stopConnection(StopResult(ok: true, stopped: true, released: true), force: true)
        #expect(forced == ActionOutcome(kind: .success, message: "강제로 껐어요"))
    }

    @Test func stoppedWithoutConfirmedCleanupPointsToTheLeases() {
        let outcome = ActionMessages.stopConnection(StopResult(ok: true, stopped: true, released: false, reason: "cleanup_not_confirmed"), force: true)
        #expect(outcome == ActionOutcome(kind: .warning, message: "강제로 껐지만 점유를 놓았는지는 확인되지 않았어요 — 브라우저 점유 탭을 보세요"))
    }

    @Test func notStopped() {
        let outcome = ActionMessages.stopConnection(StopResult(ok: false, stopped: false, released: false, reason: "request_in_flight"), force: false)
        #expect(outcome == ActionOutcome(kind: .failure, message: "끄지 못했어요 — 도구 호출이 아직 끝나지 않았어요"))
    }

    @Test func groupStop() {
        #expect(ActionMessages.stopGroup(GroupStopResult(ok: true, stopped: 3, failed: 0), group: .all, force: false)
                == ActionOutcome(kind: .success, message: "연결 3개를 껐어요"))
        #expect(ActionMessages.stopGroup(GroupStopResult(ok: true, stopped: 2, failed: 0), group: .claude, force: true)
                == ActionOutcome(kind: .success, message: "Claude 연결 2개를 강제로 껐어요"))
        #expect(ActionMessages.stopGroup(GroupStopResult(ok: false, stopped: 1, failed: 2), group: .codex, force: false)
                == ActionOutcome(kind: .warning, message: "Codex 연결 1개를 껐고 2개는 못 껐어요"))
        #expect(ActionMessages.stopGroup(GroupStopResult(ok: false, stopped: 0, failed: 2), group: .all, force: false)
                == ActionOutcome(kind: .failure, message: "연결 2개를 모두 끄지 못했어요"))
        #expect(ActionMessages.stopGroup(GroupStopResult(ok: true, stopped: 0, failed: 0), group: .all, force: false)
                == ActionOutcome(kind: .info, message: "끌 연결이 없어요"))
    }

    // MARK: Restart, diagnosis, setup, errors

    @Test func restart() {
        #expect(ActionMessages.restartCodex(RestartResult(ok: true)) == ActionOutcome(kind: .success, message: "Codex를 다시 켰어요"))
        #expect(ActionMessages.restartCodex(RestartResult(ok: false, reason: "quit_cancelled"))
                == ActionOutcome(kind: .failure, message: "Codex를 다시 켜지 못했어요 — Codex가 종료되지 않았어요 (종료를 취소했을 수 있어요)"))
    }

    @Test func errorsThatStopAnActionAreFailures() {
        #expect(ActionMessages.failure(of: "놓지 못했어요", error: EngineError.timeout)
                == ActionOutcome(kind: .failure, message: "놓지 못했어요 — 응답이 없어 기다리다 멈췄어요"))
    }
}
