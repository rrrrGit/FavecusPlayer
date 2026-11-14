import Foundation

/// ZIPの入れ物としての読み取りだけを行う（名前の許可規則・構成の検査は共通JS）。
/// Windows版（zip.cjs の ZipReader）と同じ検査：中央ディレクトリのサイズを使い、ZIP64に対応、
/// 名前の重複・分割ZIP・暗号化・想定外のフラグを拒否。iPhone版は無圧縮（method 0）のみ対応（Windows版の出力は無圧縮）。
enum ZipError: Error, CustomStringConvertible {
    case invalid(String)
    case unsupported(String)
    case missing(String)
    case checksum(String)

    var description: String {
        switch self {
        case .invalid(let message), .unsupported(let message), .missing(let message), .checksum(let message): return message
        }
    }
}

protocol ZipSource: AnyObject {
    var size: UInt64 { get }
    func read(at offset: UInt64, count: Int) throws -> Data
}

final class FileSource: ZipSource {
    private let handle: FileHandle
    let size: UInt64

    init(url: URL) throws {
        handle = try FileHandle(forReadingFrom: url)
        size = try handle.seekToEnd()
    }

    deinit { try? handle.close() }

    func read(at offset: UInt64, count: Int) throws -> Data {
        guard count >= 0, offset + UInt64(count) <= size else { throw ZipError.invalid("ZIPの途中でデータが途切れています。") }
        if count == 0 { return Data() }
        try handle.seek(toOffset: offset)
        guard let data = try handle.read(upToCount: count), data.count == count else { throw ZipError.invalid("ZIPの途中でデータが途切れています。") }
        return data
    }
}

final class DataSource: ZipSource {
    private let data: Data
    var size: UInt64 { UInt64(data.count) }

    init(_ data: Data) { self.data = Data(data) }

    func read(at offset: UInt64, count: Int) throws -> Data {
        guard count >= 0, offset + UInt64(count) <= UInt64(data.count) else { throw ZipError.invalid("ZIPの途中でデータが途切れています。") }
        let start = data.startIndex + Int(offset)
        return Data(data[start..<(start + count)])
    }
}

struct ZipEntry {
    let name: String
    let start: UInt64
    let bytes: UInt64
    let crc: UInt32
}

extension Data {
    // Dataは先頭が0とは限らないため、相対位置で読む。
    func u16(_ at: Int) -> Int { Int(self[startIndex + at]) | Int(self[startIndex + at + 1]) << 8 }
    func u32(_ at: Int) -> UInt64 { UInt64(u16(at)) | UInt64(u16(at + 2)) << 16 }
    func u64(_ at: Int) -> UInt64 { u32(at) | u32(at + 4) << 32 }
}

struct Crc32 {
    private static let table: [UInt32] = (0..<256).map { index -> UInt32 in
        var value = UInt32(index)
        for _ in 0..<8 { value = value & 1 == 1 ? 0xedb88320 ^ (value >> 1) : value >> 1 }
        return value
    }

    private var state: UInt32 = 0xffffffff

    mutating func update(_ data: Data) {
        for byte in data { state = Crc32.table[Int((state ^ UInt32(byte)) & 0xff)] ^ (state >> 8) }
    }

    var value: UInt32 { state ^ 0xffffffff }
}

final class ZipArchive {
    static let maxFiles = 60000
    static let maxBytes: UInt64 = 1 << 40
    private static let u32max: UInt64 = 0xffffffff

    private let source: ZipSource
    private(set) var entries: [String: ZipEntry] = [:]
    private(set) var names: [String] = []
    /// 全エントリの展開後サイズの合計（呼び出し側が、読み込む前に上限を確認できる）。
    private(set) var totalBytes: UInt64 = 0

    init(source: ZipSource) throws {
        self.source = source
        try open()
    }

    func has(_ name: String) -> Bool { entries[name] != nil }

    /// 64ビットの値は、足し算の前に上限（1TB）で確認する（オーバーフローでトラップしないため）。
    private static func bounded(_ value: UInt64) throws -> UInt64 {
        guard value <= maxBytes else { throw ZipError.invalid("ZIPのサイズが上限を超えています。") }
        return value
    }

