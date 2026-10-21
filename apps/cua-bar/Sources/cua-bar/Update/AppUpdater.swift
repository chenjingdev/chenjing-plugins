import Foundation

/// An update that could not be made, kept so that the footer can say so, the copied diagnosis can tell it and the
/// 점검 tab can read it: the version, where it stopped, and when.
struct UpdateFailure: Equatable, Sendable {
    var version: VersionNumber
    var step: UpdateStep
    var at: Date

    /// The footer button: "새 버전 0.8.1".
    var buttonTitle: String { "새 버전 \(version)" }

    /// Its line in the copied diagnosis.
    var diagnosisLine: String { "업데이트 실패: 새 버전 \(version) — \(step.reason)" }
}

/// Keeps the app up to date by itself (F4): it asks the site for the newest version when the app starts and then once
/// a day, and when that is newer than this app it fetches it, checks it and replaces the running app with it (see
/// `UpdateInstaller`), and the app ends so that the new one starts.
///
/// - It does nothing for a build that cannot replace itself (`installer` is nil: it does not run from an app bundle, or it is
///   not the official build signed by the team's Developer ID, a local build signed ad hoc for one) or that has no version
///   of its own: no look, no button.
/// - It replaces only while nothing is in the way (`canReplaceNow`: the popover is closed and no tidy-up, setup or
///   removal runs). Otherwise the offer waits; `applyIfPossible()` is called after each status read, so the update
///   goes ahead within seconds of the moment the way is free.
/// - A failure, at any step, leaves the running app as it is. It is remembered (`failure`), which shows the footer's
///   새 버전 button that opens the download site, and told once per version through `onFailure`. It is tried again at
///   the next check and the next start.
/// - A look that failed (no network) changes nothing and says nothing.
@MainActor
final class AppUpdater: ObservableObject {
    static let interval: Duration = .seconds(24 * 60 * 60)

    /// The update that could not be made; nil when there is none. The footer shows its button while this is set.
    @Published private(set) var failure: UpdateFailure?

    /// Called with the version, once per version, the first time its update fails. Whoever owns notifications wires
    /// it; it can be set after the updater was made, as long as that is before `start()`.
    var onFailure: (@MainActor (String) -> Void)?

    /// Whether the app may replace itself at this moment. The app wires it to the model; until then nothing is replaced.
    var canReplaceNow: @MainActor () -> Bool = { false }

    private enum Key {
        static let version = "update.failedVersion"
        static let step = "update.failedStep"
        static let at = "update.failedAt"
        static let notified = "update.failureNotifiedVersion"
    }

    private let appVersion: VersionNumber?
    private let transport: any UpdateTransport
    private let installer: (any UpdateInstalling)?
    private let defaults: UserDefaults
    private let clock: @Sendable () -> Date
    private let sleep: @Sendable (Duration) async throws -> Void
    private let quit: @MainActor () -> Void
    private var loop: Task<Void, Never>?
    /// A newer version that is waiting for the way to be free.
    private var offer: UpdateOffer?
    private var installing = false

    init(
        appVersion: String?,
        transport: any UpdateTransport,
        installer: (any UpdateInstalling)?,
        defaults: UserDefaults = .standard,
        clock: @escaping @Sendable () -> Date = { Date() },
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        quit: @escaping @MainActor () -> Void
    ) {
        self.appVersion = VersionNumber(appVersion)
        self.transport = transport
        self.installer = installer
        self.defaults = defaults
        self.clock = clock
        self.sleep = sleep
        self.quit = quit
        // A build that does not update (development, a local build) shows no button, whatever an installed app left behind.
        failure = installer == nil ? nil : storedFailure()
    }

    /// The line the copied diagnosis adds while an update has failed.
    var diagnosisLine: String? { failure?.diagnosisLine }

    // MARK: Schedule

    /// Looks now, at start, and again a day after each look while the app runs.
    func start() {
        // Without a bundle to replace or a version to compare, there is nothing to look for.
        guard appVersion != nil, installer != nil, loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.check()
                do { try await self.sleep(Self.interval) } catch { return }
            }
        }
    }

    func stop() {
        loop?.cancel()
        loop = nil
    }

    // MARK: Looking

    /// Asks the site for the newest version and, when it is newer than this app, goes on to replace it (as soon as the
    /// way is free).
    func check() async {
        guard let appVersion, installer != nil else { return }
        let found: UpdateOffer
        do {
            found = try UpdateOffer.parse(try await transport.fetchVersionDocument())
        } catch let unusable as UpdateOffer.Unusable {
            // The site names a newer version in a way that cannot be used: the person can still get it there.
            offer = nil
            if let version = unusable.version, version > appVersion { fail(version, .offer) }
            return
        } catch {
            return
        }
        guard found.version > appVersion else {
            offer = nil
            forgetFailure()
            return
        }
        // A button for an older version than the newest would name the wrong one.
        if let failure, failure.version != found.version { forgetFailure() }
        offer = found
        await applyIfPossible()
    }

    /// Replaces the app with the newest version if one is waiting and the way is free. Cheap when nothing waits, which
    /// is almost always.
    func applyIfPossible() async {
        guard let waiting = offer, let installer, !installing, canReplaceNow() else { return }
        installing = true
        defer { installing = false }
        let result = await installer.install(waiting) { [weak self] in self?.canReplaceNow() ?? false }
        switch result {
        case .replaced:
            offer = nil
            forgetFailure()
            quit()
        case .deferred:
            // Tried again when the way is free.
            break
        case .failed(let step):
            // Tried again at the next check (and the next start), not at every status read.
            offer = nil
            fail(waiting.version, step)
        }
    }

    // MARK: The failure

    private func fail(_ version: VersionNumber, _ step: UpdateStep) {
        let record = UpdateFailure(version: version, step: step, at: clock())
        failure = record
        defaults.set(version.description, forKey: Key.version)
        defaults.set(step.rawValue, forKey: Key.step)
        defaults.set(record.at.timeIntervalSince1970, forKey: Key.at)
        let text = version.description
        guard defaults.string(forKey: Key.notified) != text else { return }
        defaults.set(text, forKey: Key.notified)
        onFailure?(text)
    }

    private func forgetFailure() {
        failure = nil
        for key in [Key.version, Key.step, Key.at] { defaults.removeObject(forKey: key) }
    }

    /// The failure of an earlier run, as long as its version is still newer than this app: the button is there at
    /// once, before the first look has an answer.
    private func storedFailure() -> UpdateFailure? {
        guard
            let appVersion,
            let text = defaults.string(forKey: Key.version), let version = VersionNumber(strict: text), version > appVersion,
            let stepName = defaults.string(forKey: Key.step), let step = UpdateStep(rawValue: stepName)
        else {
            for key in [Key.version, Key.step, Key.at] { defaults.removeObject(forKey: key) }
            return nil
        }
        let at = defaults.object(forKey: Key.at) == nil ? Date.distantPast : Date(timeIntervalSince1970: defaults.double(forKey: Key.at))
        return UpdateFailure(version: version, step: step, at: at)
    }
}
