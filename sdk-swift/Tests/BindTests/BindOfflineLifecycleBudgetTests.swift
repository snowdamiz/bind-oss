import Foundation
import XCTest
@testable import Bind
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(UIKit) && !os(watchOS)
import UIKit
#endif

/// Spy transport that records background file uploads and forwards actual HTTP payloads to a real transport.
private final class RecordingBackgroundTransport: BindBatchTransport, Sendable {
    struct BackgroundUploadRecord: Sendable {
        let batchID: UUID
        let fileURL: URL
        let fileExistedAtEnqueue: Bool
        let fileSizeBytes: Int
        let authorizationHeader: String?
        let contentEncodingHeader: String?
    }

    private struct State: Sendable {
        var backgroundUploads: [BackgroundUploadRecord] = []
        var foregroundUploadCount = 0
    }

    private let inner: BindURLSessionTransport
    private let state = BindLockedState(State())

    init(configuration: BindConfiguration) {
        self.inner = BindURLSessionTransport(configuration: configuration)
    }

    var recordedBackgroundUploads: [BackgroundUploadRecord] {
        state.withLock { $0.backgroundUploads }
    }

    var recordedForegroundCount: Int {
        state.withLock { $0.foregroundUploadCount }
    }

    func send(batch: BindPreparedBatch, request: URLRequest) async -> BindUploadOutcome {
        state.withLock { $0.foregroundUploadCount += 1 }
        return await inner.send(batch: batch, request: request)
    }

    func enqueueBackgroundUpload(
        batch: BindPreparedBatch,
        fileURL: URL,
        request: URLRequest,
        onComplete: @escaping @Sendable (UUID, BindUploadOutcome) -> Void
    ) -> Bool {
        let exists = FileManager.default.fileExists(atPath: fileURL.path)
        let fileData = try? Data(contentsOf: fileURL)
        let record = BackgroundUploadRecord(
            batchID: batch.batchID,
            fileURL: fileURL,
            fileExistedAtEnqueue: exists,
            fileSizeBytes: fileData?.count ?? 0,
            authorizationHeader: request.value(forHTTPHeaderField: BindProtocol.authorizationHeader),
            contentEncodingHeader: request.value(forHTTPHeaderField: BindProtocol.contentEncodingHeader)
        )
        state.withLock { $0.backgroundUploads.append(record) }

        // Perform the real HTTP upload asynchronously from the on-disk file and report completion.
        let innerTransport = self.inner
        Task {
            let outcome = await innerTransport.send(batch: batch, request: request)
            onComplete(batch.batchID, outcome)
        }
        return true
    }

    func invalidate() {
        inner.invalidate()
    }
}

final class BindOfflineLifecycleBudgetTests: XCTestCase {
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
            .appendingPathComponent("bind-offline-\(UUID().uuidString)", isDirectory: true)
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

