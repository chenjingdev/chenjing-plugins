import SwiftUI

/// 다른 도구: who is using the screen now, and the other tools that can (cmux-cua), each client on
/// its own line with its own 끄기 (R17: one at a time, never in a group).
struct OtherToolsTabView: View {
    var content: OtherToolsContent
    @ObservedObject var model: CUABarViewModel

    var body: some View {
        ScrollView {
            VStack(spacing: 6) {
                SectionHeader(text: "지금 화면을 쓰는 연결")
                RowCard(tint: content.screen.isActive ? .blue : nil) {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: content.screen.isActive ? "cursorarrow.motionlines" : "cursorarrow")
                            .font(.system(size: 13))
                            .foregroundStyle(content.screen.isActive ? Color.blue : Color.secondary)
                            .frame(width: 18)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(content.screen.text).font(Theme.titleFont).fixedSize(horizontal: false, vertical: true)
                            if let detail = content.screen.detail {
                                Text(detail).font(Theme.captionFont).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                SectionHeader(text: "다른 도구")
                if let empty = content.emptyText {
                    EmptyLine(text: empty)
                } else {
                    ForEach(content.tools) { tool in
                        RowCard {
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(tool.name).font(Theme.titleFont)
                                    Spacer(minLength: 4)
                                    StateChip(display: StateDisplay(kind: tool.isRunning ? .inUse : .unknown, text: tool.statusText))
                                }
                                // The tool's own processes: text only, the daemon has no button.
                                if let detail = tool.detail {
                                    Text(detail).font(Theme.captionFont).foregroundStyle(.secondary)
                                }
                                ForEach(tool.clients) { client in
                                    Divider().padding(.vertical, 2)
                                    ToolClientRowView(
                                        row: client,
                                        timedOut: client.connectionID.map(model.stopTimedOutIDs.contains) ?? false,
                                        // Only its own stop: a group stop or a Codex restart never touches it.
                                        waiting: client.connectionID.map { id in model.inFlight.contains { $0.connectionID == id } } ?? false
                                    ) { model.send($0) }
                                }
                            }
                        }
                    }
                }
            }
            .padding(.vertical, 2)
        }
    }
}

/// One client of a tool: who holds it and since when, with 끄기 (and 강제 종료 after a timeout).
struct ToolClientRowView: View {
    var row: ToolClientRow
    /// Its normal stop ran out of time: the row says so and offers 강제 종료 too.
    var timedOut: Bool
    var waiting: Bool
    var send: (CUAAction) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .font(Theme.bodyFont)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(row.isOrphan ? "이 연결을 띄운 AI 클라이언트가 사라졌어요" : row.path ?? "작업 폴더를 알 수 없어요")
                Text(row.startedText)
                    .font(Theme.captionFont)
                    .foregroundStyle(.secondary)
                if timedOut {
                    Label(ToolClientRow.timedOutNote, systemImage: "hourglass")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Theme.orangeText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 4)
            HStack(spacing: 4) {
                if waiting { ProgressView().controlSize(.small) }
                ForEach(timedOut ? row.timedOutButtons : row.buttons) { SpecButton(spec: $0, waiting: waiting, send: send) }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(row.title), \(row.startedText)")
    }
}