    private func open() throws {
        let size = source.size
        guard size >= 22, size <= ZipArchive.maxBytes else { throw ZipError.invalid("対応するZIPファイルではありません。") }
        let tailLength = Int(min(size, 65557)), tailStart = size - UInt64(tailLength)
        let tail = try source.read(at: tailStart, count: tailLength)
        var end = tail.count - 22
        while end >= 0 && !(tail.u32(end) == 0x06054b50 && end + 22 + tail.u16(end + 20) == tail.count) { end -= 1 }
        guard end >= 0, tail.u16(end + 4) == 0, tail.u16(end + 6) == 0 else { throw ZipError.invalid("ZIPの一覧を読み取れません。") }
        var count = UInt64(tail.u16(end + 10)), directorySize = tail.u32(end + 12), directoryOffset = tail.u32(end + 16)
        var boundary = tailStart + UInt64(end)
        guard count == UInt64(tail.u16(end + 8)) else { throw ZipError.unsupported("分割ZIPは対応していません。") }
        if count == 65535 || directorySize == ZipArchive.u32max || directoryOffset == ZipArchive.u32max {
            guard boundary >= 20 else { throw ZipError.invalid("ZIP64の一覧を読み取れません。") }
            let locator = try source.read(at: boundary - 20, count: 20)
            guard locator.u32(0) == 0x07064b50, locator.u32(4) == 0, locator.u32(16) == 1 else { throw ZipError.unsupported("分割ZIPは対応していません。") }
            let endOffset = locator.u64(8)
            guard try ZipArchive.bounded(endOffset) + 56 <= boundary else { throw ZipError.invalid("ZIP64が壊れています。") }
            let info = try source.read(at: endOffset, count: 56)
            let recordSize = try ZipArchive.bounded(info.u64(4))
            guard info.u32(0) == 0x06064b50, recordSize >= 44, endOffset + 12 + recordSize <= boundary - 20, info.u32(16) == 0, info.u32(20) == 0, info.u64(24) == info.u64(32) else {
                throw ZipError.invalid("ZIP64が壊れています。")
            }
            count = try ZipArchive.bounded(info.u64(32)); directorySize = try ZipArchive.bounded(info.u64(40)); directoryOffset = try ZipArchive.bounded(info.u64(48)); boundary = endOffset
        }
        guard count <= UInt64(ZipArchive.maxFiles), directorySize <= 16 * 1024 * 1024, directoryOffset + directorySize <= boundary else {
            throw ZipError.invalid("ZIPが大きすぎるか壊れています。")
        }
        let directory = try source.read(at: directoryOffset, count: Int(directorySize))
        var at = 0, total: UInt64 = 0
        for _ in 0..<Int(count) {
            guard at + 46 <= directory.count, directory.u32(at) == 0x02014b50 else { throw ZipError.invalid("ZIPが壊れています。") }
            let flags = directory.u16(at + 8), method = directory.u16(at + 10), crc = UInt32(directory.u32(at + 16))
            var packed = directory.u32(at + 20), bytes = directory.u32(at + 24), local = directory.u32(at + 42)
            let nameLength = directory.u16(at + 28), extraLength = directory.u16(at + 30), commentLength = directory.u16(at + 32), disk = directory.u16(at + 34)
            let extraStart = at + 46 + nameLength, next = extraStart + extraLength + commentLength
            guard next <= directory.count, disk == 0 else { throw ZipError.invalid("ZIPの一覧が正しくありません。") }
            let nameData = Data(directory[(directory.startIndex + at + 46)..<(directory.startIndex + extraStart)])
            guard let name = String(data: nameData, encoding: .utf8) else { throw ZipError.invalid("ZIP内のファイル名を読み取れません。") }
            if packed == ZipArchive.u32max || bytes == ZipArchive.u32max || local == ZipArchive.u32max {
                var position = extraStart, found = false
                while position + 4 <= extraStart + extraLength {
                    let type = directory.u16(position), length = directory.u16(position + 2), stop = position + 4 + length
                    position += 4
                    guard stop <= extraStart + extraLength else { throw ZipError.invalid("ZIP64の拡張情報が正しくありません。") }
                    if type == 1 {
                        for field in 0..<3 {
                            let current = field == 0 ? bytes : field == 1 ? packed : local
                            if current == ZipArchive.u32max {
                                guard position + 8 <= stop else { throw ZipError.invalid("ZIP64のサイズが不足しています。") }
                                let value = directory.u64(position)
                                guard value <= ZipArchive.maxBytes else { throw ZipError.invalid("ZIPのサイズが上限を超えています。") }
                                if field == 0 { bytes = value } else if field == 1 { packed = value } else { local = value }
                                position += 8
                            }
                        }
                        found = true
                    }
                    position = stop
                }
                guard found else { throw ZipError.invalid("ZIP64の拡張情報がありません。") }
            }
            at = next
            total += bytes
            guard local <= ZipArchive.maxBytes, packed <= ZipArchive.maxBytes, flags & ~0x808 == 0, entries[name] == nil, local + 30 + packed <= directoryOffset, total <= ZipArchive.maxBytes else { throw ZipError.invalid("対応しないZIP構造です。") }
            guard method == 0 else { throw ZipError.unsupported("この版では圧縮されたZIPを扱えません。FavecusPlayerが出力したZIPを使ってください。") }
            let header = try source.read(at: local, count: 30)
            guard header.u32(0) == 0x04034b50, header.u16(6) == flags, header.u16(8) == method else { throw ZipError.invalid("ZIPのヘッダーが一致しません。") }
            let localNameLength = header.u16(26), localExtraLength = header.u16(28)
            let localName = try source.read(at: local + 30, count: localNameLength)
            let start = local + 30 + UInt64(localNameLength + localExtraLength)
            guard String(data: localName, encoding: .utf8) == name, start + packed <= directoryOffset, packed == bytes else { throw ZipError.invalid("ZIPの内容が一致しません。") }
            entries[name] = ZipEntry(name: name, start: start, bytes: bytes, crc: crc)
            names.append(name)
        }
        guard at == directory.count else { throw ZipError.invalid("ZIPの一覧サイズが一致しません。") }
        totalBytes = total
    }

