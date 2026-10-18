import SwiftUI

/// The bottom line of the popover: when the status was read, the new-version button when there
/// is one, 제거 and 끝내기. 제거 asks once, in a card above the line, before it does anything.
struct FooterView: View {
    var updatedText: String
    /// nil leaves just the time and 끝내기 (previews and tests).
    var maintenance: Maintenance?
    /// 알림 켜기 shows while notifications cannot be shown.
    var notifications: NotificationPermission = .unavailable
    var quit: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            if let maintenance {
                RemovalNoticeView(removal: maintenance.removal)
            }
            HStack(spacing: 10) {
                Text(updatedText)
                    .font(Theme.captionFont)
                    .foregroundStyle(.secondary)
                if let maintenance {
                    NewVersionButton(releases: maintenance.releases, opener: maintenance.opener)
                    if notifications.offersSettings { NotificationsButton(opener: maintenance.opener) }
                }
                Spacer(minLength: 4)
                if let maintenance {
                    RemoveButton(removal: maintenance.removal)
                }
                Button("끝내기", action: quit)
                    .buttonStyle(.plain)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
            }
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

/// 알림 켜기: opens this app's notifications in System Settings. Without them nothing is lost (R21),
/// so it only says so and shows where they are turned on.
struct NotificationsButton: View {
    var opener: any URLOpening

    var body: some View {
        Button {
            Task { _ = await opener.open(NotificationPermission.settingsURL) }
        } label: {
            Text("알림 켜기")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.orangeText)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Capsule().fill(Color.orange.opacity(0.14)))
        }
        .buttonStyle(.plain)
        .help("알림이 꺼져 있어 문제는 아이콘과 카드로만 알려요. 눌러서 시스템 설정의 알림을 열어요")
    }
}

struct RemoveButton: View {
    @ObservedObject var removal: RemovalFlow

    var body: some View {
        // Hidden while the question or a result is on screen, which have their own buttons.
        if removal.phase == .idle {
            Button("제거") { removal.ask() }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
                .help("연결 설정과 중계기를 되돌려요")
        }
    }
}

/// The question before removing, its progress, and its result.
struct RemovalNoticeView: View {
    @ObservedObject var removal: RemovalFlow

    var body: some View {
        switch removal.phase {
        case .idle:
            EmptyView()
        case .confirming:
            RowCard(tint: .orange) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(RemovalMessages.question)
                        .font(Theme.bodyFont)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 8) {
                        Spacer(minLength: 0)
                        Button("취소") { removal.dismiss() }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        Button("제거") { Task { await removal.confirm() } }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                    }
                }
            }
        case .working:
            RowCard(tint: nil) {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(RemovalMessages.working).font(Theme.bodyFont)
                    Spacer(minLength: 0)
                }
            }
        case .finished(let text):
            RowCard(tint: .green) {
                Text(text)
                    .font(Theme.bodyFont)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .refused(let text):
            RowCard(tint: .orange) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(text)
                        .font(Theme.bodyFont)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    Button("닫기") { removal.dismiss() }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }
        }
    }
}
