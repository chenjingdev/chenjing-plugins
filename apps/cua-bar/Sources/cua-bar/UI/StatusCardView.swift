import SwiftUI

/// The top of the popover: the state, one line about what to do next, and the one button that
/// fixes the problem when there is one.
struct StatusCardView: View {
    var summary: StatusSummary
    /// The fix is running; the button waits.
    var fixIsRunning: Bool
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
                        Spacer(minLength: 0)
                        if fixIsRunning { ProgressView().controlSize(.small) }
                        Button(action: fix) { Text(label).font(.system(size: 12, weight: .semibold)) }
                            .buttonStyle(FixButtonStyle())
                            .disabled(fixIsRunning)
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

    private var symbol: String {
        switch banner.outcome.kind {
        case .success: "checkmark.circle.fill"
        case .info: "info.circle.fill"
        case .warning: "exclamationmark.triangle.fill"
        case .failure: "xmark.octagon.fill"
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: symbol).foregroundStyle(Theme.tint(for: banner.outcome.kind))
            Text(banner.outcome.message)
                .font(.system(size: 12))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
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