    /// 小さなエントリを丸ごと読む（CRCとサイズを検証）。
    func data(_ name: String, limit: Int) throws -> Data {
        guard let entry = entries[name] else { throw ZipError.missing("アーカイブ内のデータが見つかりません。") }
        guard entry.bytes <= UInt64(limit) else { throw ZipError.invalid("アーカイブ内のデータが大きすぎます。") }
        let data = try source.read(at: entry.start, count: Int(entry.bytes))
        var crc = Crc32()
        crc.update(data)
        guard crc.value == entry.crc else { throw ZipError.checksum("アーカイブのデータが壊れています（\(name)）。") }
        return data
    }

    /// 大きなエントリをファイルへ展開する（1MBずつ。CRCとサイズを検証し、失敗したら書きかけを消す）。
    /// ファイルは「初回ロック解除まで」の保護にする（ロック中の音声再生のため）。
    func extract(_ name: String, to destination: URL) throws {
        guard let entry = entries[name] else { throw ZipError.missing("アーカイブ内のデータが見つかりません。") }
        let manager = FileManager.default
        guard manager.createFile(atPath: destination.path, contents: nil, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]) else {
            throw ZipError.invalid("保存先を作成できません。")
        }
        do {
            let handle = try FileHandle(forWritingTo: destination)
            defer { try? handle.close() }
            var crc = Crc32(), done: UInt64 = 0
            while done < entry.bytes {
                let count = Int(min(UInt64(1 << 20), entry.bytes - done))
                let chunk = try source.read(at: entry.start + done, count: count)
                crc.update(chunk)
                try handle.write(contentsOf: chunk)
                done += UInt64(count)
            }
            guard crc.value == entry.crc else { throw ZipError.checksum("アーカイブのデータが壊れています（\(name)）。") }
        } catch {
            try? manager.removeItem(at: destination)
            throw error
        }
    }
}
