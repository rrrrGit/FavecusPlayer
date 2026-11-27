import CoreMedia

/// PCMの分割された領域を1本のポインターとして扱わない。コピー先もInt16の境界に揃える。
enum PCM16Buffer {
    @discardableResult
    static func withSamples(in block: CMBlockBuffer, writingBack: Bool = false, _ body: (UnsafeMutableBufferPointer<Int16>) -> Void) -> Bool {
        var lengthAtOffset = 0
        var totalLength = 0
        var pointer: UnsafeMutablePointer<Int8>?
        let status = CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: &lengthAtOffset, totalLengthOut: &totalLength, dataPointerOut: &pointer)
        let byteCount = CMBlockBufferGetDataLength(block)
        guard byteCount > 0, byteCount % MemoryLayout<Int16>.size == 0 else { return false }
        let count = byteCount / MemoryLayout<Int16>.size
        if status == kCMBlockBufferNoErr, lengthAtOffset == totalLength, totalLength == byteCount, let pointer,
           Int(bitPattern: pointer) % MemoryLayout<Int16>.alignment == 0 {
            pointer.withMemoryRebound(to: Int16.self, capacity: count) {
                body(UnsafeMutableBufferPointer(start: $0, count: count))
            }
            return true
        }
        var samples = [Int16](repeating: 0, count: count)
        return samples.withUnsafeMutableBufferPointer { values in
            guard let base = values.baseAddress,
                  CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: byteCount, destination: base) == kCMBlockBufferNoErr else { return false }
            body(values)
            return !writingBack || CMBlockBufferReplaceDataBytes(with: base, blockBuffer: block, offsetIntoDestination: 0, dataLength: byteCount) == kCMBlockBufferNoErr
        }
    }
}
