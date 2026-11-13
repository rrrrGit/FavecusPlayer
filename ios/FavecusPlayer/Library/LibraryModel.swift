import Foundation

/// 画面の表示用に読み取るだけのモデル。保存・編集の正本は共通JSが返すJSON文字列で、Swiftの構造体から書き戻さない
/// （未知の項目を落とさないため）。
struct LibraryDocument: Decodable, Equatable {
    var rootPlaylistIds: [String]
    var playlists: [PlaylistItem]
    var activePlaylistId: String?

    func playlist(_ id: String) -> PlaylistItem? { playlists.first { $0.id == id } }

    /// 親（nilなら最上位）の子リスト。見つからないIDは表示しない。
    func children(of parentId: String?) -> [PlaylistItem] {
        guard let parentId else { return rootPlaylistIds.compactMap { playlist($0) } }
        return (playlist(parentId)?.childIds ?? []).compactMap { playlist($0) }
    }
}

struct PlaylistItem: Decodable, Identifiable, Equatable {
    var id: String
    var name: String
    var childIds: [String]
    var entries: [EntryItem]
    var includeInAll: Bool?
}

struct EntryItem: Decodable, Identifiable, Equatable {
    var id: String
    var title: String
    var type: String
}

/// SwiftUIのonMove（移動元・挿入位置）を、共通JSの並べ替え操作（対象の前/後ろ）へ変換する。
enum MoveMapper {
    struct Result: Equatable {
        var id: String
        var targetId: String
        var after: Bool
    }

    /// ids：現在の並び。from：移動元（1件のみ対応）。destination：元の配列での挿入位置。
    static func map(ids: [String], from: IndexSet, to destination: Int) -> Result? {
        guard from.count == 1, let index = from.first, ids.indices.contains(index), destination >= 0, destination <= ids.count else { return nil }
        if destination == index || destination == index + 1 { return nil }
        if destination > index { return Result(id: ids[index], targetId: ids[destination - 1], after: true) }
        return Result(id: ids[index], targetId: ids[destination], after: false)
    }
}
