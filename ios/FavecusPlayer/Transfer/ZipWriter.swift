import Foundation

/// ZIPの書き出し（無圧縮・データ記述子つき・ZIP64対応）。Windows版（zip.cjs の WriteZip）と同じ構造で、Windows版の読み取りがそのまま使える。
/// 名前の許可規則は共通JS（SafeName）が正本。ここでは、書き出す名前を呼び出し側が検査済みであることを前提に、重複だけ拒否する。
final class ZipWriter {
    private struct Record {
        let name: Data
        let offset: UInt64
        let size: UInt64
        let crc: UInt32
        let wide: Bool
    }

    private static let u32max: UInt64 = 0xffffffff
    private static let maxFiles = 60000

    private let handle: FileHandle
    private let url: URL
    private var records: [Record] = []
    private var names = Set<String>()
    private var position: UInt64 = 0
    private var finished = false

    /// 既存のファイルは上書きしない（作成に失敗する）。
    init(url: URL) throws {
        guard !FileManager.default.fileExists(atPath: url.path), FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]) else {
            throw ZipError.invalid("出力先を作成できません。")
        }
        self.url = url
        handle = try FileHandle(forWritingTo: url)
    }

    deinit { if !finished { try? handle.close() } }

    /// 失敗したとき、書きかけのファイルを消す。
    func abandon() {
        try? handle.close()
        finished = true
        try? FileManager.default.removeItem(at: url)
    }

    private func put(_ data: Data) throws {
        try handle.write(contentsOf: data)
        position += UInt64(data.count)
    }

    private static func le16(_ value: Int) -> Data { Data([UInt8(value & 0xff), UInt8((value >> 8) & 0xff)]) }
    private static func le32(_ value: UInt64) -> Data { Data((0..<4).map { UInt8((value >> UInt64(8 * $0)) & 0xff) }) }
    private static func le64(_ value: UInt64) -> Data { Data((0..<8).map { UInt8((value >> UInt64(8 * $0)) & 0xff) }) }

    private static func extra64(_ values: [UInt64]) -> Data {
        guard !values.isEmpty else { return Data() }
        var data = le16(1) + le16(values.count * 8)
        for value in values { data += le64(value) }
        return data
    }

    func add(name: String, data: Data) throws {
        try add(name: name, size: UInt64(data.count)) { sink in try sink(data) }
    }

    /// ファイルを1MBずつ読んで書き込む。読み取り中にサイズが変わったら失敗（Windows版と同じ）。
    func add(name: String, file: URL) throws {
        let expected = (try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.uint64Value ?? 0
        let input = try FileHandle(forReadingFrom: file)
        defer { try? input.close() }
        try add(name: name, size: expected) { sink in
            while let chunk = try input.read(upToCount: 1 << 20), !chunk.isEmpty { try sink(chunk) }
        }
    }

    private func add(name: String, size expected: UInt64, body: (_ sink: (Data) throws -> Void) throws -> Void) throws {
        guard !finished, !names.contains(name), records.count < ZipWriter.maxFiles else { throw ZipError.invalid("ZIP内のファイル名または件数が正しくありません。") }
        names.insert(name)
        let nameData = Data(name.utf8), wide = expected >= ZipWriter.u32max, offset = position
        let extra = wide ? ZipWriter.extra64([expected, expected]) : Data()
        var header = ZipWriter.le32(0x04034b50) + ZipWriter.le16(wide ? 45 : 20) + ZipWriter.le16(0x808) + ZipWriter.le16(0)
        header += ZipWriter.le16(0) + ZipWriter.le16(0) + ZipWriter.le32(0)
        header += ZipWriter.le32(wide ? ZipWriter.u32max : 0) + ZipWriter.le32(wide ? ZipWriter.u32max : 0)
        header += ZipWriter.le16(nameData.count) + ZipWriter.le16(extra.count)
        try put(header)
        try put(nameData)
        try put(extra)
        var size: UInt64 = 0, crc = Crc32()
        try body { chunk in
            size += UInt64(chunk.count)
            guard size <= expected else { throw ZipError.invalid("出力中にファイルの内容が変わりました。もう一度お試しください。") }
            crc.update(chunk)
            try put(chunk)
        }
        guard size == expected else { throw ZipError.invalid("出力中にファイルの内容が変わりました。もう一度お試しください。") }
        var descriptor = ZipWriter.le32(0x08074b50) + ZipWriter.le32(UInt64(crc.value))
        descriptor += wide ? ZipWriter.le64(size) + ZipWriter.le64(size) : ZipWriter.le32(size) + ZipWriter.le32(size)
        try put(descriptor)
        records.append(Record(name: nameData, offset: offset, size: size, crc: crc.value, wide: wide))
    }

    func finish() throws {
        guard !finished else { return }
        let start = position
        for record in records {
            let wideOffset = record.offset >= ZipWriter.u32max
            let extra = ZipWriter.extra64((record.wide ? [record.size, record.size] : []) + (wideOffset ? [record.offset] : []))
            let version = extra.isEmpty ? 20 : 45
            var head = ZipWriter.le32(0x02014b50) + ZipWriter.le16(version) + ZipWriter.le16(version) + ZipWriter.le16(0x808) + ZipWriter.le16(0)
            head += ZipWriter.le16(0) + ZipWriter.le16(0) + ZipWriter.le32(UInt64(record.crc))
            head += ZipWriter.le32(record.wide ? ZipWriter.u32max : record.size) + ZipWriter.le32(record.wide ? ZipWriter.u32max : record.size)
            head += ZipWriter.le16(record.name.count) + ZipWriter.le16(extra.count) + ZipWriter.le16(0) + ZipWriter.le16(0) + ZipWriter.le16(0)
            head += ZipWriter.le32(0) + ZipWriter.le32(wideOffset ? ZipWriter.u32max : record.offset)
            try put(head)
            try put(record.name)
            try put(extra)
        }
        let directorySize = position - start
        let wideEnd = start >= ZipWriter.u32max || directorySize >= ZipWriter.u32max || records.count >= 65535 || records.contains { $0.wide }
        if wideEnd {
            let recordOffset = position
            var end64 = ZipWriter.le32(0x06064b50) + ZipWriter.le64(44) + ZipWriter.le16(45) + ZipWriter.le16(45) + ZipWriter.le32(0) + ZipWriter.le32(0)
            end64 += ZipWriter.le64(UInt64(records.count)) + ZipWriter.le64(UInt64(records.count)) + ZipWriter.le64(directorySize) + ZipWriter.le64(start)
            try put(end64)
            try put(ZipWriter.le32(0x07064b50) + ZipWriter.le32(0) + ZipWriter.le64(recordOffset) + ZipWriter.le32(1))
        }
        var end = ZipWriter.le32(0x06054b50) + ZipWriter.le16(0) + ZipWriter.le16(0)
        end += ZipWriter.le16(wideEnd ? 65535 : records.count) + ZipWriter.le16(wideEnd ? 65535 : records.count)
        end += ZipWriter.le32(wideEnd ? ZipWriter.u32max : directorySize) + ZipWriter.le32(wideEnd ? ZipWriter.u32max : start) + ZipWriter.le16(0)
        try put(end)
        try handle.close()
        finished = true
    }
}
