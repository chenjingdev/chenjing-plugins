import SwiftUI

/// The bottom line of the popover: when the status was read, the new-version button when there
/// is one, this app's version, and 끝내기. What is pressed rarely (진단 복사, 알림 켜기, 앱 지우기) is at the bottom of 기록.
struct FooterView: View {
    var updatedText: String
    /// nil leaves just the time and 끝내기 (previews and tests).
    var maintenance: Maintenance?
    /// This app's version as the view model has it, read from the bundle (`AppVersion.current`), so it follows every
    /// release by itself. nil (run unbundled, previews) shows none.
    var appVersion: String? = nil
    var quit: () -> Void

    /// "v0.8.11": what the person reads next to 끝내기.
    static func versionText(_ version: String?) -> String? {
        version.map { "v" + $0 }
    }

    var body: some View {
        HStack(spacing: 10) {
            Text(updatedText)
                .font(Theme.captionFont)
                .foregroundStyle(.secondary)
            if let maintenance {
                NewVersionButton(updater: maintenance.updater, opener: maintenance.opener)
            }
            Spacer(minLength: 4)
            if let version = Self.versionText(appVersion) {
                Text(version)
                    .font(Theme.captionFont)
                    .foregroundStyle(.secondary)
                    .help("CUA Bar \(version)")
            }
            Button("끝내기", action: quit)
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
        }
    }
}

/// "새 버전 x.y.z", only while an update to that version could not be made by itself (F4). The app updates
/// itself; this is what is left when it could not. It opens the download site, where the person gets the app.
struct NewVersionButton: View {
    @ObservedObject var updater: AppUpdater
    var opener: any URLOpening

    var body: some View {
        if let failure = updater.failure {
            Button {
                Task { _ = await opener.open(UpdateSource.site) }
            } label: {
                Text(failure.buttonTitle)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.blueText)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color.blue.opacity(0.14)))
            }
            .buttonStyle(.plain)
            .help("새 판을 저절로 올리지 못했어요. 받는 곳(cua.chenjing.org)을 열어요")
        }
    }
}
