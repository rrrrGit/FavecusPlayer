import Foundation

/// 端末固有の小さな JSON ファイルを、親ディレクトリの作成を含めて原子的に読み書きする共通ヘルパー。
enum AtomicJsonFile {
    static func defaultDirectory(fileManager: FileManager = .default) -> URL {
        let base = (try? fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)) ?? fileManager.temporaryDirectory
        return base.appendingPathComponent("FavecusPlayer", isDirectory: true)
    }

    static func read<T: Decodable>(_ type: T.Type, from url: URL) throws -> T {
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(type, from: data)
    }

    static func readOptional<T: Decodable>(_ type: T.Type, from url: URL) -> T? {
        try? read(type, from: url)
    }

    static func write<T: Encodable>(_ value: T, to url: URL, fileManager: FileManager = .default) throws {
        let data = try JSONEncoder().encode(value)
        try writeData(data, to: url, fileManager: fileManager)
    }

    static func writeData(_ data: Data, to url: URL, fileManager: FileManager = .default) throws {
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    static func writeJSONObject(_ object: Any, to url: URL, fileManager: FileManager = .default) throws {
        let data = try JSONSerialization.data(withJSONObject: object)
        try writeData(data, to: url, fileManager: fileManager)
    }
}
