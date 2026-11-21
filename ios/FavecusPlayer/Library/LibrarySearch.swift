import Foundation

/// 検索の結果の1行（共通の処理が返す）。所属リストと曲のID、経路の表示用の文字。
struct LibrarySearchHit: Decodable, Equatable {
    let playlistId: String
    let entryId: String
    let path: String
}

/// 検索の1ページぶん（共通の処理：全角半角・大小・ひらがな/カタカナを同一視、空白区切りのAND、経路も対象、50件ごと）。
struct LibrarySearchResult: Decodable, Equatable {
    let total: Int
    let page: Int
    let pages: Int
    let items: [LibrarySearchHit]
}

/// 入力かライブラリが変わったら、検索を取り直すための印。
struct SearchTrigger: Equatable {
    let query: String
    let document: LibraryDocument?
}