    /// Core T1.7.2 verification: go offline, log, come back online, and verify server receives every record once.
    func testOfflineLogComeBackOnlineDeliversEveryRecordExactlyOnce() async throws {
        let server = try FakeBindServer()
        defer { server.stop() }

        let dir = makeTempDir()
        let monitor = BindManualEnvironmentMonitor(initial: BindUploadConditions(isOnline: false))
        let config = BindConfiguration(
            ingestKey: "bk_offline_once",
            service: "mobile-app",
            env: "production",
            release: "3.0.0",
            endpoint: server.baseURL,
            maxBatchRecords: 10, // Multiple batches while offline
            flushInterval: 60.0,
            offlineQueue: BindOfflineQueueConfiguration(isEnabled: true, directory: dir, maxDiskBytes: 2 * 1024 * 1024),
            enableLifecycleFlush: false
        )
        let client = BindClient(configuration: config, environmentMonitor: monitor)
        let logger = BindLogger(sink: client)

        let totalRecords = 35
        for idx in 0..<totalRecords {
            logger.info("offline item \(idx) ok=\(true)", attrs: ["seq": "\(idx)"])
        }

        // Flush while offline: batches must persist to disk and zero requests may hit the server.
        await client.flush()
        try? await Task.sleep(nanoseconds: 100_000_000)

        XCTAssertEqual(server.requests.count, 0)
        let offlineDiag = await client.diagnostics()
        XCTAssertEqual(offlineDiag.pauseReason, .offline)
        XCTAssertEqual(offlineDiag.memoryQueuedRecords, 0)
        XCTAssertEqual(offlineDiag.diskQueuedBatches, 4) // 10 + 10 + 10 + 5

        // Verify real .bin.gz and .meta.json files exist on disk.
        let files = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        XCTAssertEqual(files.filter { $0.hasSuffix(".bin.gz") }.count, 4)
        XCTAssertEqual(files.filter { $0.hasSuffix(".meta.json") }.count, 4)

        // Come back online AND trigger a concurrent manual flush to verify in-flight deduplication.
        monitor.setOnline(true)
        await client.flush()

        let receivedAll = await server.waitForRequests(count: 4, timeout: 5.0)
        XCTAssertTrue(receivedAll)

        let postDiag = await waitForDiagnostics(of: client) {
            $0.totalBatchesSucceeded == 4 && $0.diskQueuedBatches == 0
        }
        // Brief pause to confirm no duplicate sends arrive after drain completes.
        try? await Task.sleep(nanoseconds: 150_000_000)

        let reqs = server.requests
        XCTAssertEqual(reqs.count, 4, "Expected exactly 4 batches without duplicates")

        var seenBatchIDs = Set<UUID>()
        var seenSeqValues: [Int] = []
        for req in reqs {
            let env = try XCTUnwrap(req.envelope)
            XCTAssertTrue(seenBatchIDs.insert(env.batchID).inserted, "Duplicate batch_id received: \(env.batchID)")
            for rec in env.records {
                let seqStr = try XCTUnwrap(rec.attrs?["seq"])
                let seq = try XCTUnwrap(Int(seqStr))
                seenSeqValues.append(seq)
            }
        }

        XCTAssertEqual(seenSeqValues.count, totalRecords)
        XCTAssertEqual(Set(seenSeqValues), Set(0..<totalRecords))

        XCTAssertEqual(postDiag.diskQueuedBatches, 0)
        XCTAssertEqual(postDiag.totalBatchesSucceeded, 4)

        // Disk directory should have zero remaining batch files.
        let remainingFiles = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        XCTAssertTrue(remainingFiles.filter { $0.hasSuffix(".bin.gz") || $0.hasSuffix(".meta.json") }.isEmpty)

        await client.shutdown()
    }

    func testOfflineBatchesPersistAcrossRestartAndUploadOnNextLaunch() async throws {
        let server = try FakeBindServer()
        defer { server.stop() }

        let dir = makeTempDir()
        let baseConfig = BindConfiguration(
            ingestKey: "bk_restart",
            service: "mobile-app",
            env: "production",
            release: "3.1.0",
            endpoint: server.baseURL,
            flushInterval: 60.0,
            offlineQueue: BindOfflineQueueConfiguration(isEnabled: true, directory: dir),
            enableLifecycleFlush: false
        )

        // Session 1: offline, logs 12 records, seals to disk, shuts down without uploading.
        do {
            let offlineMonitor = BindManualEnvironmentMonitor(initial: BindUploadConditions(isOnline: false))
            let client1 = BindClient(configuration: baseConfig, environmentMonitor: offlineMonitor)
            let logger1 = BindLogger(sink: client1)
            for idx in 0..<12 {
                logger1.error("crash breadcrumb \(idx)")
            }
            await client1.shutdown()
            XCTAssertEqual(server.requests.count, 0)
        }

        // Read the persisted batch ID directly from disk metadata to prove Session 2 reuses the exact same batch_id.
        let metaFile = try XCTUnwrap(
            FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
                .first(where: { $0.lastPathComponent.hasSuffix(".meta.json") })
        )
        let persistedMeta = try JSONDecoder().decode(
            BindPersistedBatchMetadata.self,
            from: Data(contentsOf: metaFile)
        )

        // Session 2: fresh client boots online against the same directory and uploads automatically.
        let onlineMonitor = BindManualEnvironmentMonitor(initial: BindUploadConditions(isOnline: true))
        let client2 = BindClient(configuration: baseConfig, environmentMonitor: onlineMonitor)

        let delivered = await server.waitForRequests(count: 1, timeout: 5.0)
        XCTAssertTrue(delivered)
        XCTAssertEqual(server.requests.count, 1)
        let env = try XCTUnwrap(server.requests[0].envelope)
        XCTAssertEqual(env.batchID, persistedMeta.batchID)
        XCTAssertEqual(env.records.count, 12)

        await client2.shutdown()
    }

