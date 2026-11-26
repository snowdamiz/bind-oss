import Foundation
import XCTest
@testable import Bind

private struct CustomDescribable: CustomStringConvertible, Sendable {
    let label: String
    var description: String { "custom(\(label))" }
}

private struct PlainPoint: Sendable {
    let x: Int
    let y: Int
}

private struct EncodableOrder: Encodable, Sendable {
    let id: String
    let cents: Int
    let paid: Bool
}

private enum SampleError: Error, CustomStringConvertible {
    case timeout(seconds: Int)

    var description: String {
        switch self {
        case .timeout(let seconds):
            return "timeout(\(seconds)s)"
        }
    }
}

final class BindInterpolationTests: XCTestCase {
    private let fixedClock: @Sendable () -> BindTimestamp = {
        BindTimestamp(seconds: 1_795_636_278, nanoseconds: 123_456_789)
    }

    override func tearDown() {
        Bind.reset()
        super.tearDown()
    }

    func testBindLogInfoCapturesLiteralsTypedArgsAndRenderedBody() {
        let sink = BindMemorySink()
        Bind.setSink(sink)

        let id = "ord_123"
        let cents = 4250
        Bind.log.info("order \(id) paid \(cents)")

        XCTAssertEqual(sink.records.count, 1)
        let record = sink.records[0]
        XCTAssertEqual(record.severity, .info)
        XCTAssertEqual(record.body, .string("order ord_123 paid 4250"))
        XCTAssertEqual(
            record.tpl,
            BindTemplate(
                strings: ["order ", " paid ", ""],
                args: [.string("ord_123"), .int(4250)]
            )
        )
    }

    func testLiteralOnlyAndBoundaryInterpolationsMaintainInvariant() {
        let sink = BindMemorySink()
        let logger = BindLogger(sink: sink, clock: fixedClock)

        let a = "left"
        let b = 7

        logger.info("server started")
        logger.info("")
        logger.info("\(b)")
        logger.info("\(a)\(b)")

        XCTAssertEqual(sink.records.count, 4)

        XCTAssertEqual(sink.records[0].tpl, BindTemplate(strings: ["server started"], args: []))
        XCTAssertEqual(sink.records[0].body, .string("server started"))

        XCTAssertEqual(sink.records[1].tpl, BindTemplate(strings: [""], args: []))
        XCTAssertEqual(sink.records[1].body, .string(""))

        XCTAssertEqual(sink.records[2].tpl, BindTemplate(strings: ["", ""], args: [.int(7)]))
        XCTAssertEqual(sink.records[2].body, .string("7"))

        XCTAssertEqual(
            sink.records[3].tpl,
            BindTemplate(strings: ["", "", ""], args: [.string("left"), .int(7)])
        )
        XCTAssertEqual(sink.records[3].body, .string("left7"))

        for record in sink.records {
            let tpl = try! XCTUnwrap(record.tpl)
            XCTAssertEqual(tpl.strings.count, tpl.args.count + 1)
        }
    }

    func testTypedPrimitiveValuesPreserveJSONTypes() {
        let sink = BindMemorySink()
        let logger = BindLogger(sink: sink, clock: fixedClock)

        let text = "hello"
        let sub: Substring = "world"[...]
        let staticText: StaticString = "static"
        let flag = true
        let i8: Int8 = -8
        let i16: Int16 = -16
        let i32: Int32 = -32
        let i64: Int64 = Int64.min
        let u8: UInt8 = 8
        let u16: UInt16 = 16
        let u32: UInt32 = 32
        let u64Small: UInt64 = 42
        let u64Max: UInt64 = UInt64.max
        let dbl: Double = 3.25
        let flt: Float = 0.5

        logger.debug(
            "s=\(text) sub=\(sub) st=\(staticText) b=\(flag) i8=\(i8) i16=\(i16) i32=\(i32) i64=\(i64) u8=\(u8) u16=\(u16) u32=\(u32) u64s=\(u64Small) u64m=\(u64Max) d=\(dbl) f=\(flt)"
        )

        let record = sink.records[0]
        XCTAssertEqual(record.severity, .debug)
        XCTAssertEqual(
            record.tpl?.args,
            [
                .string("hello"),
                .string("world"),
                .string("static"),
                .bool(true),
                .int(-8),
                .int(-16),
                .int(-32),
                .int(Int64.min),
                .int(8),
                .int(16),
                .int(32),
                .int(42),
                .uint(UInt64.max),
                .double(3.25),
                .double(0.5),
            ]
        )
        XCTAssertEqual(
            record.body,
            .string(
                "s=hello sub=world st=static b=true i8=-8 i16=-16 i32=-32 i64=\(Int64.min) u8=8 u16=16 u32=32 u64s=42 u64m=\(UInt64.max) d=3.25 f=0.5"
            )
        )
    }

    func testFloatRenderingAvoidsDoubleNoise() {
        let sink = BindMemorySink()
        let logger = BindLogger(sink: sink, clock: fixedClock)

        let ratio: Float = 0.1
        logger.info("ratio=\(ratio)")

        XCTAssertEqual(sink.records[0].body, .string("ratio=0.1"))
    }

