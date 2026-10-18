import SwiftUI

/// The question a button asks first (R17, F1, R15), inline in the popover under the status card:
/// what will happen, with the count in it, the consequence in a warning color, and two buttons.
struct ConfirmationView: View {
    var prompt: ConfirmationPrompt
    var confirm: () -> Void
    var cancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "questionmark.circle.fill")
                    .foregroundStyle(Theme.orangeText)
                    .accessibilityHidden(true)
                Text(prompt.title)
                    .font(.system(size: 13, weight: .semibold))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let detail = prompt.detail {
                Text(detail)
                    .font(Theme.bodyFont)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let warning = prompt.warning {
                Label(warning, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.orangeText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                Button(action: cancel) { Text(prompt.cancelTitle) }
                    .buttonStyle(RowButtonStyle())
                Button(action: confirm) { Text(prompt.confirmTitle).font(.system(size: 12, weight: .semibold)) }
                    .buttonStyle(FixButtonStyle(fill: prompt.isDestructive ? Theme.destructiveFill : Theme.fixFill))
            }
            .padding(.top, 2)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Color.orange.opacity(0.10)))
        .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).strokeBorder(Color.orange.opacity(0.40), lineWidth: 1))
        .accessibilityElement(children: .contain)
    }
}