    func testOfflineDiskCapEvictsOldestBatchesAndReportsEvictedDrops() async throws {
        let server = try FakeBindServer()
        defer { server.stop() }

        let dir = makeTempDir()
        let monitor = BindManualEnvironmentMonitor(initial: BindUploadConditions(isOnline: false))
        // Cap disk at 1,100 bytes so at most ~1-2 small batches fit on disk at once.
        let config = BindConfiguration(
            ingestKey: "bk_diskcap",
            service: "mobile-app",
            env: "staging",
            release: "1.0.0",
            endpoint: server.baseURL,
            flushInterval: 60.0,
            offlineQueue: BindOfflineQueueConfiguration(isEnabled: true, directory: dir, maxDiskBytes: 1_100),
            enableLifecycleFlush: false
        )
        let client = BindClient(configuration: config, environmentMonitor: monitor)
        let logger = BindLogger(sink: client)

        for batchIdx in 0..<6 {
            logger.info("disk-batch-\(batchIdx) payload=\(String(repeating: "x", count: 80))")
            await client.flush()
        }

        let diagOffline = await client.diagnostics()
        XCTAssertLessThanOrEqual(diagOffline.diskQueuedBytes, 1_100)
        XCTAssertLessThan(diagOffline.diskQueuedBatches, 6)
        XCTAssertGreaterThan(diagOffline.pendingDroppedRecords, 0)

        // Log one fresh record and come online so the eviction drop count is reported on the new batch.
        logger.info("after-disk-eviction")
        monitor.setOnline(true)
        await client.flush()

        let received = await server.waitForRequests(count: 1, timeout: 5.0)
        XCTAssertTrue(received)

        let totalDroppedReported = server.requests.compactMap { $0.envelope?.dropped }.reduce(0, +)
        XCTAssertGreaterThan(totalDroppedReported, 0)

        await client.shutdown()
    }

    func testLifecycleBackgroundFlushPersistsAndHandsOffToBackgroundUploader() async throws {
        let server = try FakeBindServer()
        defer { server.stop() }

        let dir = makeTempDir()
        let monitor = BindManualEnvironmentMonitor(initial: BindUploadConditions(isOnline: true))
        let config = BindConfiguration(
            ingestKey: "bk_lifecycle",
            service: "mobile-app",
            env: "production",
            release: "4.0.0",
            endpoint: server.baseURL,
            flushInterval: 60.0,
            offlineQueue: BindOfflineQueueConfiguration(isEnabled: true, directory: dir),
            enableLifecycleFlush: true
        )
        let spyTransport = RecordingBackgroundTransport(configuration: config)
        let client = BindClient(
            configuration: config,
            transport: spyTransport,
            environmentMonitor: monitor
        )
        let logger = BindLogger(sink: client)

        logger.info("final event before backgrounding")
        await client.handleDidEnterBackground()

        let received = await server.waitForRequests(count: 1, timeout: 5.0)
        XCTAssertTrue(received)

        let bgUploads = spyTransport.recordedBackgroundUploads
        XCTAssertEqual(bgUploads.count, 1)
        XCTAssertTrue(bgUploads[0].fileExistedAtEnqueue)
        XCTAssertGreaterThan(bgUploads[0].fileSizeBytes, 18)
        XCTAssertEqual(bgUploads[0].authorizationHeader, "Bearer bk_lifecycle")
        XCTAssertEqual(bgUploads[0].contentEncodingHeader, "gzip")
        XCTAssertEqual(spyTransport.recordedForegroundCount, 0)

        let diag = await waitForDiagnostics(of: client) {
            $0.totalBatchesSucceeded == 1 && $0.diskQueuedBatches == 0
        }
        XCTAssertEqual(diag.totalBackgroundUploadsScheduled, 1)
        XCTAssertEqual(diag.totalBatchesSucceeded, 1)
        XCTAssertEqual(diag.diskQueuedBatches, 0)

        await client.shutdown()
    }

