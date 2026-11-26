import Foundation
#if canImport(Compression)
import Compression
#endif

/// Errors raised during gzip compression or decompression.
public enum BindGzipError: Error, Sendable, Equatable {
    case invalidHeader
    case unsupportedCompressionMethod(UInt8)
    case truncatedData
    case corruptedStream
    case crcMismatch(expected: UInt32, actual: UInt32)
    case sizeMismatch(expected: UInt32, actual: UInt32)
    case compressionFailed
}

/// Zero-dependency RFC 1952 gzip encoder and decoder.
///
/// Uses Apple's `Compression` framework (`COMPRESSION_ZLIB` raw DEFLATE) when available,
/// and a pure-Swift RFC 1951 DEFLATE/INFLATE implementation on Linux and other platforms.
public enum BindGzip {
    private static let crc32Table: [UInt32] = {
        (0..<256).map { index in
            var c = UInt32(index)
            for _ in 0..<8 {
                if (c & 1) != 0 {
                    c = 0xEDB8_8320 ^ (c >> 1)
                } else {
                    c >>= 1
                }
            }
            return c
        }
    }()

    /// Computes the standard IEEE 802.3 CRC-32 checksum used by RFC 1952 gzip.
    public static func crc32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xFFFF_FFFF
        data.withUnsafeBytes { rawBuffer in
            let table = crc32Table
            for byte in rawBuffer {
                let index = Int((crc ^ UInt32(byte)) & 0xFF)
                crc = table[index] ^ (crc >> 8)
            }
        }
        return crc ^ 0xFFFF_FFFF
    }

    /// Compresses `data` into a standard RFC 1952 gzip stream.
    public static func compress(_ data: Data) throws -> Data {
        #if canImport(Compression)
        return try compressWithAppleCompression(data)
        #else
        return compressPureSwift(data)
        #endif
    }

    /// Decompresses a standard RFC 1952 gzip stream, verifying CRC-32 and ISIZE.
    public static func decompress(_ data: Data) throws -> Data {
        #if canImport(Compression)
        return try decompressWithAppleCompression(data)
        #else
        return try decompressPureSwift(data)
        #endif
    }

    // MARK: - RFC 1952 Framing

    private static func wrapGzip(rawDeflate: Data, original: Data) -> Data {
        var result = Data(capacity: 10 + rawDeflate.count + 8)
        // RFC 1952 header: ID1, ID2, CM=deflate(8), FLG=0, MTIME=0, XFL=0, OS=unknown(255)
        result.append(contentsOf: [0x1F, 0x8B, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF])
        result.append(rawDeflate)

        var crc = crc32(original).littleEndian
        var isize = UInt32(truncatingIfNeeded: original.count).littleEndian
        withUnsafeBytes(of: &crc) { result.append(contentsOf: $0) }
        withUnsafeBytes(of: &isize) { result.append(contentsOf: $0) }
        return result
    }

    private struct GzipFrame {
        let deflateOffset: Int
        let deflateEnd: Int
        let expectedCRC: UInt32
        let expectedISize: UInt32
    }

    private static func parseGzipFrame(_ bytes: [UInt8]) throws -> GzipFrame {
        guard bytes.count >= 18 else {
            throw BindGzipError.truncatedData
        }
        guard bytes[0] == 0x1F, bytes[1] == 0x8B else {
            throw BindGzipError.invalidHeader
        }
        guard bytes[2] == 0x08 else {
            throw BindGzipError.unsupportedCompressionMethod(bytes[2])
        }

        let flags = bytes[3]
        var offset = 10
        let trailerStart = bytes.count - 8

        // FEXTRA
        if (flags & 0x04) != 0 {
            guard offset + 2 <= trailerStart else { throw BindGzipError.truncatedData }
            let extraLen = Int(bytes[offset]) | (Int(bytes[offset + 1]) << 8)
            offset += 2 + extraLen
            guard offset <= trailerStart else { throw BindGzipError.truncatedData }
        }
        // FNAME (zero-terminated)
        if (flags & 0x08) != 0 {
            while offset < trailerStart && bytes[offset] != 0 {
                offset += 1
            }
            guard offset < trailerStart else { throw BindGzipError.truncatedData }
            offset += 1
        }
        // FCOMMENT (zero-terminated)
        if (flags & 0x10) != 0 {
            while offset < trailerStart && bytes[offset] != 0 {
                offset += 1
            }
            guard offset < trailerStart else { throw BindGzipError.truncatedData }
            offset += 1
        }
        // FHCRC
        if (flags & 0x02) != 0 {
            offset += 2
            guard offset <= trailerStart else { throw BindGzipError.truncatedData }
        }

        let expectedCRC = UInt32(bytes[trailerStart])
            | (UInt32(bytes[trailerStart + 1]) << 8)
            | (UInt32(bytes[trailerStart + 2]) << 16)
            | (UInt32(bytes[trailerStart + 3]) << 24)
        let expectedISize = UInt32(bytes[trailerStart + 4])
            | (UInt32(bytes[trailerStart + 5]) << 8)
            | (UInt32(bytes[trailerStart + 6]) << 16)
            | (UInt32(bytes[trailerStart + 7]) << 24)

        return GzipFrame(
            deflateOffset: offset,
            deflateEnd: trailerStart,
            expectedCRC: expectedCRC,
            expectedISize: expectedISize
        )
    }

    private static func verifyTrailer(output: Data, frame: GzipFrame) throws {
        let actualCRC = crc32(output)
        guard actualCRC == frame.expectedCRC else {
            throw BindGzipError.crcMismatch(expected: frame.expectedCRC, actual: actualCRC)
        }
        let actualISize = UInt32(truncatingIfNeeded: output.count)
        guard actualISize == frame.expectedISize else {
            throw BindGzipError.sizeMismatch(expected: frame.expectedISize, actual: actualISize)
        }
    }

    // MARK: - Apple Compression Framework Path

    #if canImport(Compression)
    internal static func compressWithAppleCompression(_ data: Data) throws -> Data {
        if data.isEmpty {
            return wrapGzip(rawDeflate: Data([0x03, 0x00]), original: data)
        }
        let rawDeflate = try runAppleCompressionStream(operation: COMPRESSION_STREAM_ENCODE, input: data)
        return wrapGzip(rawDeflate: rawDeflate, original: data)
    }

    internal static func decompressWithAppleCompression(_ data: Data) throws -> Data {
        let bytes = Array(data)
        let frame = try parseGzipFrame(bytes)
        let deflateSlice = Data(bytes[frame.deflateOffset..<frame.deflateEnd])
        let output = try runAppleCompressionStream(operation: COMPRESSION_STREAM_DECODE, input: deflateSlice)
        try verifyTrailer(output: output, frame: frame)
        return output
    }

    private static func runAppleCompressionStream(
        operation: compression_stream_operation,
        input: Data
    ) throws -> Data {
        let dummySrc = UnsafePointer<UInt8>(bitPattern: 1)!
        let dummyDst = UnsafeMutablePointer<UInt8>(bitPattern: 1)!
        var stream = compression_stream(
            dst_ptr: dummyDst,
            dst_size: 0,
            src_ptr: dummySrc,
            src_size: 0,
            state: nil
        )
        let initStatus = compression_stream_init(&stream, operation, COMPRESSION_ZLIB)
        guard initStatus == COMPRESSION_STATUS_OK else {
            throw operation == COMPRESSION_STREAM_ENCODE ? BindGzipError.compressionFailed : BindGzipError.corruptedStream
        }
        defer { compression_stream_destroy(&stream) }

        let chunkSize = 16_384
        let dstBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: chunkSize)
        defer { dstBuffer.deallocate() }

        var output = Data()
        try input.withUnsafeBytes { rawInput in
            let basePtr = rawInput.bindMemory(to: UInt8.self).baseAddress
            stream.src_ptr = basePtr ?? dummySrc
            stream.src_size = rawInput.count

            let flags = Int32(COMPRESSION_STREAM_FINALIZE.rawValue)
            while true {
                stream.dst_ptr = dstBuffer
                stream.dst_size = chunkSize

                let status = compression_stream_process(&stream, flags)
                let produced = chunkSize - stream.dst_size
                if produced > 0 {
                    output.append(dstBuffer, count: produced)
                }

                switch status {
                case COMPRESSION_STATUS_OK:
                    continue
                case COMPRESSION_STATUS_END:
                    return
                default:
                    throw operation == COMPRESSION_STREAM_ENCODE
                        ? BindGzipError.compressionFailed
                        : BindGzipError.corruptedStream
                }
            }
        }
        return output
    }
    #endif

    // MARK: - Pure-Swift RFC 1951 DEFLATE (Linux & Fallback)

    private static let lengthBase: [Int] = [
        3, 4, 5, 6, 7, 8, 9, 10,
        11, 13, 15, 17, 19, 23, 27, 31,
        35, 43, 51, 59, 67, 83, 99, 115,
        131, 163, 195, 227, 258,
    ]
    private static let lengthExtraBits: [Int] = [
        0, 0, 0, 0, 0, 0, 0, 0,
        1, 1, 1, 1, 2, 2, 2, 2,
        3, 3, 3, 3, 4, 4, 4, 4,
        5, 5, 5, 5, 0,
    ]
    private static let distanceBase: [Int] = [
        1, 2, 3, 4, 5, 7, 9, 13,
        17, 25, 33, 49, 65, 97, 129, 193,
        257, 385, 513, 769, 1025, 1537, 2049, 3073,
        4097, 6145, 8193, 12289, 16385, 24577,
    ]
    private static let distanceExtraBits: [Int] = [
        0, 0, 0, 0, 1, 1, 2, 2,
        3, 3, 4, 4, 5, 5, 6, 6,
        7, 7, 8, 8, 9, 9, 10, 10,
        11, 11, 12, 12, 13, 13,
    ]

    /// Pure-Swift RFC 1952 gzip encoder using LZ77 + Fixed Huffman DEFLATE (with stored-block fallback).
    internal static func compressPureSwift(_ data: Data) -> Data {
        if data.isEmpty {
            return wrapGzip(rawDeflate: Data([0x03, 0x00]), original: data)
        }

        let input = Array(data)
        let deflated = deflateFixedHuffman(input)
        // Stored blocks take 5 bytes per 65,535-byte chunk. Use stored if fixed Huffman expanded data.
        let storedOverhead = ((input.count + 65_534) / 65_535) * 5
        let rawDeflate: Data
        if deflated.count > input.count + storedOverhead {
            rawDeflate = deflateStored(input)
        } else {
            rawDeflate = deflated
        }
        return wrapGzip(rawDeflate: rawDeflate, original: data)
    }

    private static func deflateStored(_ input: [UInt8]) -> Data {
        var out = Data(capacity: input.count + 16)
        var offset = 0
        while offset < input.count {
            let chunkLen = min(65_535, input.count - offset)
            let isFinal: UInt8 = (offset + chunkLen == input.count) ? 0x01 : 0x00
            out.append(isFinal) // BFINAL=isFinal, BTYPE=00 (stored)
            let len = UInt16(chunkLen)
            let nlen = ~len
            out.append(UInt8(len & 0xFF))
            out.append(UInt8(len >> 8))
            out.append(UInt8(nlen & 0xFF))
            out.append(UInt8(nlen >> 8))
            out.append(contentsOf: input[offset..<(offset + chunkLen)])
            offset += chunkLen
        }
        return out
    }

    private struct BitWriter {
        var bytes: [UInt8] = []
        var bitBuffer: UInt64 = 0
        var bitCount: Int = 0

        mutating func writeLSB(_ value: UInt32, bits: Int) {
            guard bits > 0 else { return }
            bitBuffer |= UInt64(value) << bitCount
            bitCount += bits
            while bitCount >= 8 {
                bytes.append(UInt8(bitBuffer & 0xFF))
                bitBuffer >>= 8
                bitCount -= 8
            }
        }

        mutating func writeMSB(_ code: UInt32, bits: Int) {
            // Reverse bits so Huffman codes are packed MSB-first into the LSB-first DEFLATE stream.
            var reversed: UInt32 = 0
            var remaining = code
            for _ in 0..<bits {
                reversed = (reversed << 1) | (remaining & 1)
                remaining >>= 1
            }
            writeLSB(reversed, bits: bits)
        }

        mutating func writeFixedLiteralLength(_ symbol: Int) {
            if symbol <= 143 {
                writeMSB(UInt32(0b0011_0000 + symbol), bits: 8)
            } else if symbol <= 255 {
                writeMSB(UInt32(0b1_1001_0000 + (symbol - 144)), bits: 9)
            } else if symbol <= 279 {
                writeMSB(UInt32(symbol - 256), bits: 7)
            } else {
                writeMSB(UInt32(0b1100_0000 + (symbol - 280)), bits: 8)
            }
        }

        mutating func finish() -> Data {
            if bitCount > 0 {
                bytes.append(UInt8(bitBuffer & 0xFF))
                bitBuffer = 0
                bitCount = 0
            }
            return Data(bytes)
        }
    }

    private static func deflateFixedHuffman(_ input: [UInt8]) -> Data {
        var writer = BitWriter()
        writer.bytes.reserveCapacity(max(64, input.count / 2))

        // BFINAL = 1, BTYPE = 01 (fixed Huffman)
        writer.writeLSB(1, bits: 1)
        writer.writeLSB(1, bits: 2)

        let count = input.count
        let hashBits = 15
        let hashSize = 1 << hashBits
        let hashMask = hashSize - 1
        let windowSize = 32_768
        let windowMask = windowSize - 1
        let maxChain = 24
        let maxMatch = 258
        let minMatch = 3

        var head = [Int](repeating: -1, count: hashSize)
        var prev = [Int](repeating: -1, count: windowSize)

        @inline(__always)
        func hash3(_ index: Int) -> Int {
            let h = (Int(input[index]) << 10) ^ (Int(input[index + 1]) << 5) ^ Int(input[index + 2])
            return h & hashMask
        }

        @inline(__always)
        func insertHash(_ index: Int) {
            guard index + 2 < count else { return }
            let h = hash3(index)
            prev[index & windowMask] = head[h]
            head[h] = index
        }

        var pos = 0
        while pos < count {
            var bestLen = 0
            var bestDist = 0

            if pos + minMatch <= count {
                let h = hash3(pos)
                var candidate = head[h]
                var chain = maxChain
                let minPos = max(0, pos - windowSize)
                let limit = min(maxMatch, count - pos)

                while candidate >= minPos && chain > 0 {
                    chain -= 1
                    let dist = pos - candidate
                    if dist > 0 && dist <= windowSize {
                        if bestLen == 0 || input[candidate + bestLen] == input[pos + bestLen] {
                            var matchLen = 0
                            while matchLen < limit && input[candidate + matchLen] == input[pos + matchLen] {
                                matchLen += 1
                            }
                            if matchLen > bestLen {
                                bestLen = matchLen
                                bestDist = dist
                                if bestLen == limit {
                                    break
                                }
                            }
                        }
                    }
                    let nextCandidate = prev[candidate & windowMask]
                    if nextCandidate >= candidate {
                        break
                    }
                    candidate = nextCandidate
                }
            }

            if bestLen >= minMatch {
                // Emit length symbol
                let lenIdx = lengthCodeIndex(for: bestLen)
                writer.writeFixedLiteralLength(257 + lenIdx)
                let lenExtra = lengthExtraBits[lenIdx]
                if lenExtra > 0 {
                    writer.writeLSB(UInt32(bestLen - lengthBase[lenIdx]), bits: lenExtra)
                }

                // Emit distance symbol (5-bit fixed Huffman code, MSB-first)
                let distIdx = distanceCodeIndex(for: bestDist)
                writer.writeMSB(UInt32(distIdx), bits: 5)
                let distExtra = distanceExtraBits[distIdx]
                if distExtra > 0 {
                    writer.writeLSB(UInt32(bestDist - distanceBase[distIdx]), bits: distExtra)
                }

                for i in 0..<bestLen {
                    insertHash(pos + i)
                }
                pos += bestLen
            } else {
                writer.writeFixedLiteralLength(Int(input[pos]))
                insertHash(pos)
                pos += 1
            }
        }

        // End-of-block symbol (256)
        writer.writeFixedLiteralLength(256)
        return writer.finish()
    }

    private static func lengthCodeIndex(for length: Int) -> Int {
        if length == 258 { return 28 }
        for idx in 0..<28 {
            if length >= lengthBase[idx] && length < lengthBase[idx + 1] {
                return idx
            }
        }
        return 28
    }

    private static func distanceCodeIndex(for distance: Int) -> Int {
        var low = 0
        var high = distanceBase.count - 1
        while low < high {
            let mid = (low + high + 1) / 2
            if distanceBase[mid] <= distance {
                low = mid
            } else {
                high = mid - 1
            }
        }
        return low
    }

    // MARK: - Pure-Swift RFC 1951 INFLATE (Linux & Cross-Check)

    private struct BitReader {
        let bytes: [UInt8]
        let end: Int
        var byteIndex: Int
        var bitBuffer: UInt64 = 0
        var bitCount: Int = 0

        init(bytes: [UInt8], offset: Int, end: Int) {
            self.bytes = bytes
            self.byteIndex = offset
            self.end = end
        }

        mutating func ensureBits(_ count: Int) throws {
            while bitCount < count {
                guard byteIndex < end else {
                    throw BindGzipError.truncatedData
                }
                bitBuffer |= UInt64(bytes[byteIndex]) << bitCount
                byteIndex += 1
                bitCount += 8
            }
        }

        mutating func readBits(_ count: Int) throws -> Int {
            guard count > 0 else { return 0 }
            try ensureBits(count)
            let mask = (UInt64(1) << count) - 1
            let value = Int(bitBuffer & mask)
            bitBuffer >>= count
            bitCount -= count
            return value
        }

        mutating func alignToByte() {
            let discard = bitCount & 7
            bitBuffer >>= discard
            bitCount -= discard
        }

        mutating func readUInt16LE() throws -> UInt16 {
            let lo = try readBits(8)
            let hi = try readBits(8)
            return UInt16(lo | (hi << 8))
        }

        mutating func readExactBytes(_ count: Int) throws -> [UInt8] {
            var out = [UInt8]()
            out.reserveCapacity(count)
            var remaining = count
            while remaining > 0 && bitCount >= 8 {
                out.append(UInt8(bitBuffer & 0xFF))
                bitBuffer >>= 8
                bitCount -= 8
                remaining -= 1
            }
            guard byteIndex + remaining <= end else {
                throw BindGzipError.truncatedData
            }
            if remaining > 0 {
                out.append(contentsOf: bytes[byteIndex..<(byteIndex + remaining)])
                byteIndex += remaining
            }
            return out
        }
    }

    private struct HuffmanTree {
        // Maps (bitLength, code) via canonical decoding tables
        let counts: [Int]
        let symbols: [Int]
        let maxBits: Int

        init(codeLengths: [Int]) throws {
            let maxLen = codeLengths.max() ?? 0
            guard maxLen <= 15 else {
                throw BindGzipError.corruptedStream
            }
            self.maxBits = maxLen

            var blCount = [Int](repeating: 0, count: maxLen + 1)
            for len in codeLengths where len > 0 {
                blCount[len] += 1
            }

            var offsets = [Int](repeating: 0, count: maxLen + 1)
            var total = 0
            if maxLen >= 1 {
                for bits in 1...maxLen {
                    offsets[bits] = total
                    total += blCount[bits]
                }
            }

            var syms = [Int](repeating: 0, count: total)
            for (symbol, len) in codeLengths.enumerated() where len > 0 {
                syms[offsets[len]] = symbol
                offsets[len] += 1
            }

            self.counts = blCount
            self.symbols = syms
        }

        func decode(_ reader: inout BitReader) throws -> Int {
            var code = 0
            var first = 0
            var index = 0
            guard maxBits >= 1 else {
                throw BindGzipError.corruptedStream
            }
            for len in 1...maxBits {
                code = (code << 1) | (try reader.readBits(1))
                let count = counts[len]
                if code - count < first {
                    return symbols[index + (code - first)]
                }
                index += count
                first = (first + count) << 1
            }
            throw BindGzipError.corruptedStream
        }
    }

    private static let fixedLitLenTree: HuffmanTree = {
        var lengths = [Int](repeating: 0, count: 288)
        for i in 0...143 { lengths[i] = 8 }
        for i in 144...255 { lengths[i] = 9 }
        for i in 256...279 { lengths[i] = 7 }
        for i in 280...287 { lengths[i] = 8 }
        return try! HuffmanTree(codeLengths: lengths)
    }()

    private static let fixedDistTree: HuffmanTree = {
        try! HuffmanTree(codeLengths: [Int](repeating: 5, count: 32))
    }()

    private static let codeLengthOrder: [Int] = [
        16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
    ]

    /// Pure-Swift RFC 1952 gzip decoder supporting stored, fixed, and dynamic Huffman blocks.
    internal static func decompressPureSwift(_ data: Data) throws -> Data {
        let bytes = Array(data)
        let frame = try parseGzipFrame(bytes)
        var reader = BitReader(bytes: bytes, offset: frame.deflateOffset, end: frame.deflateEnd)
        var output: [UInt8] = []
        output.reserveCapacity(min(Int(frame.expectedISize), 1_048_576))

        var isFinal = false
        while !isFinal {
            isFinal = (try reader.readBits(1)) != 0
            let blockType = try reader.readBits(2)

            switch blockType {
            case 0:
                // Stored (uncompressed) block
                reader.alignToByte()
                let len = try reader.readUInt16LE()
                let nlen = try reader.readUInt16LE()
                guard len == ~nlen else {
                    throw BindGzipError.corruptedStream
                }
                let raw = try reader.readExactBytes(Int(len))
                output.append(contentsOf: raw)

            case 1:
                // Fixed Huffman block
                try decodeHuffmanBlock(
                    reader: &reader,
                    litLenTree: fixedLitLenTree,
                    distTree: fixedDistTree,
                    output: &output
                )

            case 2:
                // Dynamic Huffman block
                let hlit = try reader.readBits(5) + 257
                let hdist = try reader.readBits(5) + 1
                let hclen = try reader.readBits(4) + 4
                guard hlit <= 286, hdist <= 30 else {
                    throw BindGzipError.corruptedStream
                }

                var clLengths = [Int](repeating: 0, count: 19)
                for i in 0..<hclen {
                    clLengths[codeLengthOrder[i]] = try reader.readBits(3)
                }
                let clTree = try HuffmanTree(codeLengths: clLengths)

                var lengths: [Int] = []
                lengths.reserveCapacity(hlit + hdist)
                while lengths.count < hlit + hdist {
                    let sym = try clTree.decode(&reader)
                    if sym < 16 {
                        lengths.append(sym)
                    } else if sym == 16 {
                        guard let prevLen = lengths.last else {
                            throw BindGzipError.corruptedStream
                        }
                        let repeatCount = try reader.readBits(2) + 3
                        lengths.append(contentsOf: repeatElement(prevLen, count: repeatCount))
                    } else if sym == 17 {
                        let repeatCount = try reader.readBits(3) + 3
                        lengths.append(contentsOf: repeatElement(0, count: repeatCount))
                    } else if sym == 18 {
                        let repeatCount = try reader.readBits(7) + 11
                        lengths.append(contentsOf: repeatElement(0, count: repeatCount))
                    } else {
                        throw BindGzipError.corruptedStream
                    }
                }
                guard lengths.count == hlit + hdist else {
                    throw BindGzipError.corruptedStream
                }

                let litLenTree = try HuffmanTree(codeLengths: Array(lengths[0..<hlit]))
                let distTree = try HuffmanTree(codeLengths: Array(lengths[hlit..<(hlit + hdist)]))
                try decodeHuffmanBlock(
                    reader: &reader,
                    litLenTree: litLenTree,
                    distTree: distTree,
                    output: &output
                )

            default:
                throw BindGzipError.corruptedStream
            }
        }

        let result = Data(output)
        try verifyTrailer(output: result, frame: frame)
        return result
    }

    private static func decodeHuffmanBlock(
        reader: inout BitReader,
        litLenTree: HuffmanTree,
        distTree: HuffmanTree,
        output: inout [UInt8]
    ) throws {
        while true {
            let symbol = try litLenTree.decode(&reader)
            if symbol < 256 {
                output.append(UInt8(symbol))
            } else if symbol == 256 {
                return
            } else {
                let lenIdx = symbol - 257
                guard lenIdx >= 0 && lenIdx < lengthBase.count else {
                    throw BindGzipError.corruptedStream
                }
                let length = lengthBase[lenIdx] + (try reader.readBits(lengthExtraBits[lenIdx]))

                let distIdx = try distTree.decode(&reader)
                guard distIdx >= 0 && distIdx < distanceBase.count else {
                    throw BindGzipError.corruptedStream
                }
                let distance = distanceBase[distIdx] + (try reader.readBits(distanceExtraBits[distIdx]))
                guard distance > 0 && distance <= output.count else {
                    throw BindGzipError.corruptedStream
                }

                for _ in 0..<length {
                    let byte = output[output.count - distance]
                    output.append(byte)
                }
            }
        }
    }
}
