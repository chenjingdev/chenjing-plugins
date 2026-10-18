import SwiftUI

/// The popover (structure B): a status card on top, tabs below, buttons on every row.
struct PopoverView: View {
    @ObservedObject var model: CUABarViewModel
    /// What the footer and the 기록 tab add: new version, remove, login item. nil leaves them out.
    var maintenance: Maintenance?
    var quit: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            StatusCardView(
                summary: model.summary,
                fixIsRunning: model.fixIsBusy,
                fixHelp: model.summary.fix.flatMap { model.cleanupHelp(for: $0) }
            ) {
                if let fix = model.summary.fix { model.send(fix) }
            }

            if let prompt = model.confirmationPrompt {
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

            FooterView(
                updatedText: model.updatedText, maintenance: maintenance, notifications: model.notificationPermission, quit: quit)
        }
        .padding(Theme.padding)
        .frame(width: Theme.popoverWidth)
        .animation(.easeOut(duration: 0.15), value: model.banner)
        .animation(.easeOut(duration: 0.15), value: model.pending)
    }

    @ViewBuilder private var tabContent: some View {
        if model.selectedTab == .activity {
            // Also without a status: 진단 복사 is most needed exactly then.
            ActivityTabView(
                content: model.activityContent, copying: model.inFlight.contains(.copyDiagnosis),
                note: maintenance?.loginItem.line
            ) {
                model.send(.copyDiagnosis)
            }
        } else if let content = model.content {
            switch model.selectedTab {
            case .connections:
                ConnectionsTabView(content: content.connections, model: model)
            case .leases:
                LeasesTabView(content: content.leases, failedSessionIDs: model.failedSessionIDs, model: model)
            case .otherTools:
                OtherToolsTabView(content: content.otherTools, model: model)
            case .activity:
                EmptyView()
            }
        } else {
            // One view only: a modifier applied to two views in a builder would apply to each.
            TabPlaceholder(reason: model.summary.isPlaceholder ? .loading : .unreadable)
        }
    }
}
