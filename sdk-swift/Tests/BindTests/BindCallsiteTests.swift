import XCTest
@testable import Bind

final class BindCallsiteTests: XCTestCase {
    override func tearDown() {
        Bind.reset()
        super.tearDown()
    }

    func testBindLogInfoCapturesFileIDLineAndFunction() {
        let sink = BindMemorySink()
        Bind.setSink(sink)

        let expectedFile = #fileID
        let expectedFunction = #function
        let expectedLine = UInt(#line) + 1
        Bind.log.info("order \(42) paid \(1999)")

        XCTAssertEqual(sink.records.count, 1)
        let callsite = sink.records[0].callsite
        XCTAssertEqual(callsite?.file, expectedFile)
        XCTAssertEqual(callsite?.line, expectedLine)
        XCTAssertEqual(callsite?.function, expectedFunction)
        XCTAssertNil(callsite?.column)
    }

    func testAllSeverityHelpersForwardCallerCallsite() {
        let sink = BindMemorySink()
        let logger = BindLogger(sink: sink)

        let expectedFile = #fileID
        let expectedFunction = #function

        let traceLine = UInt(#line) + 1
        logger.trace("trace \(1)")

        let debugLine = UInt(#line) + 1
        logger.debug("debug \(2)")

        let infoLine = UInt(#line) + 1
        logger.info("info \(3)")

        let noticeLine = UInt(#line) + 1
        logger.notice("notice \(4)")

        let warnLine = UInt(#line) + 1
        logger.warn("warn \(5)")

        let warningLine = UInt(#line) + 1
        logger.warning("warning \(6)")

        let errorLine = UInt(#line) + 1
        logger.error("error \(7)")

        let fatalLine = UInt(#line) + 1
        logger.fatal("fatal \(8)")

        let criticalLine = UInt(#line) + 1
        logger.critical("critical \(9)")

        let bodyLine = UInt(#line) + 1
        logger.log(severity: .info, body: ["k": "v"])

        let expected: [(BindSeverity, UInt)] = [
            (.trace, traceLine),
            (.debug, debugLine),
            (.info, infoLine),
            (.notice, noticeLine),
            (.warn, warnLine),
            (.warn, warningLine),
            (.error, errorLine),
            (.fatal, fatalLine),
            (.fatal, criticalLine),
            (.info, bodyLine),
        ]

        XCTAssertEqual(sink.records.count, expected.count)
        for (record, (expectedSeverity, expectedLine)) in zip(sink.records, expected) {
            XCTAssertEqual(record.severity, expectedSeverity)
            XCTAssertEqual(record.callsite?.file, expectedFile)
            XCTAssertEqual(record.callsite?.line, expectedLine)
            XCTAssertEqual(record.callsite?.function, expectedFunction)
        }
    }

    func testWrapperForwardingPreservesOuterCallsite() {
        let sink = BindMemorySink()
        let logger = BindLogger(sink: sink)

        func appLog(
            _ message: BindMessage,
            file: String = #fileID,
            line: UInt = #line,
            function: String = #function
        ) {
            logger.info(message, file: file, line: line, function: function)
        }

        let expectedFile = #fileID
        let expectedFunction = #function
        let expectedLine = UInt(#line) + 1
        appLog("wrapped \(123)")

        XCTAssertEqual(sink.records.count, 1)
        XCTAssertEqual(sink.records[0].callsite?.file, expectedFile)
        XCTAssertEqual(sink.records[0].callsite?.line, expectedLine)
        XCTAssertEqual(sink.records[0].callsite?.function, expectedFunction)
        XCTAssertEqual(sink.records[0].tpl, BindTemplate(strings: ["wrapped ", ""], args: [.int(123)]))
    }
}
