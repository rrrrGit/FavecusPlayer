import Foundation

/// プレイリストの出力（Windows版で取り込める形式）。何を出力するか（内容・ローカル曲の扱い）は共通JS（TransferExport）が決め、
/// Swiftは「ZIPの書き出し・暗号化・メディアの読み出し」だけを行う。
struct ExportResult: Equatable {
    let url: URL
    let mode: String
    let lists: Int
    let copied: Int
    let missing: Int
    let omitted: Int
}

final class ExportService: @unchecked Sendable {
    private let core: SharedCore
    private static let innerLimit = 32 * 1024 * 1024

    init(core: SharedCore) { self.core = core }

    private struct Record: Decodable {
        var name: String
        var text: String
    }

    private struct Local: Decodable {
        var fileName: String
        var included: Bool
    }

    private struct Response: Decodable {
        var error: String?
        var identity: String?
        var records: [Record]?
        var locals: [Local]?
        var missing: Int?
        var omitted: Int?
    }

    /// mode：media（ローカル曲の実体つき）または information（構造のみ）。出力先はアプリの一時領域（共有シートで渡したあと消せる）。
    func export(libraryText: String, mediaDirectory: URL, mode: String, destinationDirectory: URL) async throws -> ExportResult {
        let core = self.core
        return try await Task.detached {
            let manager = FileManager.default
            var available: [String] = []
            if let names = try? manager.contentsOfDirectory(atPath: mediaDirectory.path) {
                for name in names where !name.hasPrefix(".") {
                    // 通常のファイルだけ（リンクや想定外のものは含めない）
                    if (try? manager.attributesOfItem(atPath: mediaDirectory.appendingPathComponent(name).path)[.type] as? FileAttributeType) == .typeRegular { available.append(name) }
                }
            }
            let request: [String: Any] = ["text": libraryText, "mode": mode, "available": available]
            let requestText = String(decoding: try JSONSerialization.data(withJSONObject: request), as: UTF8.self)
            let decoded = try JSONDecoder().decode(Response.self, from: Data(try core.call("TransferExport", requestText).utf8))
            if let message = decoded.error { throw TransferError.message(message) }
            guard let identity = decoded.identity, let records = decoded.records, let locals = decoded.locals else { throw TransferError.message("出力内容を作成できません。") }

            try manager.createDirectory(at: destinationDirectory, withIntermediateDirectories: true)
            // 内側のZIP（identity.json と各プレイリスト）→ 暗号化コンテナ
            let innerURL = destinationDirectory.appendingPathComponent(".inner-\(UUID().uuidString).zip")
            let plain: Data
            do {
                let inner = try ZipWriter(url: innerURL)
                do {
                    try inner.add(name: "identity.json", data: Data(identity.utf8))
                    for record in records { try inner.add(name: record.name, data: Data(record.text.utf8)) }
                    try inner.finish()
                } catch { inner.abandon(); throw error }
                plain = try Data(contentsOf: innerURL)
            } catch { try? manager.removeItem(at: innerURL); throw error }
            try? manager.removeItem(at: innerURL)
            guard plain.count <= ExportService.innerLimit else { throw TransferError.message("プレイリスト情報が大きすぎます。") }
            let container = try Fvpa.encrypt(plain)

            let stamp = ExportService.stamp()
            let outputURL = destinationDirectory.appendingPathComponent("FavecusPlayer-\(stamp).zip")
            let writer = try ZipWriter(url: outputURL)
            var copied = 0
            do {
                try writer.add(name: "playlists.fvpa", data: container)
                for local in locals where local.included {
                    try writer.add(name: "media/\(local.fileName)", file: mediaDirectory.appendingPathComponent(local.fileName))
                    copied += 1
                }
                try writer.finish()
            } catch { writer.abandon(); throw error }
            return ExportResult(url: outputURL, mode: mode, lists: records.count, copied: copied, missing: decoded.missing ?? 0, omitted: decoded.omitted ?? 0)
        }.value
    }

    nonisolated static func stamp() -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter.string(from: Date())
    }
}

@MainActor
final class ExportCoordinator: ObservableObject {
    enum Phase: Equatable {
        case idle
        case working
        case ready(ExportResult)
        case failed(String)
    }

    @Published private(set) var phase: Phase = .idle

    private let service: ExportService
    private let store: LibraryStore

    init(service: ExportService, store: LibraryStore) {
        self.service = service
        self.store = store
    }

    static var exportDirectory: URL { FileManager.default.temporaryDirectory.appendingPathComponent("FavecusPlayer-export", isDirectory: true) }

    func run(mode: String, directory: URL = ExportCoordinator.exportDirectory) async {
        guard store.isReady else {
            phase = .failed("保存データを開けないため、出力できません。")
            return
        }
        cleanup(directory: directory)
        phase = .working
        await store.waitUntilIdle()
        do {
            phase = .ready(try await service.export(libraryText: store.currentText, mediaDirectory: store.mediaDirectory, mode: mode, destinationDirectory: directory))
        } catch {
            phase = .failed(String(describing: error))
        }
    }

    /// 共有を終えたら、一時領域の出力を消す（自分が作った一時フォルダだけ）。
    func cleanup(directory: URL = ExportCoordinator.exportDirectory) {
        try? FileManager.default.removeItem(at: directory)
        phase = .idle
    }
}
