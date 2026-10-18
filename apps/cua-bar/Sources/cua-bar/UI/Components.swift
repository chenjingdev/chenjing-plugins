import SwiftUI

/// A rounded row background.
struct RowCard<Content: View>: View {
    var tint: Color?
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                    .fill(tint?.opacity(0.10) ?? Theme.rowFill)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                    .strokeBorder(tint?.opacity(0.30) ?? Theme.rowStroke, lineWidth: 1)
            )
    }
}

/// The one-line "없음" an empty tab shows (R21), so an empty list does not look broken.
struct EmptyLine: View {
    var text: String

    var body: some View {
        Text(text)
            .font(Theme.bodyFont)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 18)
    }
}

/// Small text button used in rows, drawn from a `ButtonSpec`.
struct SpecButton: View {
    var spec: ButtonSpec
    /// Something is already running that this button would collide with.
    var waiting = false
    /// Said on hover instead of the button's own help while it waits (자동 정리 중이에요).
    var waitingHelp: String?
    var send: (CUAAction) -> Void

    var body: some View {
        Button(role: spec.isDestructive ? .destructive : nil) {
            send(spec.action)
        } label: {
            Text(spec.title)
        }
        .buttonStyle(RowButtonStyle(isDestructive: spec.isDestructive))
        .disabled(!spec.isEnabled || waiting)
        .help(waitingHelp ?? spec.help)
    }
}

/// The look of a small button, decided here and not by the system style: a label color set by hand
/// overrides the system's dimming, which once made a button that cannot be pressed look pressable.
/// Red only while it can be pressed; at 40% opacity when it cannot.
struct RowButtonStyle: ButtonStyle {
    var isDestructive = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 11))
            .foregroundStyle(isDestructive && isEnabled ? Theme.redText : Color.primary)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.primary.opacity(configuration.isPressed ? 0.20 : 0.09)))
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.12), lineWidth: 0.5))
            .opacity(isEnabled ? 1 : 0.4)
    }
}

struct StateChip: View {
    var display: StateDisplay

    var body: some View {
        Text(display.text)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Theme.text(for: display.kind))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Capsule().fill(Theme.tint(for: display.kind).opacity(0.14)))
            .accessibilityLabel("상태: \(display.text)")
    }
}

/// A tool call is in flight right now.
struct BusyMarker: View {
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "bolt.fill").font(.system(size: 8, weight: .bold))
            Text("작업 중").font(.system(size: 10, weight: .medium))
        }
        .foregroundStyle(Theme.blueText)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Capsule().fill(Color.blue.opacity(0.14)))
        .accessibilityLabel("지금 도구를 호출하는 중")
    }
}

/// The agent as a short badge: Claude and Codex differ by letter, not by color alone.
struct AgentBadge: View {
    var agent: AgentKind

    var body: some View {
        Text(agent.label)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 1.5)
            .background(RoundedRectangle(cornerRadius: 4, style: .continuous).strokeBorder(Color.primary.opacity(0.22), lineWidth: 1))
    }
}

struct SectionHeader: View {
    var text: String

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 2)
    }
}

/// Shown instead of a tab's rows while there is no answer to draw from.
struct TabPlaceholder: View {
    enum Reason { case loading, unreadable }
    var reason: Reason

    var body: some View {
        VStack(spacing: 8) {
            switch reason {
            case .loading:
                ProgressView().controlSize(.small)
                Text("불러오는 중…")
            case .unreadable:
                Image(systemName: "questionmark.circle").font(.system(size: 18))
                Text("상태를 읽지 못해서 목록을 보일 수 없어요")
            }
        }
        .font(Theme.bodyFont)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The status card's one fix button. Filled with the problem's color whatever the window state
/// (the system prominent style turns gray when the popover is not the key window).
struct FixButtonStyle: ButtonStyle {
    var fill: Color = Theme.fixFill
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(Color.white)
            .padding(.horizontal, 13)
            .padding(.vertical, 5)
            .background(Capsule().fill(fill.opacity(isEnabled ? (configuration.isPressed ? 0.78 : 1) : 0.45)))
    }
}
