import Foundation
import XCTest
@testable import Bind
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class BindTransportAndQueueTests: XCTestCase {
    private var tempDirs: [URL] = []

    override func tearDown() {
        Bind.reset()
        for dir in tempDirs {
            try? FileManager.default.removeItem(at: dir)
        }
        tempDirs.removeAll()
        super.tearDown()
    }

    private func makeTempDir() -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("bind-tests-\(UUID().uuidString)", isDirectory: true)
        tempDirs.append(dir)
        return dir
    }

    private func waitForDiagnostics(
        of client: BindClient,
        timeout: TimeInterval = 3.0,
        matching predicate: @Sendable (BindClientDiagnostics) -> Bool
    ) async -> BindClientDiagnostics {
        let deadline = Date().addingTimeInterval(timeout)
        var latest = await client.diagnostics()
        while Date() < deadline && !predicate(latest) {
            try? await Task.sleep(nanoseconds: 15_000_000)
            latest = await client.diagnostics()
        }
        return latest
    }

    func testBindStartEndToEndWithLocalFakeServer() async throws {
        let server = try FakeBindServer()
        defer { server.stop() }

        let dir = makeTempDir()
        Bind.start(
            key: "bk_pub_e2e_key",
            service: "shop-ios",
            env: "staging",
            release: "2.3.1+89",
            endpoint: server.baseURL,
            offlineQueue: BindOfflineQueueConfiguration(isEnabled: true, directory: dir)
        )

        let orderID = "ord_771"
        let cents = 4299
        Bind.log.info("order \(orderID) paid \(cents)", attrs: ["screen": "checkout"])
        await Bind.flush()

        let received = await server.waitForRequests(count: 1)
        XCTAssertTrue(received)

        let req = try XCTUnwrap(server.requests.first)
        XCTAssertEqual(req.method, "POST")
        XCTAssertEqual(req.path, "/v1/batch")
        XCTAssertEqual(req.headers["authorization"], "Bearer bk_pub_e2e_key")
        XCTAssertEqual(req.headers["content-type"], "application/json")
        XCTAssertEqual(req.headers["content-encoding"], "gzip")
        // Verify raw body is genuine RFC 1952 gzip
        XCTAssertEqual(req.rawBody.prefix(2), Data([0x1F, 0x8B]))

        let envelope = try XCTUnwrap(req.envelope)
        XCTAssertEqual(envelope.service, "shop-ios")
        XCTAssertEqual(envelope.env, "staging")
        XCTAssertEqual(envelope.release, "2.3.1+89")
        XCTAssertNil(envelope.dropped)
        XCTAssertEqual(envelope.records.count, 1)

        let record = envelope.records[0]
        XCTAssertEqual(record.severity, .info)
        XCTAssertEqual(record.body, .string("order ord_771 paid 4299"))
        XCTAssertEqual(
            record.tpl,
            BindTemplate(strings: ["order ", " paid ", ""], args: [.string("ord_771"), .int(4299)])
        )
        XCTAssertEqual(record.attrs, ["screen": "checkout"])
        XCTAssertNotNil(record.callsite)
        XCTAssertGreaterThan(record.ts.seconds, 1_700_000_000)

        await Bind.shutdown()
    }

    func testFlushTriggerAt500Records() async throws {
        let server = try FakeBindServer()
        defer { server.stop() }

        let monitor = BindManualEnvironmentMonitor(initial: BindUploadConditions(isOnline: true))
        let config = BindConfiguration(
            ingestKey: "bk_500",
            service: "svc",
            env: "test",
            release: "1.0.0",
            endpoint: server.baseURL,
            maxBatchRecords: 500,
            maxBatchCompressedBytes: 256 * 1024,
            flushInterval: 60.0, // Long timer so only the 500-record count trigger fires.
            offlineQueue: BindOfflineQueueConfiguration(isEnabled: true, directory: makeTempDir()),
            enableLifecycleFlush: false
        )
        let client = BindClient(configuration: config, environmentMonitor: monitor)
        let logger = BindLogger(sink: client)

        for idx in 0..<500 {
            logger.info("event \(idx)")
        }

        let gotBatch = await server.waitForRequests(count: 1, timeout: 5.0)
        XCTAssertTrue(gotBatch)
        XCTAssertEqual(server.requests.count, 1)
        XCTAssertEqual(server.requests[0].envelope?.records.count, 500)

        await client.shutdown()
    }

    func testFlushTriggerAt256KiBCompressedAndSplitsOversizedBatches() async throws {
        let server = try FakeBindServer()
        defer { server.stop() }

        let monitor = BindManualEnvironmentMonitor(initial: BindUploadConditions(isOnline: true))
        let config = BindConfiguration(
            ingestKey: "bk_256k",
            service: "svc",
            env: "test",
            release: "1.0.0",
            endpoint: server.baseURL,
            maxBatchRecords: 500,
            maxBatchCompressedBytes: 256 * 1024,
            flushInterval: 60.0, // Long timer so only compressed size triggers flush.
            maxMemoryQueueBytes: 8 * 1024 * 1024,
            offlineQueue: BindOfflineQueueConfiguration(isEnabled: true, directory: makeTempDir()),
            enableLifecycleFlush: false
        )
        let client = BindClient(configuration: config, environmentMonitor: monitor)
        let logger = BindLogger(sink: client)

        // Generate 16 incompressible ~24 KiB records (~384 KiB compressed total, well under 500 records).
        // Each record uses unique deterministic base64-encoded pseudo-random bytes so gzip cannot shrink it below 256 KiB.
        var rng: UInt64 = 0x1234_5678_9ABC_DEF0
        let totalRecords = 16
        for idx in 0..<totalRecords {
            var bytes = [UInt8]()
            bytes.reserveCapacity(18_000)
            for _ in 0..<18_000 {
                rng ^= rng << 13
                rng ^= rng >> 7
                rng ^= rng << 17
                bytes.append(UInt8(truncatingIfNeeded: rng))
            }
            let payload = Data(bytes).base64EncodedString() // ~24,000 incompressible ASCII chars
            logger.info("blob \(idx) \(payload)")
        }

        // At least 1 batch must have flushed automatically due to reaching 256 KiB compressed.
        let autoFlushed = await server.waitForRequests(count: 1, timeout: 5.0)
        XCTAssertTrue(autoFlushed, "Expected automatic flush at 256 KiB compressed before 500 records or timer")

        // Flush remaining records.
        await client.flush()

        let requests = server.requests
        XCTAssertGreaterThanOrEqual(requests.count, 2, "384 KiB incompressible should split into >=2 batches")

        var seenIndices = Set<Int64>()
        for req in requests {
            let env = try XCTUnwrap(req.envelope)
            if env.records.count > 1 {
                XCTAssertLessThanOrEqual(
                    req.rawBody.count,
                    256 * 1024,
                    "Every multi-record batch must fit within 256 KiB compressed"
                )
            }
            for rec in env.records {
                if case .int(let idx) = rec.tpl?.args.first {
                    seenIndices.insert(idx)
                }
            }
        }
        XCTAssertEqual(seenIndices.count, totalRecords)

        await client.shutdown()
    }

    func testFlushTriggerOnTimerInterval() async throws {
        let server = try FakeBindServer()
        defer { server.stop() }

        let monitor = BindManualEnvironmentMonitor(initial: BindUploadConditions(isOnline: true))
        let config = BindConfiguration(
            ingestKey: "bk_timer",
            service: "svc",
            env: "test",
            release: "1.0.0",
            endpoint: server.baseURL,
            maxBatchRecords: 500,
            maxBatchCompressedBytes: 256 * 1024,
            flushInterval: 0.2,
            offlineQueue: BindOfflineQueueConfiguration(isEnabled: true, directory: makeTempDir()),
            enableLifecycleFlush: false
        )
        let client = BindClient(configuration: config, environmentMonitor: monitor)
        let logger = BindLogger(sink: client)

        logger.info("single timed record")

        let received = await server.waitForRequests(count: 1, timeout: 3.0)
        XCTAssertTrue(received)
        XCTAssertEqual(server.requests.first?.envelope?.records.count, 1)

        await client.shutdown()
    }

    func testBoundedMemoryDropsOldestDebugFirstAndReportsDropCount() async throws {
        let server = try FakeBindServer()
        defer { server.stop() }

        // Measure a representative record from this callsite so the cap fits exactly 4 records.
        let sampleSink = BindMemorySink()
        let sampleLogger = BindLogger(sink: sampleSink)
        sampleLogger.info("sample")
        let perRecordBytes = BindMemoryQueue.estimateByteSize(of: sampleSink.records[0])
        let fourRecordCap = perRecordBytes * 4 + 32

        // Keep client offline so records stay in memory queue without sealing yet.
        let monitor = BindManualEnvironmentMonitor(initial: BindUploadConditions(isOnline: false))
        let config = BindConfiguration(
            ingestKey: "bk_mem",
            service: "svc",
            env: "test",
            release: "1.0.0",
            endpoint: server.baseURL,
            maxBatchRecords: 500,
            maxBatchCompressedBytes: 256 * 1024,
            flushInterval: 60.0,
            maxMemoryQueueBytes: fourRecordCap,
            offlineQueue: BindOfflineQueueConfiguration(isEnabled: true, directory: makeTempDir()),
            enableLifecycleFlush: false
        )
        let client = BindClient(configuration: config, environmentMonitor: monitor)
        let logger = BindLogger(sink: client)

        // Fill 4 slots: [dbg-1, info-1, dbg-2, err-1]
        logger.debug("dbg-1")
        logger.info("info-1")
        logger.debug("dbg-2")
        logger.error("err-1")
        // Push 2 more non-debug records: must evict dbg-1 then dbg-2 (oldest debug first).
        logger.warn("warn-1")
        logger.error("err-2")
        // Incoming debug record when queue holds only info/warn/error must be dropped without evicting info/error.
        logger.debug("dbg-3-incoming")

        let diagBeforeFlush = await client.diagnostics()
        XCTAssertEqual(diagBeforeFlush.pendingDroppedRecords, 3)

        // Go online and flush; dropped count must be reported on this batch.
        monitor.setOnline(true)
        await client.flush()

        let gotFirst = await server.waitForRequests(count: 1)
        XCTAssertTrue(gotFirst)

        let firstEnvelope = try XCTUnwrap(server.requests[0].envelope)
        XCTAssertEqual(firstEnvelope.dropped, 3)

        let bodies = firstEnvelope.records.compactMap { record -> String? in
            if case .string(let s) = record.body { return s }
            return nil
        }
        // All 4 higher-severity records survive; all 3 debug records were dropped.
        XCTAssertEqual(bodies, ["info-1", "err-1", "warn-1", "err-2"])

        // Next batch with no new drops must omit `dropped` (`nil`).
        logger.info("after-recovery")
        await client.flush()

        let gotSecond = await server.waitForRequests(count: 2)
        XCTAssertTrue(gotSecond)
        XCTAssertNil(server.requests[1].envelope?.dropped)

        await client.shutdown()
    }

    func testRetries429And503HonorRetryAfterAndPreserveImmutableBatchIDAndBytes() async throws {
        let server = try FakeBindServer()
        defer { server.stop() }

        // Script: 429 (Retry-After: 0.25) -> 503 (Retry-After: 0.25) -> 502 -> 504 -> 200
        server.enqueueResponses([
            FakeServerResponse(statusCode: 429, headers: ["Retry-After": "0.25"], body: "{\"error\":\"rate\"}"),
            FakeServerResponse(statusCode: 503, headers: ["Retry-After": "0.25"], body: "{\"error\":\"overloaded\"}"),
            FakeServerResponse(statusCode: 502, body: "{\"error\":\"bad_gw\"}"),
            FakeServerResponse(statusCode: 504, body: "{\"error\":\"timeout\"}"),
            FakeServerResponse(statusCode: 200, body: "{\"ok\":true}"),
        ])

        let monitor = BindManualEnvironmentMonitor(initial: BindUploadConditions(isOnline: true))
        let config = BindConfiguration(
            ingestKey: "bk_retry",
            service: "svc",
            env: "test",
            release: "1.0.0",
            endpoint: server.baseURL,
            flushInterval: 60.0,
            offlineQueue: BindOfflineQueueConfiguration(isEnabled: true, directory: makeTempDir()),
            retry: BindRetryConfiguration(baseDelay: 0.05, maxDelay: 0.2, jitterFactor: 0.0, maxRetryAfter: 10.0),
            enableLifecycleFlush: false
        )
        let client = BindClient(
            configuration: config,
            environmentMonitor: monitor,
            randomUnit: { 1.0 }
        )
        let logger = BindLogger(sink: client)
        logger.info("retryable payload \(42)")

        await client.flush()

        let allFive = await server.waitForRequests(count: 5, timeout: 6.0)
        XCTAssertTrue(allFive, "Expected 5 total attempts (429, 503, 502, 504, 200); got \(server.requests.count)")

        let reqs = server.requests
        XCTAssertEqual(reqs.count, 5)
        XCTAssertEqual(reqs.map(\.statusCodeSent), [429, 503, 502, 504, 200])

        // Every retry MUST reuse the exact same batch_id AND exact same immutable compressed bytes.
        let firstBatchID = try XCTUnwrap(reqs[0].envelope?.batchID)
        let firstRawBytes = reqs[0].rawBody
        for req in reqs.dropFirst() {
            XCTAssertEqual(req.envelope?.batchID, firstBatchID)
            XCTAssertEqual(req.rawBody, firstRawBytes)
        }

        // Verify Retry-After delays (~0.25s each) were honored between req 0->1 and req 1->2.
        let gap1 = reqs[1].receivedAt.timeIntervalSince(reqs[0].receivedAt)
        let gap2 = reqs[2].receivedAt.timeIntervalSince(reqs[1].receivedAt)
        XCTAssertGreaterThanOrEqual(gap1, 0.20, "Expected Retry-After delay >= 0.20s after 429, got \(gap1)")
        XCTAssertGreaterThanOrEqual(gap2, 0.20, "Expected Retry-After delay >= 0.20s after 503, got \(gap2)")

        // Wait for the client to finish processing the 200 OK response and delete the disk file.
        let diag = await waitForDiagnostics(of: client) {
            $0.totalBatchesSucceeded == 1 && $0.diskQueuedBatches == 0
        }
        XCTAssertEqual(diag.totalBatchesSucceeded, 1)
        XCTAssertEqual(diag.totalBatchesRetried, 4)
        XCTAssertEqual(diag.diskQueuedBatches, 0)

        await client.shutdown()
    }

    func testNetworkTimeoutAndDisconnectRetryWithSameBatchID() async throws {
        let server = try FakeBindServer()
        defer { server.stop() }

        // First request: server drops connection without response; second: timeout; third: 200 OK.
        server.enqueueResponses([
            FakeServerResponse(statusCode: 200, closeWithoutResponse: true),
            FakeServerResponse(statusCode: 200, delaySeconds: 0.6),
            FakeServerResponse(statusCode: 200),
        ])

        let monitor = BindManualEnvironmentMonitor(initial: BindUploadConditions(isOnline: true))
        let config = BindConfiguration(
            ingestKey: "bk_net",
            service: "svc",
            env: "test",
            release: "1.0.0",
            endpoint: server.baseURL,
            flushInterval: 60.0,
            offlineQueue: BindOfflineQueueConfiguration(isEnabled: true, directory: makeTempDir()),
            retry: BindRetryConfiguration(
                baseDelay: 0.05,
                maxDelay: 0.1,
                jitterFactor: 0.0,
                requestTimeout: 0.25
            ),
            enableLifecycleFlush: false
        )
        let client = BindClient(configuration: config, environmentMonitor: monitor, randomUnit: { 1.0 })
        let logger = BindLogger(sink: client)
        logger.warn("network glitch test")

        await client.flush()

        let received3 = await server.waitForRequests(count: 3, timeout: 6.0)
        XCTAssertTrue(received3, "Expected 3 attempts after disconnect and timeout; got \(server.requests.count)")

        let reqs = server.requests
        let expectedBatchID = try XCTUnwrap(reqs[0].envelope?.batchID)
        XCTAssertEqual(reqs[1].envelope?.batchID, expectedBatchID)
        XCTAssertEqual(reqs[2].envelope?.batchID, expectedBatchID)
        XCTAssertEqual(reqs[2].statusCodeSent, 200)

        let diag = await waitForDiagnostics(of: client) {
            $0.totalBatchesSucceeded == 1 && $0.diskQueuedBatches == 0
        }
        XCTAssertEqual(diag.totalBatchesSucceeded, 1)
        XCTAssertEqual(diag.diskQueuedBatches, 0)

        await client.shutdown()
    }

    func testNonRetryableStatusesAreDroppedWithoutRetrying() async throws {
        let server = try FakeBindServer()
        defer { server.stop() }

        server.enqueueResponses([
            FakeServerResponse(statusCode: 401, body: "{\"error\":\"unauthorized\"}"),
            FakeServerResponse(statusCode: 400, body: "{\"error\":\"bad_request\"}"),
            FakeServerResponse(statusCode: 500, body: "{\"error\":\"internal\"}"),
        ])

        let monitor = BindManualEnvironmentMonitor(initial: BindUploadConditions(isOnline: true))
        let config = BindConfiguration(
            ingestKey: "bk_bad",
            service: "svc",
            env: "test",
            release: "1.0.0",
            endpoint: server.baseURL,
            flushInterval: 60.0,
            offlineQueue: BindOfflineQueueConfiguration(isEnabled: true, directory: makeTempDir()),
            retry: BindRetryConfiguration(baseDelay: 0.05, maxDelay: 0.1),
            enableLifecycleFlush: false
        )
        let client = BindClient(configuration: config, environmentMonitor: monitor)
        let logger = BindLogger(sink: client)

        for code in [401, 400, 500] {
            logger.info("non-retryable \(code)")
            await client.flush()
        }

        // Allow brief settle to verify no background retries occur.
        try? await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertEqual(server.requests.count, 3)
        let diag = await client.diagnostics()
        XCTAssertEqual(diag.totalBatchesDroppedPermanent, 3)
        XCTAssertEqual(diag.totalBatchesRetried, 0)
        XCTAssertEqual(diag.diskQueuedBatches, 0)

        await client.shutdown()
    }

    func testRetryPolicyBackoffJitterAndRetryAfterParsing() {
        XCTAssertTrue(BindRetryPolicy.isRetryable(statusCode: 429))
        XCTAssertTrue(BindRetryPolicy.isRetryable(statusCode: 502))
        XCTAssertTrue(BindRetryPolicy.isRetryable(statusCode: 503))
        XCTAssertTrue(BindRetryPolicy.isRetryable(statusCode: 504))
        XCTAssertFalse(BindRetryPolicy.isRetryable(statusCode: 400))
        XCTAssertFalse(BindRetryPolicy.isRetryable(statusCode: 401))
        XCTAssertFalse(BindRetryPolicy.isRetryable(statusCode: 500))

        let baseNow = Date(timeIntervalSince1970: 1_795_636_200) // Thu, 26 Nov 2026 20:10:00 GMT
        XCTAssertEqual(BindRetryPolicy.parseRetryAfter("45", now: baseNow, maxDelay: 300), 45)
        XCTAssertEqual(BindRetryPolicy.parseRetryAfter("9999", now: baseNow, maxDelay: 300), 300)
        XCTAssertEqual(BindRetryPolicy.parseRetryAfter("-5", now: baseNow, maxDelay: 300), 0)

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        let futureHeader = formatter.string(from: baseNow.addingTimeInterval(12))
        let parsedFuture = BindRetryPolicy.parseRetryAfter(futureHeader, now: baseNow, maxDelay: 300)
        XCTAssertEqual(parsedFuture ?? -1, 12.0, accuracy: 0.5)

        let cfg = BindRetryConfiguration(baseDelay: 1.0, maxDelay: 10.0, jitterFactor: 0.5, maxRetryAfter: 120.0)
        XCTAssertEqual(BindRetryPolicy.nextDelay(attempt: 1, retryAfter: nil, config: cfg, randomUnit: 0.0), 0.5, accuracy: 0.001)
        XCTAssertEqual(BindRetryPolicy.nextDelay(attempt: 1, retryAfter: nil, config: cfg, randomUnit: 1.0), 1.0, accuracy: 0.001)
        XCTAssertEqual(BindRetryPolicy.nextDelay(attempt: 3, retryAfter: nil, config: cfg, randomUnit: 1.0), 4.0, accuracy: 0.001)
        XCTAssertEqual(BindRetryPolicy.nextDelay(attempt: 6, retryAfter: nil, config: cfg, randomUnit: 1.0), 10.0, accuracy: 0.001)
        XCTAssertEqual(BindRetryPolicy.nextDelay(attempt: 1, retryAfter: 7.5, config: cfg, randomUnit: 0.0), 7.5, accuracy: 0.001)
    }

    func testTransportOutcomeClassification() throws {
        let url = URL(string: "https://ingest.bind.dev/v1/batch")!
        let okResp = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil))
        XCTAssertEqual(
            BindURLSessionTransport.classify(response: okResp, error: nil, maxRetryAfter: 60),
            .success(statusCode: 200)
        )

        let rateResp = try XCTUnwrap(
            HTTPURLResponse(url: url, statusCode: 429, httpVersion: "HTTP/1.1", headerFields: ["Retry-After": "12"])
        )
        XCTAssertEqual(
            BindURLSessionTransport.classify(response: rateResp, error: nil, maxRetryAfter: 60),
            .retryable(statusCode: 429, retryAfter: 12, reason: "HTTP 429")
        )

        let unauthResp = try XCTUnwrap(
            HTTPURLResponse(url: url, statusCode: 401, httpVersion: "HTTP/1.1", headerFields: nil)
        )
        XCTAssertEqual(
            BindURLSessionTransport.classify(response: unauthResp, error: nil, maxRetryAfter: 60),
            .permanentFailure(statusCode: 401, reason: "HTTP 401")
        )

        let netErr = URLError(.notConnectedToInternet)
        let classifiedErr = BindURLSessionTransport.classify(response: nil, error: netErr, maxRetryAfter: 60)
        if case .retryable(let code, let retryAfter, _) = classifiedErr {
            XCTAssertNil(code)
            XCTAssertNil(retryAfter)
        } else {
            XCTFail("Expected retryable outcome for URLError, got \(classifiedErr)")
        }
    }
}
