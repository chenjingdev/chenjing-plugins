import SwiftUI

/// 브라우저 점유: what Chrome may still be holding, with 콕 집어 풀기 when a session can be
/// aimed at, and the extension reset to fall back on.
struct LeasesTabView: View {
    var content: LeasesContent
    var failedSessionIDs: Set<String>
    @ObservedObject var model: CUABarViewModel

    var body: some View {
        ScrollView {
            VStack(spacing: 6) {
                if let notice = content.notice {
                    Label(notice, systemImage: "info.circle")
                        .font(Theme.captionFont)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let empty = content.emptyText {
                    EmptyLine(text: empty)
                } else {
                    ForEach(content.rows) { row in
                        LeaseRowView(row: row, failed: row.sessionID.map(failedSessionIDs.contains) ?? false,
                                     waiting: row.sessionID.map { model.inFlight.contains(.releaseSession($0)) } ?? false) {
                            model.send($0)
                        }
                    }
                }
                GuidanceView(
                    guidance: content.guidance,
                    isOpen: Binding(
                        get: { model.guidanceOpenByUser ?? (content.guidance.needsAttention || !failedSessionIDs.isEmpty) },
                        set: { model.guidanceOpenByUser = $0 }))
            }
            .padding(.vertical, 2)
        }
    }
}

struct LeaseRowView: View {
    var row: LeaseRow
    var failed: Bool
    var waiting: Bool
    var send: (CUAAction) -> Void

    var body: some View {
        RowCard(tint: row.kind == .maybeLeft ? .orange : nil) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: row.kind == .maybeLeft ? "exclamationmark.triangle.fill" : "lock.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(row.kind == .maybeLeft ? Color.orange : Color.secondary)
                    .frame(width: 16)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        AgentBadge(agent: row.agent)
                        Text(row.folder).font(Theme.titleFont).lineLimit(1).truncationMode(.middle)
                    }
                    Text(row.statusText).font(Theme.bodyFont)
                    if let detail = row.detail {
                        Text(detail).font(Theme.captionFont).foregroundStyle(.secondary).lineLimit(1)
                    }
                    if failed {
                        Text("콕 집어 풀기가 안 됐어요. 아래 확장 초기화를 보세요")
                            .font(Theme.captionFont)
                            .foregroundStyle(Theme.redText)
                            .fixedSize(horizontal: false, vertical: true)
                    } else if let hint = row.hint {
                        Text(hint).font(Theme.captionFont).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 4)
                if row.canReleaseSession, let session = row.sessionID {
                    HStack(spacing: 4) {
                        if waiting { ProgressView().controlSize(.small) }
                        RowButton(title: "콕 집어 풀기", isEnabled: !waiting) { send(.releaseSession(session)) }
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
    }
}

/// How to reset the Chrome extension, and who that would cut off. Open on its own when a
/// leftover cannot be released one by one.
struct GuidanceView: View {
    var guidance: ExtensionResetGuidance
    @Binding var isOpen: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                isOpen.toggle()
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: isOpen ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .bold))
                        .frame(width: 10)
                    Text(guidance.title).font(.system(size: 12, weight: .semibold))
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(isOpen ? "펼침" : "접힘")

            if isOpen {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(Array(guidance.steps.enumerated()), id: \.offset) { index, step in
                        Text("\(index + 1). \(step)").font(Theme.bodyFont).fixedSize(horizontal: false, vertical: true)
                    }
                    Label(guidance.warning, systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.orangeText)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(guidance.liveConnectionsTitle)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .padding(.top, 2)
                    if guidance.liveConnections.isEmpty {
                        Text(guidance.liveConnectionsEmptyText).font(Theme.bodyFont).foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(guidance.liveConnections.enumerated()), id: \.offset) { _, line in
                            Text("• \(line)").font(Theme.bodyFont)
                        }
                    }
                }
                .padding(.leading, 15)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).strokeBorder(Color.primary.opacity(0.12), lineWidth: 1))
        .padding(.top, 4)
    }
}
