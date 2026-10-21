import Foundation

/// Why the engine could not give an answer at all. (An action that ran but did not succeed is
/// not an error: it comes back as a result with `ok == false` and a reason.)
enum EngineError: Error, Equatable, Sendable {
    /// Neither the `codex-cua` command nor an engine copy it was set up from is there.
    case engineMissing
    /// An engine copy is there but `codex-cua` has not been set up from it yet.
    case setupNeeded(installPath: String)
    case timeout
    case commandFailed(exitCode: Int32, message: String)
    case launchFailed(String)
    /// The command ran but printed something that is not the contract's JSON.
    case invalidOutput(String)
    /// The document's `schema_version` is newer than this app understands.
    case unsupportedSchema(Int)

    /// One fixed Korean line for the status card and for result banners. The cases that carry
    /// what the command printed (stderr can hold paths) never show it: the text stays in the value
    /// for whoever debugs, and the person always reads the same sentence.
    var message: String {
        switch self {
        case .engineMissing: "연결 엔진이 없어요"
        case .setupNeeded: "연결 설정이 아직 안 됐어요"
        case .timeout: "응답이 없어 기다리다 멈췄어요"
        case .commandFailed: "명령이 오류로 끝났어요"
        case .launchFailed: "명령을 실행하지 못했어요"
        case .invalidOutput: "명령의 출력을 읽지 못했어요"
        case .unsupportedSchema: "앱이 모르는 출력 판이에요"
        }
    }

    /// The engine's own reason word for a failure that is really "it took too long".
    var reasonCode: String? { self == .timeout ? "timeout" : nil }

    /// What the app's own install can repair: no engine, a command that cannot answer `status` (an old or
    /// broken one) or cannot even start (it lost its executable bit: the setup writes it again), or an answer
    /// from an engine this app cannot read. A timeout says nothing about the engine.
    var needsEngineInstall: Bool {
        switch self {
        case .engineMissing, .setupNeeded, .commandFailed, .launchFailed, .invalidOutput, .unsupportedSchema: true
        case .timeout: false
        }
    }
}
