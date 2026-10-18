import SwiftUI

/// 연결: Claude and Codex connections with per-row buttons, and the group buttons underneath.
struct ConnectionsTabView: View {
    var content: ConnectionsContent
    @ObservedObject var model: CUABarViewModel

    var body: some View {
        VStack(spacing: 8) {
            if let empty = content.emptyText {
                EmptyLine(text: empty)
                Spacer(minLength: 0)
            } else {
                ScrollView {
                    VStack(spacing: 6) {
                        ForEach(content.groups) { group in
                            SectionHeader(text: group.title)
                            ForEach(group.rows) { row in
                                ConnectionRowView(row: row, waiting: model.isWaiting(onConnection: row.id)) { model.send($0) }
                            }
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
            GroupButtonsView(content: content, busy: model.inFlight.contains { $0.isWide }) { model.send($0) }
        }
    }
}

struct ConnectionRowView: View {
    var row: ConnectionRow
    var waiting: Bool
    var send: (CUAAction) -> Void

    var body: some View {
        RowCard(tint: row.state.kind == .ended ? .red : nil) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        AgentBadge(agent: row.agent)
                        Text(row.folder)
                            .font(Theme.titleFont)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .help(row.path ?? "작업 폴더를 알 수 없어요")
                    }
                    Text("\(row.startedText) · \(row.memoryText)")
                        .font(Theme.captionFont)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                VStack(alignment: .trailing, spacing: 6) {
                    HStack(spacing: 5) {
                        if row.isBusy { BusyMarker() }
                        StateChip(display: row.state)
                    }
                    HStack(spacing: 4) {
                        if waiting { ProgressView().controlSize(.small) }
                        RowButton(title: "놓아주기", isEnabled: row.canRelease && !waiting) { send(.releaseConnection(row.id)) }
                        RowButton(title: "끄기", isEnabled: row.canStop && !waiting) { send(.stopConnection(row.id, force: false)) }
                        RowButton(title: "강제 종료", role: .destructive, isEnabled: row.canStop && !waiting) {
                            send(.stopConnection(row.id, force: true))
                        }
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(row.agent.label) \(row.folder), \(row.state.text)")
    }
}

/// 전체 끄기 · Claude만 · Codex만 · 끝난 연결 놓아주기, each with how many it would touch.
struct GroupButtonsView: View {
    var content: ConnectionsContent
    var busy: Bool
    var send: (CUAAction) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("묶음 끄기")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                groupButton("전체 끄기", .all)
                groupButton("Claude만", .claude)
                groupButton("Codex만", .codex)
                Spacer(minLength: 0)
            }
            HStack(spacing: 6) {
                RowButton(title: "끝난 연결 놓아주기 \(content.endedCount)", isEnabled: content.endedCount > 0 && !busy) { send(.releaseEnded) }
                Spacer(minLength: 0)
            }
        }
        .padding(.top, 2)
    }

    private func groupButton(_ title: String, _ group: StopGroup) -> some View {
        let count = content.stopCounts.count(for: group)
        return RowButton(title: "\(title) \(count)", isEnabled: count > 0 && !busy) { send(.stopGroup(group, force: false)) }
    }
}
