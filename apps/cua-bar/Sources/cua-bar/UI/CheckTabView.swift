import SwiftUI

/// 점검: a line for each thing the app set up or relies on, in the order of the spec. Each line has a state and one
/// short sentence. A broken line the status card carries says 위 카드에서 고쳐요; one the card does not carry has what to do
/// on the line itself: a button (설치, 연결 시험) or a command to copy.
struct CheckTabView: View {
    var content: CheckContent
    /// What a line's button or copy just answered, one line under it.
    var result: (CheckItem) -> ActionOutcome? = { _ in nil }
    var send: (CUAAction) -> Void

    var body: some View {
        ScrollView {
            VStack(spacing: 6) {
                SectionHeader(text: content.headline)
                ForEach(content.lines) { line in
                    CheckLineView(line: line, result: result(line.item), send: send)
                }
            }
            .padding(.vertical, 2)
        }
    }
}

struct CheckLineView: View {
    var line: CheckLine
    var result: ActionOutcome?
    var send: (CUAAction) -> Void

    private var symbol: (name: String, color: Color) {
        switch line.status {
        case .ready: ("checkmark.circle.fill", .green)
        case .problem: ("exclamationmark.triangle.fill", .orange)
        case .waiting: ("clock", .secondary)
        case .unknown: ("questionmark.circle", .secondary)
        case .advice: ("lightbulb", .secondary)
        }
    }

    private var detailColor: Color {
        switch line.status {
        case .problem: Theme.orangeText
        default: .secondary
        }
    }

    var body: some View {
        RowCard(tint: line.status == .problem ? .orange : nil) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: symbol.name)
                    .font(.system(size: 12))
                    .foregroundStyle(symbol.color)
                    .frame(width: 16)
                    .padding(.top, 1)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(line.title).font(Theme.titleFont).lineLimit(1)
                        CheckStatusChip(status: line.status)
                    }
                    Text(line.detail)
                        .font(Theme.captionFont)
                        .foregroundStyle(detailColor)
                        .fixedSize(horizontal: false, vertical: true)
                    ForEach(Array(line.steps.enumerated()), id: \.offset) { _, step in
                        Text(step)
                            .font(Theme.captionFont)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    ForEach(line.commands) { command in
                        CheckCommandRow(command: command, send: send)
                    }
                    if let result { ResultLine(outcome: result) }
                }
                Spacer(minLength: 4)
                if let button = line.button {
                    HStack(spacing: 4) {
                        // A button that cannot be pressed now is one that is already at work.
                        if !button.isEnabled { ProgressView().controlSize(.small) }
                        SpecButton(spec: button, send: send)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(line.title), \(line.status.label), \(line.detail)")
    }
}

struct CheckStatusChip: View {
    var status: CheckStatus

    private var tint: Color {
        switch status {
        case .ready: .green
        case .problem: .orange
        case .waiting, .unknown, .advice: .secondary
        }
    }

    private var text: Color {
        switch status {
        case .ready: Theme.greenText
        case .problem: Theme.orangeText
        case .waiting, .unknown, .advice: .secondary
        }
    }

    var body: some View {
        Text(status.label)
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(text)
            .padding(.horizontal, 6)
            .padding(.vertical, 1.5)
            .background(Capsule().fill(tint.opacity(0.14)))
            .accessibilityHidden(true)
    }
}

/// A command to run in a terminal, with the button that copies it. The app never runs it.
struct CheckCommandRow: View {
    var command: CheckCommand
    var send: (CUAAction) -> Void

    var body: some View {
        HStack(spacing: 6) {
            Text(command.text)
                .font(.system(size: 11, design: .monospaced))
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            SpecButton(spec: command.copy, send: send)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color.primary.opacity(0.06)))
    }
}
