import Foundation

/// Fetches the repository's release list. Injected, so tests never reach the network.
protocol ReleaseFetching: Sendable {
    func fetchReleaseList() async throws -> Data
}

enum ReleaseFetchError: Error, Equatable {
    case badResponse
}

/// The real fetch: one anonymous GET (no token, no cookies, no cache), ten seconds at most, with
/// a fixed `User-Agent` that says nothing about the person or the Mac.
struct GitHubReleaseFetcher: ReleaseFetching {
    static let userAgent = "CUABar-update-check"
    static let timeout: TimeInterval = 10
    /// More than any release list is long; anything larger is not one.
    static let sizeLimit = 8 * 1024 * 1024

    static func request() -> URLRequest {
        var request = URLRequest(url: ReleaseSource.listURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "GET"
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.httpShouldHandleCookies = false
        return request
    }

    func fetchReleaseList() async throws -> Data {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = Self.timeout
        configuration.timeoutIntervalForResource = Self.timeout
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.waitsForConnectivity = false
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(for: Self.request())
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, data.count <= Self.sizeLimit else {
            throw ReleaseFetchError.badResponse
        }
        return data
    }
}

/// Looks for a newer app release once a day (F7, R19).
///
/// It checks when the last successful check is a day old or more, at start and then again a day
/// after each check while the app runs. The time and the result are kept in `defaults`; a failed
/// check changes nothing and says nothing. `newRelease` is what the popover's footer button
/// shows: the stored result, when it is newer than the running app. Nothing is downloaded or
/// replaced; the button opens the release's page.
@MainActor
final class ReleaseChecker: ObservableObject {
    static let interval: Duration = .seconds(24 * 60 * 60)
    static let intervalSeconds: TimeInterval = 24 * 60 * 60

    enum Outcome: Equatable {
        /// The last check is younger than a day; this long is left.
        case skipped(remaining: TimeInterval)
        case checked
        case failed
    }

    /// The newest app release, when it is newer than this app.
    @Published private(set) var newRelease: ReleaseInfo?

    /// Called with the version, once per version, when a check finds a release newer than this
    /// app. The notification itself is wired by whoever owns notifications; it can be set after
    /// the checker was made, as long as that is before `start()`.
    var onNewVersion: (@MainActor (String) -> Void)?

    private enum Key {
        static let checkedAt = "update.checkedAt"
        static let version = "update.latestVersion"
        static let tag = "update.latestTag"
        static let url = "update.latestURL"
        static let notified = "update.notifiedVersion"
    }

    private let appVersion: VersionNumber?
    private let fetcher: any ReleaseFetching
    private let defaults: UserDefaults
    private let clock: @Sendable () -> Date
    private let sleep: @Sendable (Duration) async throws -> Void
    private var loop: Task<Void, Never>?

    init(
        appVersion: String?,
        fetcher: any ReleaseFetching,
        defaults: UserDefaults = .standard,
        clock: @escaping @Sendable () -> Date = { Date() },
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        onNewVersion: (@MainActor (String) -> Void)? = nil
    ) {
        self.onNewVersion = onNewVersion
        self.appVersion = VersionNumber(appVersion)
        self.fetcher = fetcher
        self.defaults = defaults
        self.clock = clock
        self.sleep = sleep
        newRelease = newer(than: storedRelease())
    }

    /// When the last successful check was made.
    var lastCheckedAt: Date? {
        defaults.object(forKey: Key.checkedAt) == nil ? nil : Date(timeIntervalSince1970: defaults.double(forKey: Key.checkedAt))
    }

    // MARK: Schedule

    func start() {
        // Without a version of its own the app has nothing to compare a release with: no request.
        guard appVersion != nil, loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let outcome = await self.checkIfDue()
                let wait: Duration
                switch outcome {
                case .skipped(let remaining): wait = .seconds(remaining)
                // A failed check waits a day like a good one: once a day is the promise.
                case .checked, .failed: wait = Self.interval
                }
                do { try await self.sleep(wait) } catch { return }
            }
        }
    }

    func stop() {
        loop?.cancel()
        loop = nil
    }

    /// Checks unless the last successful check is less than a day old. A last check in the
    /// future (the clock was set back) counts as due.
    @discardableResult
    func checkIfDue() async -> Outcome {
        if let last = lastCheckedAt {
            let age = clock().timeIntervalSince(last)
            if age >= 0, age < Self.intervalSeconds { return .skipped(remaining: Self.intervalSeconds - age) }
        }
        return await check()
    }

    /// Fetches and parses the list now. Any failure keeps what was stored.
    func check() async -> Outcome {
        let latest: ReleaseInfo?
        do {
            let data = try await fetcher.fetchReleaseList()
            latest = try ReleaseParser.latestAppRelease(in: data)
        } catch {
            return .failed
        }
        store(latest, at: clock())
        newRelease = newer(than: latest)
        notifyOncePerVersion()
        return .checked
    }

    // MARK: Stored result

    private func newer(than release: ReleaseInfo?) -> ReleaseInfo? {
        guard let release, let appVersion, release.version > appVersion else { return nil }
        return release
    }

    private func storedRelease() -> ReleaseInfo? {
        guard
            let text = defaults.string(forKey: Key.version), let version = VersionNumber(strict: text),
            let tag = defaults.string(forKey: Key.tag), let address = defaults.string(forKey: Key.url)
        else { return nil }
        return ReleaseInfo(version: version, tag: tag, url: ReleaseParser.pageURL(for: tag, given: address))
    }

    private func store(_ release: ReleaseInfo?, at date: Date) {
        defaults.set(date.timeIntervalSince1970, forKey: Key.checkedAt)
        if let release {
            defaults.set(release.version.description, forKey: Key.version)
            defaults.set(release.tag, forKey: Key.tag)
            defaults.set(release.url.absoluteString, forKey: Key.url)
        } else {
            for key in [Key.version, Key.tag, Key.url] { defaults.removeObject(forKey: key) }
        }
    }

    private func notifyOncePerVersion() {
        guard let release = newRelease, let onNewVersion else { return }
        let version = release.version.description
        guard defaults.string(forKey: Key.notified) != version else { return }
        defaults.set(version, forKey: Key.notified)
        onNewVersion(version)
    }
}
