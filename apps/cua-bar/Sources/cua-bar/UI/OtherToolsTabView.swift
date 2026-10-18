import SwiftUI

/// 다른 도구: who is using the screen now, and the other tools that can (cmux-cua).
struct OtherToolsTabView: View {
    var content: OtherToolsContent

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
                                if let detail = tool.detail {
                                    Text(detail).font(Theme.captionFont).foregroundStyle(.secondary)
                                }
                                ForEach(Array(tool.clients.enumerated()), id: \.offset) { _, client in
                                    Text(client).font(Theme.bodyFont)
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