    #if canImport(UIKit) && !os(watchOS)
    func testUIKitDidEnterBackgroundNotificationTriggersLifecycleFlush() async throws {
        let server = try FakeBindServer()
        defer { server.stop() }

        let dir = makeTempDir()
        let monitor = BindManualEnvironmentMonitor(initial: BindUploadConditions(isOnline: true))
        let config = BindConfiguration(
            ingestKey: "bk_uikit_bg",
            service: "ios-sim-app",
            env: "staging",
            release: "1.0.0",
            endpoint: server.baseURL,
            flushInterval: 60.0,
            offlineQueue: BindOfflineQueueConfiguration(isEnabled: true, directory: dir),
            enableLifecycleFlush: true
        )
        let spyTransport = RecordingBackgroundTransport(configuration: config)
        let client = BindClient(
            configuration: config,
            transport: spyTransport,
            environmentMonitor: monitor
        )
        let logger = BindLogger(sink: client)
        logger.info("uikit background notification log")

        NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)

        let received = await server.waitForRequests(count: 1, timeout: 5.0)
        XCTAssertTrue(received)
        XCTAssertEqual(spyTransport.recordedBackgroundUploads.count, 1)
        XCTAssertEqual(server.requests.first?.envelope?.records.count, 1)

        let diag = await waitForDiagnostics(of: client) {
            $0.totalBatchesSucceeded == 1 && $0.diskQueuedBatches == 0
        }
        XCTAssertEqual(diag.totalBatchesSucceeded, 1)
        XCTAssertEqual(diag.diskQueuedBatches, 0)

