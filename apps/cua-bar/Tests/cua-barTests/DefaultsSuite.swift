import Foundation

/// A UserDefaults suite of its own, so nothing here reads or writes the app's real preferences.
struct DefaultsSuite {
    let defaults: UserDefaults
    let name: String

    init() {
        name = "cua-bar-test-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: name)!
    }

    func remove() { defaults.removePersistentDomain(forName: name) }
}
