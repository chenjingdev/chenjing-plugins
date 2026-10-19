import SwiftUI

/// 기록: the engine's recent calls (time, agent, folder, tool, result, duration), and at the very
/// bottom what is pressed rarely: 진단 복사, 알림 켜기 while notifications cannot be shown, and 앱 지우기.
struct ActivityTabView: View {
    var content: ActivityContent
    var copying: Bool
    /// A line about the app itself under the list (the login item).
    var note: String?
    /// nil leaves 알림 켜기 and 앱 지우기 out (previews and tests).
    var maintenance: Maintenance?
    /// 알림 켜기 shows while notifications cannot be shown.
    var notifications: NotificationPermission = .unavailable
    /// What 알림 켜기 does before System Settings; true when they should open.
    var turnOnNotifications: () async -> Bool = { true }
    var copy: () -> Void

    var body: some View {
        VStack(spacing: 6) {
            HStack {
                Text(content.rows.isEmpty ? "최근 조작" : "최근 조작 \(content.rows.count)개")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer()
            }
            if let empty = content.emptyText {
                EmptyLine(text: empty)
                Spacer(minLength: 0)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(content.rows) { row in
                            ActivityRowView(row: row)
                            Divider().opacity(0.5)
                        }
                    }
                }
            }
            ActivityBottomView(
                copyButton: content.copyButton, copying: copying, note: note, maintenance: maintenance,
                notifications: notifications, turnOnNotifications: turnOnNotifications, copy: copy)
        }
    }
}

/// The bottom of 기록: the question or result of 앱 지우기 right above its button, the login item line,
/// and the buttons: 진단 복사, 알림 켜기 (only while notifications cannot be shown), 앱 지우기….
struct ActivityBottomView: View {
    var copyButton: ButtonSpec
    var copying: Bool
    var note: String?
    var maintenance: Maintenance?
    var notifications: NotificationPermission = .unavailable
    var turnOnNotifications: () async -> Bool = { true }
    var copy: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            if let maintenance {
                RemovalNoticeView(removal: maintenance.removal)
            }
            if let note {
                Text(note)
                    .font(Theme.captionFont)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                if copying { ProgressView().controlSize(.small) }
                SpecButton(spec: copyButton, waiting: copying) { _ in copy() }
                if let maintenance, notifications.offersTurningOn {
                    NotificationsButton(permission: notifications, opener: maintenance.opener, turnOn: turnOnNotifications)
                }
                Spacer(minLength: 4)
                if let maintenance {
                    RemoveButton(removal: maintenance.removal)
                }
            }
        }
        .padding(.top, 2)
    }
}

/// 알림 켜기: asks the system's question while nobody has answered it, else opens this app's
/// notifications in System Settings. Without them nothing is lost (R21), so it only says so and
/// shows where they are turned on.
struct NotificationsButton: View {
    static let title = "알림 켜기"

    var permission: NotificationPermission
    var opener: any URLOpening
    var turnOn: () async -> Bool

    var body: some View {
        Button {
            Task {
                if await turnOn() { _ = await opener.open(NotificationPermission.settingsURL) }
            }
        } label: {
            Text(Self.title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.orangeText)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Capsule().fill(Color.orange.opacity(0.14)))
        }
        .buttonStyle(.plain)
        .help(permission == .notDecided
            ? "알림을 아직 허용하지 않아 문제는 아이콘과 카드로만 알려요. 누르면 macOS가 알림을 허용할지 물어요"
            : "알림이 꺼져 있어 문제는 아이콘과 카드로만 알려요. 눌러서 시스템 설정의 알림을 열어요")
    }
}

/// 앱 지우기…: asks once, in a card above it, before it does anything.
struct RemoveButton: View {
    @ObservedObject var removal: RemovalFlow

    var body: some View {
        // Hidden while the question or a result is on screen, which have their own buttons.
        if removal.phase == .idle {
            Button(RemovalMessages.buttonTitle) { removal.ask() }
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
                        Button(RemovalMessages.confirmTitle) { Task { await removal.confirm() } }
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

struct ActivityRowView: View {
    var row: ActivityRow

    private var result: (symbol: String, color: Color, label: String) {
        switch row.ok {
        case true?: ("checkmark.circle.fill", .green, "성공")
        case false?: ("xmark.circle.fill", .red, "실패")
        case nil: ("questionmark.circle", .secondary, "결과 알 수 없음")
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: result.symbol)
                .font(.system(size: 12))
                .foregroundStyle(result.color)
                .frame(width: 16)
                .padding(.top, 1)
                .accessibilityLabel(result.label)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(row.tool).font(.system(size: 12, weight: .medium)).lineLimit(1).truncationMode(.tail)
                    Spacer(minLength: 4)
                    Text(row.durationText)
                        .font(.system(size: 11).monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Text("\(row.timeText) · \(row.agent.label) · \(row.folder)")
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .padding(.vertical, 5)
        .padding(.horizontal, 2)
        .accessibilityElement(children: .combine)
    }
}
