import Foundation

/// アラームの保存（Application Support/FavecusPlayer/alarms.json）。端末内だけで、同期しない。
/// 読めない・この版で扱えないファイルは、上書きせず「止まった」状態にする。
@MainActor
final class AlarmStore {
    enum State: Equatable {
        case ready
        case blocked(String)
    }

    static let currentVersion = 1
    private struct Document: Codable { var version: Int; var alarms: [AlarmItem] }

    private let fileURL: URL
    private(set) var state: State = .ready
    private(set) var alarms: [AlarmItem] = []

    init(directory: URL) {
        fileURL = directory.appendingPathComponent("alarms.json")
        load()
    }

    private func load() {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        do {
            let document = try JSONDecoder().decode(Document.self, from: Data(contentsOf: fileURL))
            guard document.version == Self.currentVersion else {
                state = .blocked("アラームの保存データが、この版より新しい形式です")
                return
            }
            alarms = document.alarms.filter(\.isValid)
        } catch {
            state = .blocked("アラームの保存データを読めませんでした")
        }
    }

    /// 保存する（一時ファイルへ書いて置き換える）。止まっているときは、何もせず失敗にする。
    func save(_ items: [AlarmItem]) throws {
        if case .blocked(let message) = state { throw AlarmError.blocked(message) }
        let data = try JSONEncoder().encode(Document(version: Self.currentVersion, alarms: items))
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: fileURL, options: .atomic)
        alarms = items
    }
}

enum AlarmError: Error, Equatable, LocalizedError {
    case blocked(String)
    case invalid
    case unsupported
    case notAuthorized
    case sound(String)

    var errorDescription: String? {
        switch self {
        case .blocked(let message): return message
        case .invalid: return "アラームの時刻・曜日が正しくありません"
        case .unsupported: return "アラームはiOS 26以降で使えます"
        case .notAuthorized: return "アラームの許可がありません（設定アプリで許可してください）"
        case .sound(let message): return message
        }
    }
}
