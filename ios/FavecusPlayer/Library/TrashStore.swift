import Foundation

/// 最近削除（v0.7.3 F4）の保管（Application Support/FavecusPlayer/trash.json。端末内だけ・同期しない）。
/// 保管の中身・復元の規則は、共通JS（src/core/trash.cjs。PC版と同じ）。ここは、保管ファイルの読み書きと、期限（30日）・件数（200件）の整理だけ。
/// 保管ファイルは外部入力として扱う：表示に必要な形が正しくない項目は、捨てる（復元の前に、共通JSが、全体の形を検証する）。
struct TrashEntry: Identifiable, Equatable {
    let id: String
    let kind: String
    let label: String
    let deletedAt: Date
    /// 項目の全体（JSON）。復元のときに、そのまま共通JSへ渡す。
    let json: String

    func daysLeft(now: Date) -> Int {
        let left = deletedAt.addingTimeInterval(TimeInterval(TrashStore.retentionDays * 86400)).timeIntervalSince(now)
        return max(0, Int((left / 86400).rounded(.up)))
    }
}

@MainActor
final class TrashStore: ObservableObject {
    static let retentionDays = 30
    static let maxItems = 200

    @Published private(set) var items: [TrashEntry] = []
    private let file: URL
    private let now: () -> Date

    init(directory: URL, now: @escaping () -> Date = { Date() }) {
        file = directory.appendingPathComponent("trash.json")
        self.now = now
        load()
    }

    nonisolated private static func date(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let value = formatter.date(from: text) { return value }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: text)
    }

    /// 項目のJSON文字列を、表示用の形にする。形が正しくなければ nil。
    private func entry(from object: [String: Any]) -> TrashEntry? {
        guard let id = object["id"] as? String, !id.isEmpty, id.count <= 400,
              let kind = object["kind"] as? String, ["playlist", "entry"].contains(kind),
              let label = object["label"] as? String, !label.isEmpty, label.count <= 400,
              let deletedText = object["deletedAt"] as? String, let deleted = Self.date(deletedText),
              JSONSerialization.isValidJSONObject(object), let data = try? JSONSerialization.data(withJSONObject: object),
              let json = String(data: data, encoding: .utf8) else { return nil }
        return TrashEntry(id: id, kind: kind, label: label, deletedAt: deleted, json: json)
    }

    private func pruned(_ list: [TrashEntry]) -> [TrashEntry] {
        let limit = now().addingTimeInterval(-TimeInterval(Self.retentionDays * 86400))
        return Array(list.filter { $0.deletedAt > limit }.sorted { $0.deletedAt > $1.deletedAt }.prefix(Self.maxItems))
    }

    private func load() {
        guard let data = try? Data(contentsOf: file),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any], root["version"] as? Int == 1,
              let raw = root["items"] as? [[String: Any]] else { return }
        items = pruned(raw.compactMap { entry(from: $0) })
    }

    @discardableResult
    private func save() -> Bool {
        let objects = items.compactMap { try? JSONSerialization.jsonObject(with: Data($0.json.utf8)) }
        guard let data = try? JSONSerialization.data(withJSONObject: ["version": 1, "items": objects]) else { return false }
        do { try data.write(to: file, options: .atomic); return true } catch { return false }
    }

    /// 削除の保存に成功したあとに呼ぶ（共通JSが作った項目のJSON）。形が正しくなければ入れない。
    @discardableResult
    func add(json: String) -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any], let added = entry(from: object) else { return false }
        items = pruned([added] + items.filter { $0.id != added.id })
        return save()
    }

    func remove(id: String) {
        let prev = items
        items = items.filter { $0.id != id }
        if items.count != prev.count && !save() { items = prev }
    }

    func clear() {
        let prev = items
        items = []
        if !save() { items = prev }
    }

    /// 復元のために、項目の中身（オブジェクト）を取り出す。
    func item(id: String) -> [String: Any]? {
        guard let found = items.first(where: { $0.id == id }) else { return nil }
        return try? JSONSerialization.jsonObject(with: Data(found.json.utf8)) as? [String: Any]
    }

    var currentTime: Date { now() }
}