        await client.shutdown()
    }
    #endif

    func testLowPowerModeAndConstrainedNetworkPauseAndOverride() async throws {
        let server = try FakeBindServer()
        defer { server.stop() }

        // 1. Default budgets: Low Power Mode pauses uploads, exiting Low Power Mode resumes them.
        do {
            let monitor = BindManualEnvironmentMonitor(
                initial: BindUploadConditions(isOnline: true, isConstrainedNetwork: false, isLowPowerMode: true)
            )
            let config = BindConfiguration(
                ingestKey: "bk_lpm",
                service: "mobile",
                env: "prod",
                release: "1.0",
                endpoint: server.baseURL,
                flushInterval: 60.0,
                offlineQueue: BindOfflineQueueConfiguration(isEnabled: true, directory: makeTempDir()),
                budgets: BindBudgetConfiguration(pauseInLowPowerMode: true, pauseOnConstrainedNetwork: true),
                enableLifecycleFlush: false
            )
            let client = BindClient(configuration: config, environmentMonitor: monitor)
            let logger = BindLogger(sink: client)

            logger.info("queued in low power mode")
            await client.flush()
            XCTAssertEqual(server.requests.count, 0)
            let pausedDiag = await client.diagnostics()
            XCTAssertEqual(pausedDiag.pauseReason, .lowPowerMode)
            XCTAssertEqual(pausedDiag.diskQueuedBatches, 1)

            // Transition to constrained network (still paused)
            monitor.update {
                $0.isLowPowerMode = false
                $0.isConstrainedNetwork = true
            }
            await client.flush()
            XCTAssertEqual(server.requests.count, 0)
            let constrainedDiag = await client.diagnostics()
            XCTAssertEqual(constrainedDiag.pauseReason, .constrainedNetwork)

            // Leave constrained network -> upload resumes automatically!
            monitor.setConstrainedNetwork(false)
            let received = await server.waitForRequests(count: 1, timeout: 5.0)
            XCTAssertTrue(received)
            XCTAssertEqual(server.requests.count, 1)

            await client.shutdown()
        }

        // 2. Developer overrides both pauses -> uploads immediately despite Low Power + constrained network.
        server.resetRequests()
        do {
            let monitor = BindManualEnvironmentMonitor(
                initial: BindUploadConditions(isOnline: true, isConstrainedNetwork: true, isLowPowerMode: true)
            )
            let config = BindConfiguration(
                ingestKey: "bk_override",
                service: "mobile",
                env: "prod",
                release: "1.0",
                endpoint: server.baseURL,
                flushInterval: 60.0,
                offlineQueue: BindOfflineQueueConfiguration(isEnabled: true, directory: makeTempDir()),
                budgets: BindBudgetConfiguration(pauseInLowPowerMode: false, pauseOnConstrainedNetwork: false),
                enableLifecycleFlush: false
            )
            let client = BindClient(configuration: config, environmentMonitor: monitor)
            let logger = BindLogger(sink: client)

            logger.info("override uploads in low power and constrained network")
            await client.flush()
            let received = await server.waitForRequests(count: 1, timeout: 5.0)
            XCTAssertTrue(received)

            await client.shutdown()
        }
    }

    func testDailyByteCapPausesPersistsAcrossRestartAndResetsNextUTCDay() async throws {
        let server = try FakeBindServer()
        defer { server.stop() }

        let dir = makeTempDir()
        // Fixed start clock: 2026-11-26 12:00:00 UTC
        let clockBox = BindLockedState(BindTimestamp(seconds: 1_795_694_400, nanoseconds: 0))
        let clock: @Sendable () -> BindTimestamp = { clockBox.withLock { $0 } }

        // Measure one small batch size with the active platform compressor (Apple Compression vs Linux pure-Swift DEFLATE)
        // so that 1 batch fits comfortably under the daily cap while 2 batches exceed it.
        let probeSink = BindMemorySink()
        BindLogger(sink: probeSink, clock: clock).info("first daily batch")
        let probeEnvelope = BindBatchEnvelope(
            service: "mobile",
            env: "prod",
            release: "1.0",
            records: probeSink.records
        )
        let probeBatch = try BindPreparedBatch.prepare(envelope: probeEnvelope, createdAt: clock())
        let dailyCap = UInt64(probeBatch.compressedByteCount + 50)
        XCTAssertLessThan(dailyCap, UInt64(probeBatch.compressedByteCount * 2))

        let monitor = BindManualEnvironmentMonitor(initial: BindUploadConditions(isOnline: true))
        let config = BindConfiguration(
            ingestKey: "bk_daily_cap",
            service: "mobile",
            env: "prod",
            release: "1.0",
            endpoint: server.baseURL,
            flushInterval: 60.0,
            offlineQueue: BindOfflineQueueConfiguration(isEnabled: true, directory: dir),
            budgets: BindBudgetConfiguration(dailyByteCap: dailyCap),
            enableLifecycleFlush: false
        )

        do {
            let client1 = BindClient(configuration: config, environmentMonitor: monitor, clock: clock)
            let logger1 = BindLogger(sink: client1, clock: clock)

            logger1.info("first daily batch")
            await client1.flush()
            XCTAssertEqual(server.requests.count, 1)

            let diagAfter1 = await client1.diagnostics()
            XCTAssertGreaterThan(diagAfter1.dailyBytesSent, 0)
            XCTAssertLessThanOrEqual(diagAfter1.dailyBytesSent, dailyCap)

            // Second batch pushes over dailyCap -> paused by daily byte cap and kept safely on disk.
            logger1.info("second batch blocked by daily cap")
            await client1.flush()
            XCTAssertEqual(server.requests.count, 1)

            let diagAfter2 = await client1.diagnostics()
            XCTAssertEqual(diagAfter2.pauseReason, .dailyByteCapReached)
            XCTAssertEqual(diagAfter2.diskQueuedBatches, 1)

            await client1.shutdown()
        }

        // Restart client on the SAME UTC day: daily cap ledger must still block the 2nd batch!
        let client2 = BindClient(configuration: config, environmentMonitor: monitor, clock: clock)
        await client2.flush()
        XCTAssertEqual(server.requests.count, 1)
        let diagSameDay = await client2.diagnostics()
        XCTAssertEqual(diagSameDay.pauseReason, .dailyByteCapReached)
        XCTAssertEqual(diagSameDay.diskQueuedBatches, 1)

        // Advance clock by 24 hours (next UTC day): cap resets and the queued 2nd batch uploads immediately!
        clockBox.withLock { $0 = BindTimestamp(seconds: $0.seconds + 86_400, nanoseconds: 0) }
        await client2.flush()

        let receivedSecond = await server.waitForRequests(count: 2, timeout: 5.0)
        XCTAssertTrue(receivedSecond)
        XCTAssertEqual(server.requests.count, 2)
        let diagNextDay = await client2.diagnostics()
        XCTAssertEqual(diagNextDay.diskQueuedBatches, 0)
        XCTAssertNil(diagNextDay.pauseReason)

        await client2.shutdown()
    }
}
