import Foundation
import XCTest
@testable import Bind

final class BindGzipTests: XCTestCase {
    func testEmptySmallRepetitiveAndIncompressibleRoundTrip() throws {
        let repetitiveJSON = String(
            repeating: "{\"ts\":\"1795636278123456789\",\"severity\":9,\"body\":\"order 42 paid 1999\"},",
            count: 200
        )
        // Deterministic pseudo-random incompressible data > 70 KiB (exercises multi-chunk stored blocks).
        var rngState: UInt64 = 0x9E37_79B9_7F4A_7C15
        var randomBytes = [UInt8]()
        randomBytes.reserveCapacity(72_000)
        for _ in 0..<72_000 {
            rngState ^= rngState << 13
            rngState ^= rngState >> 7
            rngState ^= rngState << 17
            randomBytes.append(UInt8(truncatingIfNeeded: rngState))
        }

        let cases: [Data] = [
            Data(),
            Data("hello bind".utf8),
            Data(repetitiveJSON.utf8),
            Data(randomBytes),
        ]

        for payload in cases {
            let platformCompressed = try BindGzip.compress(payload)
            XCTAssertGreaterThanOrEqual(platformCompressed.count, 18)
            XCTAssertEqual(platformCompressed[0], 0x1F)
            XCTAssertEqual(platformCompressed[1], 0x8B)
            XCTAssertEqual(platformCompressed[2], 0x08)

            // Verify platform compress -> platform decompress AND pure-Swift decompress.
            XCTAssertEqual(try BindGzip.decompress(platformCompressed), payload)
            XCTAssertEqual(try BindGzip.decompressPureSwift(platformCompressed), payload)

            // Verify pure-Swift compress (Linux path) -> pure-Swift decompress AND platform decompress.
            let pureCompressed = BindGzip.compressPureSwift(payload)
            XCTAssertEqual(pureCompressed[0], 0x1F)
            XCTAssertEqual(pureCompressed[1], 0x8B)
            XCTAssertEqual(pureCompressed[2], 0x08)
            XCTAssertEqual(try BindGzip.decompressPureSwift(pureCompressed), payload)
            XCTAssertEqual(try BindGzip.decompress(pureCompressed), payload)
        }

        // Verify repetitive JSON actually compresses meaningfully in both encoders.
        let jsonData = Data(repetitiveJSON.utf8)
        XCTAssertLessThan(try BindGzip.compress(jsonData).count, jsonData.count / 4)
        XCTAssertLessThan(BindGzip.compressPureSwift(jsonData).count, jsonData.count / 4)
    }

    func testGzipRejectsCorruptedHeaderCRCAndSize() throws {
        let sample = Data("bind-gzip-integrity-check".utf8)
        var compressed = try BindGzip.compress(sample)

        // Flip a CRC byte in the trailer
        var badCRC = compressed
        badCRC[badCRC.count - 6] ^= 0xFF
        XCTAssertThrowsError(try BindGzip.decompress(badCRC))
        XCTAssertThrowsError(try BindGzip.decompressPureSwift(badCRC))

        // Flip an ISIZE byte in the trailer
        var badSize = compressed
        badSize[badSize.count - 1] ^= 0x01
        XCTAssertThrowsError(try BindGzip.decompress(badSize))
        XCTAssertThrowsError(try BindGzip.decompressPureSwift(badSize))

        // Invalid magic header
        compressed[0] = 0x00
        XCTAssertThrowsError(try BindGzip.decompress(compressed))
        XCTAssertThrowsError(try BindGzip.decompressPureSwift(compressed))
    }

    func testPreparedBatchIsImmutableAndBuildsContractRequest() throws {
        let batchID = try XCTUnwrap(UUID(uuidString: "550E8400-E29B-41D4-A716-446655440000"))
        let ts = try XCTUnwrap(BindTimestamp(decimalNanoseconds: "1795636278123456789"))
        let record = BindRecord(
            ts: ts,
            severity: .info,
            body: .string("order 42 paid 1999"),
            tpl: BindTemplate(strings: ["order ", " paid ", ""], args: [.int(42), .int(1999)])
        )
        let envelope = BindBatchEnvelope(
            batchID: batchID,
            service: "checkout",
            env: "production",
            release: "1.4.0",
            records: [record],
            dropped: 3
        )

        let prepared = try BindPreparedBatch.prepare(envelope: envelope, createdAt: ts)
        XCTAssertEqual(prepared.batchID, batchID)
        XCTAssertEqual(prepared.createdAt, ts)
        XCTAssertEqual(prepared.recordCount, 1)
        XCTAssertEqual(prepared.droppedCount, 3)

        let decompressed = try BindGzip.decompress(prepared.compressedPayload)
        let decoded = try JSONDecoder().decode(BindBatchEnvelope.self, from: decompressed)
        XCTAssertEqual(decoded, envelope)

        let config = BindConfiguration(
            ingestKey: "bk_pub_test_123",
            service: "checkout",
            env: "production",
            release: "1.4.0",
            endpoint: URL(string: "https://ingest.bind.dev")!
        )
        let request = prepared.makeURLRequest(configuration: config)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "https://ingest.bind.dev/v1/batch")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer bk_pub_test_123")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Encoding"), "gzip")
    }

    func testEnvironmentDefaultsAndEndpointNormalization() {
        let env: [String: String] = [
            "BIND_SERVICE": "env-svc",
            "BIND_ENV": "staging",
            "BIND_RELEASE": "2.1.0+deadbeef",
            "BIND_ENDPOINT": "https://ingest.example.com",
        ]
        XCTAssertEqual(
            BindEnvironmentDefaults.resolveService(explicit: nil, environment: env, bundleIdentifier: "com.acme.app"),
            "env-svc"
        )
        XCTAssertEqual(
            BindEnvironmentDefaults.resolveService(explicit: nil, environment: [:], bundleIdentifier: "com.acme.app"),
            "com.acme.app"
        )
        XCTAssertEqual(
            BindEnvironmentDefaults.resolveEnv(explicit: nil, environment: env, bundleEnvironment: nil),
            "staging"
        )
        XCTAssertEqual(
            BindEnvironmentDefaults.resolveRelease(explicit: nil, environment: [:], shortVersion: "3.2.0", buildVersion: "44"),
            "3.2.0+44"
        )
        XCTAssertEqual(
            BindEnvironmentDefaults.resolveEndpoint(explicit: nil, environment: env).absoluteString,
            "https://ingest.example.com"
        )

        XCTAssertEqual(
            BindEnvironmentDefaults.normalizeBatchEndpoint(URL(string: "http://127.0.0.1:8080")!).absoluteString,
            "http://127.0.0.1:8080/v1/batch"
        )
        XCTAssertEqual(
            BindEnvironmentDefaults.normalizeBatchEndpoint(URL(string: "http://127.0.0.1:8080/v1/batch")!).absoluteString,
            "http://127.0.0.1:8080/v1/batch"
        )
    }
}
