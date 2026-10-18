import SwiftUI

/// 기록: the engine's recent calls (time, agent, folder, tool, result, duration) and 진단 복사.
struct ActivityTabView: View {
    var content: ActivityContent
    var copying: Bool
    var copy: () -> Void

    var body: some View {
        VStack(spacing: 6) {
            HStack {
                Text(content.rows.isEmpty ? "최근 조작" : "최근 조작 \(content.rows.count)개")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if copying { ProgressView().controlSize(.small) }
                RowButton(title: "진단 복사", isEnabled: !copying, action: copy)
            }
            if let empty = content.emptyText {
                EmptyLine(text: empty)
                Spacer(minLength: 0)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(content.rows) { row in
                            ActivityRowView(row: row)
                            Divider().opacity(0.5)
                        }
                    }
                }
            }
        }
    }
}

struct ActivityRowView: View {
    var row: ActivityRow

    private var result: (symbol: String, color: Color, label: String) {
        switch row.ok {
        case true?: ("checkmark.circle.fill", .green, "성공")
        case false?: ("xmark.circle.fill", .red, "실패")
        case nil: ("questionmark.circle", .secondary, "결과 알 수 없음")
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: result.symbol)
                .font(.system(size: 12))
                .foregroundStyle(result.color)
                .frame(width: 16)
                .padding(.top, 1)
                .accessibilityLabel(result.label)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(row.tool).font(.system(size: 12, weight: .medium)).lineLimit(1).truncationMode(.tail)
                    Spacer(minLength: 4)
                    Text(row.durationText)
                        .font(.system(size: 11).monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Text("\(row.timeText) · \(row.agent.label) · \(row.folder)")
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .padding(.vertical, 5)
        .padding(.horizontal, 2)
        .accessibilityElement(children: .combine)
    }
}