    func testNonFiniteFloatingPointValuesFallBackToStringsAndEncodeSafely() throws {
        let sink = BindMemorySink()
        let logger = BindLogger(sink: sink, clock: fixedClock)

        let nanVal = Double.nan
        let infVal = Double.infinity
        let negInfVal = -Double.infinity

        logger.warn("nan=\(nanVal) inf=\(infVal) ninf=\(negInfVal)")

        let record = sink.records[0]
        XCTAssertEqual(
            record.tpl?.args,
            [.string("nan"), .string("inf"), .string("-inf")]
        )

        let envelope = BindBatchEnvelope(
            service: "checkout",
            env: "prod",
            release: "1.0.0",
            records: [record]
        )
        let data = try envelope.encodeJSON()
        XCTAssertFalse(data.isEmpty)
    }

    func testOptionalValuesEmitTypedValueOrNull() {
        let sink = BindMemorySink()
        let logger = BindLogger(sink: sink, clock: fixedClock)

        let presentName: String? = "alice"
        let missingName: String? = nil
        let presentCount: Int? = 9
        let missingCount: Int? = nil
        let presentFlag: Bool? = false
        let missingFlag: Bool? = nil
        let presentScore: Double? = 1.5
        let missingScore: Double? = nil
        let missingCustom: CustomDescribable? = nil
        let presentCustom: CustomDescribable? = CustomDescribable(label: "ok")

        logger.info(
            "pn=\(presentName) mn=\(missingName) pc=\(presentCount) mc=\(missingCount) pf=\(presentFlag) mf=\(missingFlag) ps=\(presentScore) ms=\(missingScore) mcust=\(missingCustom) pcust=\(presentCustom)"
        )

        let record = sink.records[0]
        XCTAssertEqual(
            record.tpl?.args,
            [
                .string("alice"),
                .null,
                .int(9),
                .null,
                .bool(false),
                .null,
                .double(1.5),
                .null,
                .null,
                .string("custom(ok)"),
            ]
        )
        XCTAssertEqual(
            record.body,
            .string("pn=alice mn=nil pc=9 mc=nil pf=false mf=nil ps=1.5 ms=nil mcust=nil pcust=custom(ok)")
        )
    }

    func testFoundationCustomAndStructuredJSONInterpolations() throws {
        let sink = BindMemorySink()
        let logger = BindLogger(sink: sink, clock: fixedClock)

        let uuid = try XCTUnwrap(UUID(uuidString: "550E8400-E29B-41D4-A716-446655440000"))
        let url = try XCTUnwrap(URL(string: "https://example.com/orders/42"))
        let err: any Error = SampleError.timeout(seconds: 5)
        let custom = CustomDescribable(label: "alpha")
        let point = PlainPoint(x: 3, y: 4)
        let rawValue: BindValue = ["k": "v", "n": 2]
        let order = EncodableOrder(id: "o1", cents: 500, paid: true)
        let nilOrder: EncodableOrder? = nil

        logger.error(
            "id=\(uuid) url=\(url) err=\(err) c=\(custom) p=\(point) raw=\(rawValue) ord=\(json: order) none=\(json: nilOrder)"
        )

        let record = sink.records[0]
        XCTAssertEqual(record.severity, .error)
        XCTAssertEqual(
            record.tpl?.args,
            [
                .string(uuid.uuidString),
                .string("https://example.com/orders/42"),
                .string("timeout(5s)"),
                .string("custom(alpha)"),
                .string("PlainPoint(x: 3, y: 4)"),
                .object(["k": .string("v"), "n": .int(2)]),
                .object(["id": .string("o1"), "cents": .int(500), "paid": .bool(true)]),
                .null,
            ]
        )
        XCTAssertEqual(
            record.body,
            .string(
                "id=\(uuid.uuidString) url=https://example.com/orders/42 err=timeout(5s) c=custom(alpha) p=PlainPoint(x: 3, y: 4) raw={\"k\":\"v\",\"n\":2} ord={\"cents\":500,\"id\":\"o1\",\"paid\":true} none=nil"
            )
        )
    }

    func testStructuredBodyLoggingOmitsTemplateAndMergesAttrs() {
        let sink = BindMemorySink()
        let baseLogger = BindLogger(sink: sink, clock: fixedClock)
            .with(attrs: ["component": "billing", "region": "us-east"])

        baseLogger.log(
            severity: .info,
            body: ["event": "order.paid", "cents": 1999],
            attrs: ["region": "us-west", "request_id": "req_9"],
            traceID: "4bf92f3577b34da6a3ce929d0e0e4736",
            spanID: "00f067aa0ba902b7"
        )

        XCTAssertEqual(sink.records.count, 1)
        let record = sink.records[0]
        XCTAssertNil(record.tpl)
        XCTAssertEqual(record.body, .object(["event": .string("order.paid"), "cents": .int(1999)]))
        XCTAssertEqual(
            record.attrs,
            ["component": "billing", "region": "us-west", "request_id": "req_9"]
        )
        XCTAssertEqual(record.traceID, "4bf92f3577b34da6a3ce929d0e0e4736")
        XCTAssertEqual(record.spanID, "00f067aa0ba902b7")
    }
}
