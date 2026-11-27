import CoreMedia
import XCTest
@testable import FavecusPlayer

final class PCM16BufferTests: XCTestCase {
    private func block(_ samples: [Int16]) throws -> CMBlockBuffer {
        var buffer: CMBlockBuffer?
        let bytes = samples.count * MemoryLayout<Int16>.size
        XCTAssertEqual(CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: bytes, blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0, dataLength: bytes, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &buffer), kCMBlockBufferNoErr)
        let result = try XCTUnwrap(buffer)
        let status = samples.withUnsafeBufferPointer {
            CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: result, offsetIntoDestination: 0, dataLength: bytes)
        }
        XCTAssertEqual(status, kCMBlockBufferNoErr)
        return result
    }

    func testContiguousAndNoncontiguousSamplesAreAllReadAndWrittenBack() throws {
        let first = try block([100, -200]), second = try block([300, -400])
        var combined: CMBlockBuffer?
        XCTAssertEqual(CMBlockBufferCreateEmpty(allocator: kCFAllocatorDefault, capacity: 2, flags: 0, blockBufferOut: &combined), kCMBlockBufferNoErr)
        let split = try XCTUnwrap(combined)
        for segment in [first, second] {
            XCTAssertEqual(CMBlockBufferAppendBufferReference(split, targetBBuf: segment, offsetToData: 0, dataLength: CMBlockBufferGetDataLength(segment), flags: 0), kCMBlockBufferNoErr)
        }
        XCTAssertFalse(CMBlockBufferIsRangeContiguous(split, atOffset: 0, length: 8))
        let contiguous = try block([100, -200, 300, -400])
        for buffer in [contiguous, split] {
            var read: [Int16] = []
            XCTAssertTrue(PCM16Buffer.withSamples(in: buffer) { read = Array($0) })
            XCTAssertEqual(read, [100, -200, 300, -400])
            XCTAssertTrue(PCM16Buffer.withSamples(in: buffer, writingBack: true) { values in
                for index in values.indices { values[index] /= 2 }
            })
            XCTAssertTrue(PCM16Buffer.withSamples(in: buffer) { read = Array($0) })
            XCTAssertEqual(read, [50, -100, 150, -200])
        }
    }
}
