import SwiftUI

/// The popover (structure B): a status card on top, three tabs below (연결, 기록, 점검), one button on every row.
struct PopoverView: View {
    @ObservedObject var model: CUABarViewModel
    /// What the bottom line and the 기록 tab add: new version, 앱 지우기, login item. nil leaves them out.
    var maintenance: Maintenance?
    var quit: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            StatusCardView(
                summary: model.summary,
                fixIsRunning: model.fixIsBusy,
                fixHelp: model.fixHelp
            ) {
                if let fix = model.summary.fix { model.send(fix) }
            }

            // Only the question that comes from the card's own button; a question about a line is under that line.
            if let prompt = model.cardConfirmationPrompt {
                ConfirmationView(prompt: prompt, confirm: { model.confirm() }, cancel: { model.cancelPending() })
                    .transition(.opacity)
            }

            if let banner = model.banner {
                BannerView(banner: banner, dismiss: { model.dismissBanner() }, followUp: { model.send($0) })
                    .transition(.opacity)
            }

            Picker("탭", selection: $model.selectedTab) {
                ForEach(PopoverTab.allCases) { tab in Text(tab.title).tag(tab) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            tabContent
                .frame(height: Theme.listHeight)

            FooterView(updatedText: model.updatedText, maintenance: maintenance, quit: quit)
        }
        .padding(Theme.padding)
        .frame(width: Theme.popoverWidth)
        .animation(.easeOut(duration: 0.15), value: model.banner)
        .animation(.easeOut(duration: 0.15), value: model.pending)
    }

    @ViewBuilder private var tabContent: some View {
        if model.selectedTab == .check {
            // Judged from what the model already read: opening the tab runs nothing.
            CheckTabView(content: model.checkContent, result: { model.placedResults[.check($0)] }) { model.send($0) }
        } else if model.selectedTab == .activity {
            // Also without a status: 진단 복사 is most needed exactly then.
            ActivityTabView(
                content: model.activityContent, copying: model.inFlight.contains(.copyDiagnosis),
                note: maintenance?.loginItem.line, result: model.placedResults[.diagnosis], maintenance: maintenance,
                notifications: model.notificationPermission, turnOnNotifications: { await model.turnOnNotifications() }
            ) {
                model.send(.copyDiagnosis)
            }
        } else if let content = model.content {
            ConnectionsTabView(content: content.connections, failedSessionIDs: model.failedSessionIDs, model: model)
        } else {
            // One view only: a modifier applied to two views in a builder would apply to each.
            TabPlaceholder(reason: model.summary.isPlaceholder ? .loading : .unreadable)
        }
    }
}
