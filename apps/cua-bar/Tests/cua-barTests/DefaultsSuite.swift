import Foundation

/// A UserDefaults suite of its own, so nothing here reads or writes the app's real preferences.
///
/// The suite is named by a path in a throwaway folder, which makes the system keep its file
/// there. A plain suite name puts an empty `.plist` into ~/Library/Preferences that the system
/// writes again after it was deleted, and a test run would leave hundreds of them behind.
struct DefaultsSuite {
    let defaults: UserDefaults
    let name: String
    private let folder: URL

    init() {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("cua-bar-defaults-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        name = folder.appendingPathComponent("suite").path
        defaults = UserDefaults(suiteName: name)!
    }

    func remove() {
        defaults.removePersistentDomain(forName: name)
        try? FileManager.default.removeItem(at: folder)
    }
}
