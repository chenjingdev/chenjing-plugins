import Foundation

/// Asking the site and taking a file from it. Injected, so tests never reach the network.
protocol UpdateTransport: Sendable {
    /// What `https://cua.chenjing.org/version` answered.
    func fetchVersionDocument() async throws -> Data
    /// Saves the offer's disk image at `destination`. Throws unless the whole file arrived from the site: a
    /// status other than 200, a redirect away from the site and more bytes than the offer's size all fail.
    func download(_ offer: UpdateOffer, to destination: URL) async throws
}

enum UpdateTransportError: Error, Equatable {
    case badResponse
    case tooLarge
}

/// The real transport: anonymous GETs (no token, no cookies, no cache) with a fixed `User-Agent` that says
/// nothing about the person or the Mac. A redirect to anywhere but the site is refused.
struct SiteUpdateTransport: UpdateTransport {
    static let userAgent = "CUABar-update-check"
    /// The small document.
    static let versionTimeout: TimeInterval = 10
    /// How long a download may be silent, and how long all of it may take.
    static let idleTimeout: TimeInterval = 30
    static let downloadTimeout: TimeInterval = 15 * 60

    static func versionRequest() -> URLRequest {
        request(UpdateSource.versionURL, timeout: versionTimeout, accept: "application/json")
    }

    static func fileRequest(for offer: UpdateOffer) -> URLRequest {
        // No compression: the bytes counted are the bytes of the file the checksum is about.
        var request = request(offer.url, timeout: idleTimeout, accept: "application/octet-stream")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        return request
    }

    private static func request(_ url: URL, timeout: TimeInterval, accept: String) -> URLRequest {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "GET"
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue(accept, forHTTPHeaderField: "Accept")
        request.httpShouldHandleCookies = false
        return request
    }

    private static func session(idle: TimeInterval, total: TimeInterval) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = idle
        configuration.timeoutIntervalForResource = total
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }

    /// Only an https address on the site is followed.
    static func isOnTheSite(_ url: URL?) -> Bool {
        url?.scheme == "https" && url?.host == UpdateSource.site.host && url?.port == nil
    }

    func fetchVersionDocument() async throws -> Data {
        let session = Self.session(idle: Self.versionTimeout, total: Self.versionTimeout)
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(for: Self.versionRequest(), delegate: StayOnTheSite())
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, data.count <= UpdateSource.versionDocumentLimit else {
            throw UpdateTransportError.badResponse
        }
        return data
    }

    func download(_ offer: UpdateOffer, to destination: URL) async throws {
        let session = Self.session(idle: Self.idleTimeout, total: Self.downloadTimeout)
        defer { session.finishTasksAndInvalidate() }
        let (bytes, response) = try await session.bytes(for: Self.fileRequest(for: offer), delegate: StayOnTheSite())
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw UpdateTransportError.badResponse }
        guard FileManager.default.createFile(atPath: destination.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
            throw UpdateTransportError.badResponse
        }
        let handle = try FileHandle(forWritingTo: destination)
        defer { try? handle.close() }
        var buffer: [UInt8] = []
        buffer.reserveCapacity(1 << 16)
        var total = 0
        for try await byte in bytes {
            total += 1
            // Never more than the offer says: a site that lies about the size cannot fill the disk.
            if total > offer.size { throw UpdateTransportError.tooLarge }
            buffer.append(byte)
            if buffer.count == 1 << 16 {
                try handle.write(contentsOf: buffer)
                buffer.removeAll(keepingCapacity: true)
            }
        }
        if !buffer.isEmpty { try handle.write(contentsOf: buffer) }
    }
}

/// Refuses a redirect that leaves the site: the file comes from there or not at all.
private final class StayOnTheSite: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        SiteUpdateTransport.isOnTheSite(request.url) ? request : nil
    }
}
