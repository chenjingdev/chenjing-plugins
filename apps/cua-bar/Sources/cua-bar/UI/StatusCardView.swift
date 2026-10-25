import SwiftUI

/// The top of the popover: the state, one line about what to do next, and the one button that
/// fixes the problem when there is one (or 다시 켜기, when a restart of Codex would bring something).
struct StatusCardView: View {
    var summary: StatusSummary
    /// The fix is running, or waits for the Codex a restart asked to quit; the button waits.
    var fixIsRunning: Bool
    /// Why it waits, on hover (Codex가 꺼지기를 기다리는 중이에요); nil for none.
    var fixHelp: String?
    /// What the button cuts off, beside it (하던 Codex 작업이 끊겨요): the press is the consent; nil for none.
    var fixNote: String? = nil
    var fix: () -> Void

    /// Neutral until the first answer, so the card never says "ready" before it is known.
    private var tint: Color { summary.isPlaceholder ? Color.secondary : Theme.tint(for: summary.icon) }
    private var labelColor: Color { summary.isPlaceholder ? Color.secondary : Theme.text(for: summary.icon) }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Group {
                if summary.isPlaceholder {
                    ProgressView().controlSize(.regular)
                } else {
                    Image(systemName: MenuBarIcon.symbolName(for: summary.icon))
                        .font(.system(size: 26, weight: .medium))
                        .foregroundStyle(tint)
                }
            }
            .frame(width: 34, height: 30)
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 5) {
                Text(summary.stateLabel)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(labelColor)
                Text(summary.headline)
                    .font(.system(size: 15, weight: .semibold))
                    .fixedSize(horizontal: false, vertical: true)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("다음에 할 일")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                    Text(summary.nextStep)
                        .font(Theme.bodyFont)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let warning = summary.warning {
                    Label(warning, systemImage: "exclamationmark.circle")
                        .font(.system(size: 11))
                        .foregroundStyle(summary.icon == .problem ? Theme.orangeText : Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let label = summary.fixLabel, summary.fix != nil {
                    HStack(spacing: 8) {
                        if let note = fixNote {
                            Text(note)
                                .font(.system(size: 11))
                                .foregroundStyle(summary.icon == .problem ? Theme.orangeText : Color.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                        if fixIsRunning { ProgressView().controlSize(.small) }
                        Button(action: fix) { Text(label).font(.system(size: 12, weight: .semibold)) }
                            .buttonStyle(FixButtonStyle(fill: Theme.fixFill(for: summary.icon)))
                            .disabled(fixIsRunning)
                            .help(fixHelp ?? "")
                    }
                    .padding(.top, 3)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(tint.opacity(summary.icon == .ready || summary.isPlaceholder ? 0.07 : 0.13)))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(tint.opacity(0.35), lineWidth: 1))
        .accessibilityElement(children: .contain)
    }
}

/// The result of the last action, one line, with a way to dismiss it.
struct BannerView: View {
    var banner: ActionBanner
    var dismiss: () -> Void
    /// The message's own button, if it has one (Codex 열기).
    var followUp: (CUAAction) -> Void = { _ in }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: banner.outcome.kind.symbolName).foregroundStyle(Theme.tint(for: banner.outcome.kind))
            Text(banner.outcome.message)
                .font(.system(size: 12))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            if let button = banner.outcome.followUp {
                SpecButton(spec: ButtonSpec(title: button.title, action: button.action, help: button.title), send: followUp)
            }
            Button(action: dismiss) {
                Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .accessibilityLabel("닫기")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.tint(for: banner.outcome.kind).opacity(0.12)))
        .accessibilityElement(children: .combine)
    }
}
