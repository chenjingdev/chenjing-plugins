import SwiftUI

/// The bottom line of the popover: when the status was read, the new-version button when there
/// is one, and 끝내기. What is pressed rarely (진단 복사, 알림 켜기, 앱 지우기) is at the bottom of 기록.
struct FooterView: View {
    var updatedText: String
    /// nil leaves just the time and 끝내기 (previews and tests).
    var maintenance: Maintenance?
    var quit: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Text(updatedText)
                .font(Theme.captionFont)
                .foregroundStyle(.secondary)
            if let maintenance {
                NewVersionButton(releases: maintenance.releases, opener: maintenance.opener)
            }
            Spacer(minLength: 4)
            Button("끝내기", action: quit)
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
        }
    }
}

/// "새 버전 x.y.z", only when the daily check found a newer app. It opens that release's page;
/// nothing is downloaded or replaced.
struct NewVersionButton: View {
    @ObservedObject var releases: ReleaseChecker
    var opener: any URLOpening

    var body: some View {
        if let release = releases.newRelease {
            Button {
                Task { _ = await opener.open(release.url) }
            } label: {
                Text(release.buttonTitle)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.blueText)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color.blue.opacity(0.14)))
            }
            .buttonStyle(.plain)
            .help("새 앱 판이 나왔어요. 받는 곳(GitHub Release)을 열어요")
        }
    }
}
