import Foundation

/// What 정리 and 모두 정리 can do, decided from what the status lists. One place, so the buttons,
/// the status card and the view model agree on what can be tidied (F3, R17).
enum TidyPlan {
    /// How the app tidies one connection.
    enum Way: Equatable, Sendable {
        /// `stop --connection`: the engine releases the tabs first, then stops what is left. A stop
        /// that runs out of time is repeated at once with `--force`.
        case stop
        /// `release --connection` only: the engine will not let the app stop this one.
        case releaseOnly
    }

    /// One thing 모두 정리 does.
    enum Item: Equatable, Sendable {
        case connection(String, Way)
        /// A leftover lease of a Claude conversation, released by session id without `--user`.
        case session(String)
    }

    /// How an ended connection is tidied; nil when the app can neither stop nor release it.
    static func way(for connection: Connection) -> Way? {
        guard connection.state == .ended else { return nil }
        if connection.canStop { return .stop }
        return connection.canRelease ? .releaseOnly : nil
    }

    /// An ended connection the app may only release, and whose tabs it already released in this run:
    /// there is nothing left for it to do with it, and 정리 would only say the same again.
    static func isSettled(_ connection: Connection, tabsReleased: Set<String>) -> Bool {
        way(for: connection) == .releaseOnly && tabsReleased.contains(connection.id)
    }

    /// How a cmux-cua connection is tidied. Only one nobody owns any more (its AI client is gone) and
    /// that the engine named and may stop: a live one is cut off from its conversation (R17).
    static func way(for client: ToolClient) -> Way? {
        guard client.isOrphan, client.canStop, let id = client.id, ToolClient.isCmuxConnection(id: id) else { return nil }
        return .stop
    }

    /// The ended connections, newest first.
    static func endedConnections(in status: EngineStatus) -> [Connection] {
        status.connections.filter { $0.state == .ended }.sorted(by: newestFirst)
    }

    /// Newest first, the ones without a start time last; a stable order so rows do not jump.
    static func newestFirst(_ left: Connection, _ right: Connection) -> Bool {
        switch (left.startedAt, right.startedAt) {
        case let (a?, b?) where a != b: return a > b
        case (_?, nil): return true
        case (nil, _?): return false
        default: return left.id < right.id
        }
    }

    /// Whether the line of a connection has a button to press: 정리 on an ended connection the app can tidy, 탭 풀기
    /// on a live one that can release. The other has its button off, and no way to press.
    static func hasButton(_ connection: Connection) -> Bool {
        connection.state == .ended ? way(for: connection) != nil : connection.canRelease
    }

    /// The connections of the list that hold the session of this leftover lease now. A lease that cannot be aimed
    /// at by its id (not `releasable`) is held by a connection of the list: the lease is its to let go of.
    static func holders(of lease: LeftoverLease, in status: EngineStatus) -> [Connection] {
        guard !lease.releasable, let session = lease.sessionID else { return [] }
        return status.connections.filter { $0.sessionID == session }
    }

    /// The line to press instead of this leftover lease's own, if there is one: the connection that holds its session
    /// and has a button. For an ended connection that is 정리, for a live one 탭 풀기; either lets go of the session.
    /// The lease is then no thing of its own: a second line for the same session would count it twice and send the
    /// person to the extension reset (S16), when the line to press is another one, and a light one.
    /// A holder without a button is no way: the lease keeps its line, with the advice to reset the extension, which
    /// is all that is left for it. A live holder is preferred to an ended one.
    static func lineToPress(for lease: LeftoverLease, in status: EngineStatus) -> Connection? {
        let pressable = holders(of: lease, in: status).filter(hasButton)
        return pressable.first { $0.state != .ended } ?? pressable.sorted(by: newestFirst).first
    }

    /// Whether a connection that is not over holds the session of this leftover lease. Its owner is there, so
    /// nothing was left behind by one that is gone: the lease is no news for a notification.
    static func ownerIsAlive(for lease: LeftoverLease, in status: EngineStatus) -> Bool {
        holders(of: lease, in: status).contains { $0.state != .ended }
    }

    /// The leftover leases of Claude conversations the engine can aim at. A Codex chat's lease is
    /// not here: a Codex chat can be resumed after a restart, so only a click on its own row
    /// releases it.
    static func claudeSessions(in status: EngineStatus) -> [String] {
        var seen: Set<String> = []
        return status.leases.maybeLeft
            .filter { $0.agent == .claude && $0.releasable }
            .compactMap(\.sessionID)
            .filter { seen.insert($0).inserted }
    }

    /// What 모두 정리 does, in the order the list shows it: the ended connections (newest first),
    /// the leftover Claude sessions, the cmux-cua connections nobody owns. Nothing else, and nothing
    /// that is settled.
    static func items(in status: EngineStatus?, tabsReleased: Set<String> = []) -> [Item] {
        guard let status else { return [] }
        let connections = endedConnections(in: status).compactMap { connection -> Item? in
            guard !isSettled(connection, tabsReleased: tabsReleased) else { return nil }
            return way(for: connection).map { Item.connection(connection.id, $0) }
        }
        let orphans = status.otherTools.flatMap(\.clients).compactMap { client in
            way(for: client).flatMap { way in client.id.map { Item.connection($0, way) } }
        }
        return connections + claudeSessions(in: status).map(Item.session) + orphans
    }
}
