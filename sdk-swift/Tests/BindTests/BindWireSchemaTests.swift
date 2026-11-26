import Foundation
import XCTest
@testable import Bind

final class BindWireSchemaTests: XCTestCase {
    override func tearDown() {
        Bind.reset()
        super.tearDown()
    }

    func testBatchProtocolConstantsMatchContract() {
        XCTAssertEqual(BindProtocol.batchPath, "/v1/batch")
        XCTAssertEqual(BindProtocol.batchHTTPMethod, "POST")
        XCTAssertEqual(BindProtocol.authorizationHeader, "Authorization")
        XCTAssertEqual(BindProtocol.contentTypeHeader, "Content-Type")
        XCTAssertEqual(BindProtocol.contentEncodingHeader, "Content-Encoding")
        XCTAssertEqual(BindProtocol.contentTypeJSON, "application/json")
        XCTAssertEqual(BindProtocol.contentEncodingGzip, "gzip")
        XCTAssertEqual(BindProtocol.authorizationValue(ingestKey: "bk_live_123"), "Bearer bk_live_123")
    }

    func testBatchEnvelopeAndFullRecordFieldNamesAndRoundTrip() throws {
        let batchID = try XCTUnwrap(UUID(uuidString: "550E8400-E29B-41D4-A716-446655440000"))
        let ts = try XCTUnwrap(BindTimestamp(decimalNanoseconds: "1795636278123456789"))

        let record = BindRecord(
            ts: ts,
            severity: .info,
            body: .string("order 42 paid 1999"),
            tpl: BindTemplate(strings: ["order ", " paid ", ""], args: [.int(42), .int(1999)]),
            callsite: BindCallsite(
                file: "Checkout/OrderService.swift",
                line: 88,
                column: 12,
                function: "charge(order:)"
            ),
            attrs: ["region": "us-east"],
            traceID: "4bf92f3577b34da6a3ce929d0e0e4736",
            spanID: "00f067aa0ba902b7",
            edge: BindEdgeParse(
                template: "order.paid.v1",
                parserVersion: 3,
                fields: ["order_id": .int(42), "cents": .int(1999)]
            )
        )

        let envelope = BindBatchEnvelope(
            batchID: batchID,
            service: "checkout",
            env: "production",
            release: "2026.11.26+abc1234",
            records: [record],
            dropped: 2
        )

        let jsonData = try envelope.encodeJSON(sortedKeys: true)
        let jsonString = try XCTUnwrap(String(data: jsonData, encoding: .utf8))

        // Verify `#fileID` forward slashes are not escaped as `\/`.
        XCTAssertTrue(jsonString.contains("\"file\":\"Checkout/OrderService.swift\""))

        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: jsonData) as? [String: Any])
        XCTAssertEqual(
            Set(root.keys),
            ["batch_id", "service", "env", "release", "records", "dropped"]
        )
        XCTAssertEqual(root["batch_id"] as? String, "550e8400-e29b-41d4-a716-446655440000")
        XCTAssertEqual(root["service"] as? String, "checkout")
        XCTAssertEqual(root["env"] as? String, "production")
        XCTAssertEqual(root["release"] as? String, "2026.11.26+abc1234")
        XCTAssertEqual(root["dropped"] as? Int, 2)

        let rawRecords = try XCTUnwrap(root["records"] as? [[String: Any]])
        XCTAssertEqual(rawRecords.count, 1)
        let rawRecord = rawRecords[0]
        XCTAssertEqual(
            Set(rawRecord.keys),
            ["ts", "severity", "body", "tpl", "callsite", "attrs", "trace_id", "span_id", "edge"]
        )
        // Server injects project_id and observed_ts; client payload must not emit them.
        XCTAssertNil(rawRecord["project_id"])
        XCTAssertNil(rawRecord["observed_ts"])

        // ts must be a decimal string, not a JSON number.
        XCTAssertEqual(rawRecord["ts"] as? String, "1795636278123456789")
        XCTAssertEqual(rawRecord["severity"] as? Int, 9)
        XCTAssertEqual(rawRecord["body"] as? String, "order 42 paid 1999")

        let rawTpl = try XCTUnwrap(rawRecord["tpl"] as? [String: Any])
        XCTAssertEqual(Set(rawTpl.keys), ["strings", "args"])
        XCTAssertEqual(rawTpl["strings"] as? [String], ["order ", " paid ", ""])

        let rawCallsite = try XCTUnwrap(rawRecord["callsite"] as? [String: Any])
        XCTAssertEqual(Set(rawCallsite.keys), ["file", "line", "column", "function"])
        XCTAssertEqual(rawCallsite["file"] as? String, "Checkout/OrderService.swift")
        XCTAssertEqual(rawCallsite["line"] as? Int, 88)
        XCTAssertEqual(rawCallsite["column"] as? Int, 12)
        XCTAssertEqual(rawCallsite["function"] as? String, "charge(order:)")

        let rawEdge = try XCTUnwrap(rawRecord["edge"] as? [String: Any])
        XCTAssertEqual(Set(rawEdge.keys), ["template", "parser_version", "fields"])
        XCTAssertEqual(rawEdge["template"] as? String, "order.paid.v1")
        XCTAssertEqual(rawEdge["parser_version"] as? Int, 3)

        let decoded = try JSONDecoder().decode(BindBatchEnvelope.self, from: jsonData)
        XCTAssertEqual(decoded, envelope)
    }

    func testBindLogToBatchEnvelopeEndToEndSerialization() throws {
        let sink = BindMemorySink()
        Bind.setSink(sink)

        let id = "ord_99"
        let cents = 2500
        let expectedFile = #fileID
        let expectedFunction = #function
        let expectedLine = UInt(#line) + 1
        Bind.log.info("order \(id) paid \(cents)")

        let envelope = BindBatchEnvelope(
            service: "shop-ios",
            env: "staging",
            release: "1.2.3",
            records: sink.records
        )

        let data = try envelope.encodeJSON()
        let decoded = try JSONDecoder().decode(BindBatchEnvelope.self, from: data)
        XCTAssertEqual(decoded.records.count, 1)

        let record = decoded.records[0]
        XCTAssertEqual(record.severity, .info)
        XCTAssertEqual(record.body, .string("order ord_99 paid 2500"))
        XCTAssertEqual(
            record.tpl,
            BindTemplate(strings: ["order ", " paid ", ""], args: [.string("ord_99"), .int(2500)])
        )
        XCTAssertEqual(record.callsite?.file, expectedFile)
        XCTAssertEqual(record.callsite?.line, expectedLine)
        XCTAssertEqual(record.callsite?.function, expectedFunction)
        XCTAssertGreaterThan(record.ts.seconds, 1_700_000_000)
    }

    func testMinimalRecordAndEnvelopeOmitOptionalFields() throws {
        let record = BindRecord(
            ts: BindTimestamp(seconds: 1_700_000_000, nanoseconds: 0),
            severity: .unspecified,
            body: .object(["ok": .bool(true)])
        )
        let envelope = BindBatchEnvelope(
            service: "api",
            env: "dev",
            release: "0.0.1",
            records: [record]
        )

        let jsonData = try envelope.encodeJSON()
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: jsonData) as? [String: Any])
        XCTAssertEqual(Set(root.keys), ["batch_id", "service", "env", "release", "records"])
        XCTAssertNil(root["dropped"])

        let rawRecord = try XCTUnwrap((root["records"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(rawRecord.keys), ["ts", "severity", "body"])
    }

    func testTimestampPreservesFullNanosecondPrecisionWithoutFloatLoss() throws {
        // 1795636278123456789 exceeds IEEE-754 float64 53-bit exact integer limit (9007199254740991).
        let exactString = "1795636278123456789"
        let ts = try XCTUnwrap(BindTimestamp(decimalNanoseconds: exactString))
        XCTAssertEqual(ts.seconds, 1_795_636_278)
        XCTAssertEqual(ts.nanoseconds, 123_456_789)
        XCTAssertEqual(ts.epochNanoseconds, 1_795_636_278_123_456_789)
        XCTAssertEqual(ts.decimalNanoseconds, exactString)

        // Sub-second padding, zero, negative, and >Int64 future timestamps.
        XCTAssertEqual(BindTimestamp(seconds: 1, nanoseconds: 7).decimalNanoseconds, "1000000007")
        XCTAssertEqual(BindTimestamp(seconds: 0, nanoseconds: 42).decimalNanoseconds, "42")
        XCTAssertEqual(BindTimestamp(seconds: 0, nanoseconds: 0).decimalNanoseconds, "0")
        XCTAssertEqual(BindTimestamp(epochNanoseconds: -1).decimalNanoseconds, "-1")
        XCTAssertEqual(BindTimestamp(epochNanoseconds: -1_500_000_000).decimalNanoseconds, "-1500000000")

        let farFuture = "32503680000123456789"
        let parsedFuture = try XCTUnwrap(BindTimestamp(decimalNanoseconds: farFuture))
        XCTAssertEqual(parsedFuture.decimalNanoseconds, farFuture)
        XCTAssertNil(parsedFuture.epochNanoseconds)

        for valid in ["0", "42", "1000000007", "-1", "-1500000000", exactString, farFuture] {
            let parsed = try XCTUnwrap(BindTimestamp(decimalNanoseconds: valid))
            XCTAssertEqual(parsed.decimalNanoseconds, valid)
        }

        // Reject malformed decimal strings and numeric JSON values.
        for invalid in ["", "-", "1.5", "1e18", " 123", "123 ", "abc"] {
            XCTAssertNil(BindTimestamp(decimalNanoseconds: invalid))
        }
        XCTAssertThrowsError(
            try JSONDecoder().decode(BindTimestamp.self, from: Data("1795636278123456789".utf8))
        )

        // Live wall-clock capture returns a positive decimal integer string.
        let now = BindTimestamp.now()
        XCTAssertGreaterThan(now.seconds, 1_700_000_000)
        XCTAssertTrue(now.decimalNanoseconds.allSatisfy({ $0.isASCII && $0.isNumber }))
    }

    func testSeverityBoundsValidation() throws {
        for raw in UInt8(0)...UInt8(24) {
            let severity = try XCTUnwrap(BindSeverity(rawValue: raw))
            let data = try JSONEncoder().encode(severity)
            let decoded = try JSONDecoder().decode(BindSeverity.self, from: data)
            XCTAssertEqual(decoded, severity)
        }

        XCTAssertNil(BindSeverity(rawValue: 25))
        XCTAssertNil(BindSeverity(rawValue: 255))
        XCTAssertThrowsError(try JSONDecoder().decode(BindSeverity.self, from: Data("25".utf8)))
        XCTAssertThrowsError(try JSONDecoder().decode(BindSeverity.self, from: Data("-1".utf8)))
    }

    func testEnvelopeRejectsNegativeDroppedAndInvalidUUID() {
        let negativeDroppedJSON = """
        {"batch_id":"550e8400-e29b-41d4-a716-446655440000","service":"s","env":"e","release":"r","records":[],"dropped":-1}
        """
        XCTAssertThrowsError(
            try JSONDecoder().decode(BindBatchEnvelope.self, from: Data(negativeDroppedJSON.utf8))
        )

        let badUUIDJSON = """
        {"batch_id":"not-a-uuid","service":"s","env":"e","release":"r","records":[]}
        """
        XCTAssertThrowsError(
            try JSONDecoder().decode(BindBatchEnvelope.self, from: Data(badUUIDJSON.utf8))
        )
    }

    func testBindValueJSONRoundTripDistinguishesBoolAndInt() throws {
        let value: BindValue = [
            "null": nil,
            "bool_true": true,
            "bool_false": false,
            "zero": 0,
            "one": 1,
            "neg": -42,
            "int64_max": .int(Int64.max),
            "uint64_max": .uint(UInt64.max),
            "double": 3.14159,
            "string": "hello",
            "array": [true, 1, 0, false, nil, "x"],
        ]

        let data = try JSONEncoder().encode(value)
        let decoded = try JSONDecoder().decode(BindValue.self, from: data)
        XCTAssertEqual(decoded, value)
    }

    func testConcurrentLoggingIsThreadSafe() async {
        let sink = BindMemorySink()
        let logger = BindLogger(sink: sink)

        await withTaskGroup(of: Void.self) { group in
            for idx in 0..<64 {
                group.addTask {
                    logger.info("worker \(idx) ok=\(true)")
                }
            }
        }

        XCTAssertEqual(sink.records.count, 64)
        let seen = Set(sink.records.compactMap { record -> Int64? in
            if case .int(let idx) = record.tpl?.args.first {
                return idx
            }
            return nil
        })
        XCTAssertEqual(seen.count, 64)
    }
}
