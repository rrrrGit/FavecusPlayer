import Foundation

/// 端末ごとのメディア保存の状態（共通の定義：docs/DESIGN.md「DeviceMediaと保存状態」）。同期しない。端末のパスは同期データ・ZIPに含めない。
enum DeviceMediaState: String, Codable {
    case notDownloaded = "NotDownloaded"
    case preparing = "Preparing"
    case downloading = "Downloading"
    case processing = "Processing"
    case validating = "Validating"
    case completed = "Completed"
    case failed = "Failed"
    case cancelled = "Cancelled"

    var inProgress: Bool { [.preparing, .downloading, .processing, .validating].contains(self) }
}

/// 1つのメディア（同期用メディアキー＋形式）の保存記録。同じキーの曲は、1つのファイルを共有する。
struct DeviceMediaRecord: Codable, Equatable, Identifiable {
    var key: String
    var kind: String
    var quality: Int = 0
    var state: DeviceMediaState = .notDownloaded
    var fileName: String?
    var bytes: Int64 = 0
    var duration: Double = 0
    var message: String?
    var updatedAt: Double = 0

    var id: String { "\(key)|\(kind)" }
}

/// 保存の記録（Application Support/FavecusPlayer/downloads.json）。原子的に書き、再起動後は、実際のファイルを確認してから状態を決める
/// （途中だったものは完了扱いにしない。完了と記録されていてもファイルがなければ失敗にする）。
actor DownloadCatalog {
    private struct File: Codable {
        var version = 1
        var records: [DeviceMediaRecord] = []
    }

    private let url: URL
    private let mediaDirectory: URL
    private var records: [String: DeviceMediaRecord] = [:]

    /// 記録のファイルがあるのに、まだ読み込めていない（または読み込みに失敗した）間は、書き込まない（元の記録を上書きしない）。
    private var ready: Bool

    init(url: URL, mediaDirectory: URL) {
        self.url = url
        self.mediaDirectory = mediaDirectory
        self.ready = !FileManager.default.fileExists(atPath: url.path)
    }

    /// 読み込み。読めない・未知の版のときは、上書きせず、空のまま使わない（throw）。
    /// keeping：取得が続いているジョブ（再起動前から）を持つ記録ID。それ以外の途中の記録は、失敗にする。
    func load(keeping: Set<String> = []) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        let data = try Data(contentsOf: url)
        let file = try JSONDecoder().decode(File.self, from: data)
        guard file.version == 1 else { throw TransferError.message("この版では扱えない保存記録です。保存記録は変更していません。") }
        var loaded: [String: DeviceMediaRecord] = [:]
        for record in file.records {
            // 改ざん・破損への備え：ファイル名はフォルダ直下の1つの名前だけ。同じIDが重なっても落とさない。
            if let name = record.fileName, name.isEmpty || name != (name as NSString).lastPathComponent || name.hasPrefix(".") { continue }
            loaded[record.id] = record
        }
        records = loaded
        ready = true
        var changed = false
        for (id, record) in records {
            var next = record
            if record.state.inProgress && !keeping.contains(id) {
                next.state = .failed
                next.message = "中断されました。もう一度保存してください。"
                next.fileName = nil
            } else if record.state == .completed {
                let exists = record.fileName.map { FileManager.default.fileExists(atPath: mediaDirectory.appendingPathComponent($0).path) } ?? false
                if !exists { next.state = .failed; next.message = "保存したファイルが見つかりません。"; next.fileName = nil }
            }
            if next != record { next.updatedAt = Date().timeIntervalSince1970; records[id] = next; changed = true } // 見つからなくなった保存も、新しい失敗として一覧に出す
        }
        if changed { try save() }
    }

    func all() -> [DeviceMediaRecord] { records.values.sorted { $0.id < $1.id } }

    func record(key: String, kind: String) -> DeviceMediaRecord? { records["\(key)|\(kind)"] }

    func upsert(_ record: DeviceMediaRecord) throws {
        guard ready else { throw TransferError.message("保存記録を読み込めていないため、保存できません。") }
        var next = record
        next.updatedAt = Date().timeIntervalSince1970
        records[next.id] = next
        try save()
    }

    func remove(key: String, kind: String) throws {
        guard ready else { throw TransferError.message("保存記録を読み込めていません。") }
        records["\(key)|\(kind)"] = nil
        try save()
    }

    /// 失敗・取り消しの記録だけを消す（保存中・保存済みの記録とファイルは消さない）。戻り値：消した件数。
    @discardableResult
    func removeProblems() throws -> Int {
        guard ready else { throw TransferError.message("保存記録を読み込めていません。") }
        let ids = records.values.filter { $0.state == .failed || $0.state == .cancelled }.map(\.id)
        guard !ids.isEmpty else { return 0 }
        for id in ids { records[id] = nil }
        try save()
        return ids.count
    }

    /// 指定した記録を消す（ファイルは消さない。呼び出し側が、先にファイルを消してから呼ぶ）。
    func removeRecords(ids: [String]) throws {
        guard ready else { throw TransferError.message("保存記録を読み込めていません。") }
        guard !ids.isEmpty else { return }
        for id in ids { records[id] = nil }
        try save()
    }

    /// 他の記録が参照していないファイルだけ、削除してよい（同じファイルを別の記録が指すことはないが、念のため確認する）。
    func isReferenced(fileName: String, except: String) -> Bool {
        records.values.contains { $0.id != except && $0.fileName == fileName }
    }

    private func save() throws {
        guard ready else { throw TransferError.message("保存記録を読み込めていません。") }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(File(records: records.values.sorted { $0.id < $1.id }))
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
