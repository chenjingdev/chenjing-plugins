import SwiftUI

/// 연결: one list. Who uses the screen, then 손볼 것 with 모두 정리 above it, then the connections
/// whose AI is alive, the other tools, and the folded guidance for tabs that stay blocked. Every row
/// has the one button its state calls for; the same job is never pressed in two places. A question
/// about a line is asked right under that line, and the answer to a line's button is one line on it.
struct ConnectionsTabView: View {
    var content: ConnectionsContent
    var failedSessionIDs: Set<String>
    @ObservedObject var model: CUABarViewModel

    /// The question asked on a line, so the list can scroll to it: under a line near the bottom it
    /// would be out of sight, and the press would seem to have done nothing.
    private static let questionID = "question-on-a-line"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 6) {
                    ScreenLineView(screen: content.screen)

                    if let tidy = content.tidy {
                        TidySectionView(tidy: tidy, failedSessionIDs: failedSessionIDs, model: model)
                    }

                    ForEach(content.groups) { group in
                        SectionHeader(text: group.title)
                        ForEach(group.rows) { row in
                            ConnectionRowView(
                                row: row, waiting: model.isWaiting(onConnection: row.id),
                                waitingHelp: model.cleanupHelp(onConnection: row.id),
                                refused: model.refusedReleaseIDs.contains(row.id),
                                result: model.placedResults[.connection(row.id)]) { model.send($0) }
                            if let prompt = model.confirmationPrompt(forConnection: row.id) {
                                ConfirmationView(prompt: prompt, confirm: { model.confirm() }, cancel: { model.cancelPending() })
                                    .id(Self.questionID)
                                    .transition(.opacity)
                            }
                        }
                    }

                    if let empty = content.emptyText { EmptyLine(text: empty) }

                    ForEach(content.tools) { tool in OtherToolView(tool: tool) }

                    GuidanceView(
                        guidance: content.guidance,
                        isOpen: Binding(
                            get: { model.guidanceOpenByUser ?? (content.guidance.needsAttention || !failedSessionIDs.isEmpty) },
                            set: { model.guidanceOpenByUser = $0 }))
                }
                .padding(.vertical, 2)
            }
            .onChange(of: model.pending?.id) { _, id in
                guard id != nil, let line = model.pending?.action.connectionID, model.confirmationPrompt(forConnection: line) != nil else { return }
                // After this update, when the question is in the list.
                Task { @MainActor in
                    withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(Self.questionID) }
                }
            }
        }
    }
}

/// Who has the screen, on one line.
struct ScreenLineView: View {
    var screen: ScreenLine

    var body: some View {
        RowCard(tint: screen.isActive ? .blue : nil) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: screen.isActive ? "cursorarrow.motionlines" : "cursorarrow")
                    .font(.system(size: 12))
                    .foregroundStyle(screen.isActive ? Color.blue : Color.secondary)
                    .frame(width: 16)
                    .accessibilityHidden(true)
                Text(screen.line)
                    .font(Theme.bodyFont)
                    .foregroundStyle(screen.isActive ? Color.primary : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// 손볼 것: its head says how many and holds 모두 정리, and under it the lines the app can clean up.
struct TidySectionView: View {
    var tidy: TidyContent
    var failedSessionIDs: Set<String>
    @ObservedObject var model: CUABarViewModel

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 6) {
                Text(tidy.title)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 4)
                if let button = tidy.tidyAllButton {
                    if model.tidyAllIsWaiting { ProgressView().controlSize(.small) }
                    SpecButton(
                        spec: button, waiting: model.tidyAllIsWaiting,
                        waitingHelp: model.cleanupHelp(for: button.action)) { model.send($0) }
                }
            }
            .padding(.top, 2)
            // The answer to 모두 정리, right under the button it came from.
            if let result = model.placedResults[.tidyAll] { ResultLine(outcome: result) }
            if let notice = tidy.notice {
                Label(notice, systemImage: "info.circle")
                    .font(Theme.captionFont)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(tidy.rows) { row in
                switch row {
                case .ended(let ended):
                    ConnectionRowView(
                        row: ended, waiting: model.isWaiting(onConnection: ended.id),
                        waitingHelp: model.cleanupHelp(onConnection: ended.id), refused: false,
                        result: model.placedResults[.connection(ended.id)]) { model.send($0) }
                case .lease(let lease):
                    LeaseRowView(
                        row: lease, failed: lease.sessionID.map(failedSessionIDs.contains) ?? false,
                        result: Self.result(of: lease, in: model),
                        waiting: lease.sessionID.map(model.isWaiting(onSession:)) ?? false,
                        waitingHelp: lease.releaseButton.flatMap { model.cleanupHelp(for: $0.action) }) { model.send($0) }
                case .orphan(let orphan):
                    RowCard(tint: .red) {
                        ToolClientRowView(
                            row: orphan, waiting: orphan.connectionID.map(model.isWaiting(onConnection:)) ?? false,
                            result: orphan.connectionID.flatMap { model.placedResults[.connection($0)] }) { model.send($0) }
                    }
                }
            }
        }
    }
}

