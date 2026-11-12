import SwiftUI

struct PlaceholderView: View {
    var body: some View {
        VStack(spacing: 12) {
            Text(AppInfo.name)
                .font(.largeTitle.bold())
            Text(AppInfo.versionText)
            Text(AppInfo.stage)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding()
    }
}
