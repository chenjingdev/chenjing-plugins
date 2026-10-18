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
                fixIsRunning: model.summary.fix.map { model.inFlight.contains($0) } ?? false
            ) {
                if let fix = model.summary.fix { model.send(fix) }
            }

            if let banner = model.banner {
                BannerView(banner: banner) { model.dismissBanner() }
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
    }

    @ViewBuilder private var tabContent: some View {
        if let content = model.content {
            switch model.selectedTab {
            case .connections:
                ConnectionsTabView(content: content.connections, model: model)
            case .leases:
                LeasesTabView(content: content.leases, failedSessionIDs: model.failedSessionIDs, model: model)
            case .otherTools:
                OtherToolsTabView(content: content.otherTools)
            case .activity:
                ActivityTabView(
                    content: content.activity, copying: model.inFlight.contains(.copyDiagnosis), note: maintenance?.loginItem.line
                ) {
                    model.send(.copyDiagnosis)
                }
            }
        } else {
            // One view only: a modifier applied to two views in a builder would apply to each.
            TabPlaceholder(reason: model.summary.isPlaceholder ? .loading : .unreadable)
        }
    }
}