extension TidySectionView {
    /// What a lease line says about its last release: the answer just told on it, else the failure it
    /// keeps until the lease goes (a success is not kept: the line goes with it).
    static func result(of lease: LeaseRow, in model: CUABarViewModel) -> ActionOutcome? {
        guard let session = lease.sessionID else { return nil }
        if let told = model.placedResults[.session(session)] { return told }
        return model.sessionResults[session].flatMap { $0.kind == .success ? nil : $0 }
    }
}

struct ConnectionRowView: View {
    var row: ConnectionRow
    var waiting: Bool
    /// Said on hover while the automatic cleanup releases this connection.
    var waitingHelp: String?
    /// The engine refused to release its tabs twice (R15): the row says so, and its 탭 풀기 tries again.
    var refused = false
    /// What its button just answered, one line on the row.
    var result: ActionOutcome?
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
                    if refused {
                        Label(ConnectionRow.refusedNote, systemImage: "hourglass")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Theme.orangeText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let hint = row.hint {
                        Text(hint).font(Theme.captionFont).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    if let result { ResultLine(outcome: result) }
                }
                Spacer(minLength: 4)
                VStack(alignment: .trailing, spacing: 6) {
                    HStack(spacing: 5) {
                        if row.isBusy { BusyMarker() }
                        StateChip(display: row.state)
                    }
                    HStack(spacing: 4) {
                        if waiting { ProgressView().controlSize(.small) }
                        SpecButton(spec: refused ? row.retryButton : row.button, waiting: waiting, waitingHelp: waitingHelp, send: send)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(row.agent.label) \(row.folder), \(row.state.text)")
    }
}

struct LeaseRowView: View {
    var row: LeaseRow
    /// The release failed in a way the extension reset may fix: the guidance below is open for it.
    var failed: Bool
    /// What the last release of this session said: the answer just told on the line, or the failure it keeps.
    var result: ActionOutcome?
    var waiting: Bool
    /// Why the button waits, when it waits for the automatic cleanup.
    var waitingHelp: String?
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
                    // What it is, then when and which session, on one line.
                    (Text(row.statusText)
                        .foregroundStyle(row.kind == .maybeLeft ? Theme.orangeText : Color.primary)
                        + Text(row.detail.map { " · " + $0 } ?? "").foregroundStyle(.secondary))
                        .font(Theme.captionFont)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    if let result {
                        ResultLine(outcome: result)
                        if failed {
                            Text("아래 안내를 보세요")
                                .font(Theme.captionFont)
                                .foregroundStyle(Theme.redText)
                        }
                    } else if let hint = row.hint {
                        Text(hint).font(Theme.captionFont).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 4)
                if let button = row.releaseButton {
                    HStack(spacing: 4) {
                        if waiting { ProgressView().controlSize(.small) }
                        SpecButton(spec: button, waiting: waiting, waitingHelp: waitingHelp, send: send)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
    }
}

/// One other tool (cmux-cua): its state on the head line, and under it the conversations that hold it
/// open. They have no button: the AI is alive, and it is that AI's tool.
struct OtherToolView: View {
    var tool: OtherToolRow

    var body: some View {
        RowCard {
            VStack(alignment: .leading, spacing: 4) {
                Text(tool.title).font(Theme.titleFont)
                ForEach(tool.clients) { client in
                    Divider().padding(.vertical, 2)
                    ToolClientRowView(row: client, waiting: false, result: nil) { _ in }
                }
            }
        }
    }
}

/// One cmux-cua connection: who holds it and since when, with 정리 when nobody does any more.
struct ToolClientRowView: View {
    var row: ToolClientRow
    var waiting: Bool
    /// What its button just answered, one line on the row.
    var result: ActionOutcome?
    var send: (CUAAction) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    AgentBadge(text: "cmux-cua")
                    Text(row.title)
                        .font(Theme.bodyFont)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .help(row.isOrphan ? "이 연결을 띄운 AI 클라이언트가 사라졌어요" : row.path ?? "작업 폴더를 알 수 없어요")
                }
                Text(row.startedText)
                    .font(Theme.captionFont)
                    .foregroundStyle(.secondary)
                if let hint = row.hint {
                    Text(hint).font(Theme.captionFont).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if let result { ResultLine(outcome: result) }
            }
            Spacer(minLength: 4)
            if let button = row.button {
                HStack(spacing: 4) {
                    if waiting { ProgressView().controlSize(.small) }
                    SpecButton(spec: button, waiting: waiting, send: send)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(row.title), \(row.startedText)")
    }
}

/// How to get blocked tabs free when 탭 풀기 does not, and who that would cut off. Folded; open on
/// its own when a leftover cannot be released one by one.
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
