import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Observable runtime counters and queue state for diagnostics and verification.
public struct BindClientDiagnostics: Sendable, Hashable {
    public let memoryQueuedRecords: Int
    public let memoryQueuedBytes: Int
    public let pendingDroppedRecords: UInt64
    public let diskQueuedBatches: Int
    public let diskQueuedBytes: Int
    public let ephemeralQueuedBatches: Int
    public let inFlightBatchCount: Int
    public let dailyBytesSent: UInt64
    public let pauseReason: BindUploadPauseReason?
    public let totalBatchesSealed: UInt64
    public let totalBatchesSucceeded: UInt64
    public let totalBatchesRetried: UInt64
    public let totalBatchesDroppedPermanent: UInt64
    public let totalBackgroundUploadsScheduled: UInt64
}

extension BindTimestamp {
    internal func adding(seconds delta: TimeInterval) -> BindTimestamp {
        guard delta.isFinite, delta != 0 else { return self }
        let wholeSeconds = Int64(delta.rounded(.towardZero))
        let fractionalSeconds = delta - Double(wholeSeconds)
        let extraNanos = Int32((fractionalSeconds * 1_000_000_000).rounded())
        return BindTimestamp(
            seconds: self.seconds + wholeSeconds,
            nanoseconds: self.nanoseconds + extraNanos
        )
    }

    internal func secondsUntil(_ future: BindTimestamp) -> TimeInterval {
        let secDiff = future.seconds - self.seconds
        let nanoDiff = Int64(future.nanoseconds) - Int64(self.nanoseconds)
        return Double(secDiff) + Double(nanoDiff) / 1_000_000_000.0
    }
}

/// Manages record batching, bounded memory, offline persistence, retries, lifecycle flushes, and budgets.
public final class BindClient: BindRecordSink, @unchecked Sendable {
    public let configuration: BindConfiguration
    private let memoryQueue: BindMemoryQueue
    private let engine: BindTransportEngine
    private let environmentMonitor: any BindEnvironmentMonitor
    private let lifecycleObserver: BindLifecycleObserver?
    private let transport: any BindBatchTransport

    public init(
        configuration: BindConfiguration,
        transport: (any BindBatchTransport)? = nil,
        environmentMonitor: (any BindEnvironmentMonitor)? = nil,
        clock: @escaping @Sendable () -> BindTimestamp = BindTimestamp.now,
        randomUnit: @escaping @Sendable () -> Double = { Double.random(in: 0...1) }
    ) {
        self.configuration = configuration
        self.memoryQueue = BindMemoryQueue(
            maxMemoryBytes: configuration.maxMemoryQueueBytes,
            maxBatchRecords: configuration.maxBatchRecords,
            maxBatchCompressedBytes: configuration.maxBatchCompressedBytes
        )
        let resolvedTransport = transport ?? BindURLSessionTransport(configuration: configuration)
        let resolvedMonitor = environmentMonitor ?? BindSystemEnvironmentMonitor()
        self.transport = resolvedTransport
        self.environmentMonitor = resolvedMonitor

        self.engine = BindTransportEngine(
            configuration: configuration,
            memoryQueue: memoryQueue,
            transport: resolvedTransport,
            initialConditions: resolvedMonitor.currentConditions,
            clock: clock,
            randomUnit: randomUnit
        )

        let engineRef = self.engine
        resolvedMonitor.start { newConditions in
            Task {
                await engineRef.handleConditionsChanged(newConditions)
            }
        }

        if configuration.enableLifecycleFlush {
            let observer = BindLifecycleObserver()
            observer.start(
                onBackground: {
                    await engineRef.handleDidEnterBackground()
                },
                onTerminate: {
                    await engineRef.flush()
                }
            )
            self.lifecycleObserver = observer
        } else {
            self.lifecycleObserver = nil
        }

        // Resume draining any batches persisted from an earlier session.
        Task {
            await engineRef.resumePersistedQueueIfNeeded()
        }
    }

    deinit {
        environmentMonitor.stop()
        lifecycleObserver?.stop()
    }

    /// Captures a record into the bounded in-memory queue without blocking or throwing.
    public func receive(_ record: BindRecord) {
        let effect = memoryQueue.enqueue(record)
        guard effect.becameNonEmpty || effect.shouldFlushForCount || effect.shouldCheckCompressedSize else {
            return
        }
        let engineRef = self.engine
        Task {
            await engineRef.handleEnqueueEffect(effect)
        }
    }

    /// Seals all queued in-memory records and drains all currently eligible batches.
    public func flush() async {
        await engine.flush()
    }

    /// Performs the app-background lifecycle flush: seals pending records to disk and hands off
    /// eligible batches to the background `URLSession` uploader when available.
    public func handleDidEnterBackground() async {
        await engine.handleDidEnterBackground()
    }

    /// Connects an Apple app delegate's `handleEventsForBackgroundURLSession` callback.
    public func handleBackgroundSessionEvents(
        identifier: String,
        completionHandler: @escaping @Sendable () -> Void
    ) {
        transport.handleBackgroundSessionEvents(
            identifier: identifier,
            completionHandler: completionHandler
        )
    }

    /// Stops background monitors/timers synchronously (used by `Bind.reset()`).
    internal func cancelSynchronously() {
        environmentMonitor.stop()
        lifecycleObserver?.stop()
        let engineRef = self.engine
        let transportRef = self.transport
        Task {
            await engineRef.cancelAllTimersAndStop()
            transportRef.invalidate()
        }
    }

    /// Flushes remaining eligible records, stops monitors and timers, and invalidates network sessions.
    public func shutdown() async {
        environmentMonitor.stop()
        lifecycleObserver?.stop()
        await engine.shutdown()
        transport.invalidate()
    }

    /// Returns a point-in-time snapshot of queues, budgets, and delivery counters.
    public func diagnostics() async -> BindClientDiagnostics {
        await engine.diagnostics()
    }
}

// MARK: - Transport Engine Actor

private actor BindTransportEngine {
    private struct EphemeralBatch: Sendable {
        let prepared: BindPreparedBatch
        var attemptCount: Int
        var nextAttemptAt: BindTimestamp?
        var retryAfterPinned: Bool
    }

    private let configuration: BindConfiguration
    private let memoryQueue: BindMemoryQueue
    private let transport: any BindBatchTransport
    private let clock: @Sendable () -> BindTimestamp
    private let randomUnit: @Sendable () -> Double

    private let offlineQueue: BindOfflineQueue?
    private var ephemeralPending: [EphemeralBatch] = []
    private var dailyBudget: BindDailyByteBudget
    private var conditions: BindUploadConditions

    private var inFlightBatchIDs: Set<UUID> = []
    private var activeDrainTask: Task<Void, Never>?
    private var drainRequestedAgain = false
    private var flushTimerTask: Task<Void, Never>?
    private var retryTimerTask: Task<Void, Never>?
    private var retryTimerDeadline: BindTimestamp?

    private var isStopped = false
    private var lastPauseReason: BindUploadPauseReason?
    private var totalBatchesSealed: UInt64 = 0
    private var totalBatchesSucceeded: UInt64 = 0
    private var totalBatchesRetried: UInt64 = 0
    private var totalBatchesDroppedPermanent: UInt64 = 0
    private var totalBackgroundUploadsScheduled: UInt64 = 0

    init(
        configuration: BindConfiguration,
        memoryQueue: BindMemoryQueue,
        transport: any BindBatchTransport,
        initialConditions: BindUploadConditions,
        clock: @escaping @Sendable () -> BindTimestamp,
        randomUnit: @escaping @Sendable () -> Double
    ) {
        self.configuration = configuration
        self.memoryQueue = memoryQueue
        self.transport = transport
        self.conditions = initialConditions
        self.clock = clock
        self.randomUnit = randomUnit

        if configuration.offlineQueue.isEnabled {
            let dir = configuration.offlineQueue.resolvedDirectory()
            let queue = BindOfflineQueue(
                directory: dir,
                maxDiskBytes: configuration.offlineQueue.maxDiskBytes
            )
            self.offlineQueue = queue
            self.dailyBudget = BindDailyByteBudget(ledgerURL: queue.ledgerURL, now: clock())
        } else {
            self.offlineQueue = nil
            self.dailyBudget = BindDailyByteBudget(ledgerURL: nil, now: clock())
        }
        self.lastPauseReason = configuration.budgets.pauseReason(for: initialConditions)
    }

    func resumePersistedQueueIfNeeded() async {
        guard !isStopped else { return }
        if (offlineQueue?.count ?? 0) > 0 {
            await triggerDrain(useBackgroundSession: false, waitForCompletion: false)
        }
    }

    func handleEnqueueEffect(_ effect: BindQueueEnqueueEffect) async {
        guard !isStopped else { return }

        if effect.becameNonEmpty {
            armFlushTimerIfNeeded()
        }

        if effect.shouldFlushForCount {
            sealWhileAtOrAboveRecordLimit()
            await triggerDrain(useBackgroundSession: false, waitForCompletion: false)
            return
        }

        if effect.shouldCheckCompressedSize {
            if checkCompressedSizeAndSealIfNeeded() {
                await triggerDrain(useBackgroundSession: false, waitForCompletion: false)
            }
        }
    }

    func handleConditionsChanged(_ newConditions: BindUploadConditions) async {
        guard !isStopped else { return }
        let previousPause = configuration.budgets.pauseReason(for: conditions)
        conditions = newConditions
        let newPause = configuration.budgets.pauseReason(for: newConditions)
        lastPauseReason = newPause

        if newPause == nil {
            if previousPause != nil {
                clearNonPinnedBackoff()
            }
            if hasPendingBatches {
                await triggerDrain(useBackgroundSession: false, waitForCompletion: false)
            }
        }
    }

    func flush() async {
        guard !isStopped else { return }
        cancelFlushTimer()
        sealAllFromMemory()
        await triggerDrain(useBackgroundSession: false, waitForCompletion: true)
    }

    func handleDidEnterBackground() async {
        guard !isStopped else { return }
        cancelFlushTimer()
        sealAllFromMemory()
        await triggerDrain(useBackgroundSession: true, waitForCompletion: true)
    }

    func shutdown() async {
        guard !isStopped else { return }
        cancelFlushTimer()
        cancelRetryTimer()
        sealAllFromMemory()
        await triggerDrain(useBackgroundSession: false, waitForCompletion: true)
        isStopped = true
        cancelFlushTimer()
        cancelRetryTimer()
    }

    func cancelAllTimersAndStop() {
        isStopped = true
        cancelFlushTimer()
        cancelRetryTimer()
        activeDrainTask?.cancel()
        activeDrainTask = nil
    }

    func diagnostics() -> BindClientDiagnostics {
        let mem = memoryQueue.snapshot()
        let now = clock()
        let used = dailyBudget.bytesUsed(now: now)
        let currentPause: BindUploadPauseReason?
        if let envPause = configuration.budgets.pauseReason(for: conditions) {
            currentPause = envPause
        } else if lastPauseReason == .dailyByteCapReached {
            currentPause = .dailyByteCapReached
        } else {
            currentPause = nil
        }

        return BindClientDiagnostics(
            memoryQueuedRecords: mem.recordCount,
            memoryQueuedBytes: mem.byteCount,
            pendingDroppedRecords: mem.pendingDroppedCount,
            diskQueuedBatches: offlineQueue?.count ?? 0,
            diskQueuedBytes: offlineQueue?.totalDiskBytes ?? 0,
            ephemeralQueuedBatches: ephemeralPending.count,
            inFlightBatchCount: inFlightBatchIDs.count,
            dailyBytesSent: used,
            pauseReason: currentPause,
            totalBatchesSealed: totalBatchesSealed,
            totalBatchesSucceeded: totalBatchesSucceeded,
            totalBatchesRetried: totalBatchesRetried,
            totalBatchesDroppedPermanent: totalBatchesDroppedPermanent,
            totalBackgroundUploadsScheduled: totalBackgroundUploadsScheduled
        )
    }

    // MARK: - Sealing & Splitting

    private func sealWhileAtOrAboveRecordLimit() {
        while memoryQueue.snapshot().recordCount >= configuration.maxBatchRecords {
            guard sealNextBatchFromMemory() else { break }
        }
        if memoryQueue.snapshot().recordCount == 0 {
            cancelFlushTimer()
        } else {
            armFlushTimerIfNeeded()
        }
    }

    private func sealAllFromMemory() {
        while memoryQueue.snapshot().recordCount > 0 {
            guard sealNextBatchFromMemory() else { break }
        }
        cancelFlushTimer()
    }

    /// Checks whether the front of the in-memory queue has reached `maxBatchCompressedBytes`.
    /// If so, seals one or more batches; otherwise adjusts the next check threshold adaptively.
    private func checkCompressedSizeAndSealIfNeeded() -> Bool {
        let (peeked, estimatedBytes) = memoryQueue.peekFrontBatch()
        guard !peeked.isEmpty else { return false }

        let trialEnvelope = BindBatchEnvelope(
            service: configuration.service,
            env: configuration.env,
            release: configuration.release,
            records: peeked,
            dropped: nil
        )
        guard let trial = try? BindPreparedBatch.prepare(envelope: trialEnvelope, createdAt: clock()) else {
            return false
        }

        if trial.compressedByteCount >= configuration.maxBatchCompressedBytes {
            var sealedAny = false
            while memoryQueue.snapshot().byteCount >= configuration.maxBatchCompressedBytes
                || memoryQueue.snapshot().recordCount >= configuration.maxBatchRecords
            {
                let (nextPeek, _) = memoryQueue.peekFrontBatch()
                guard !nextPeek.isEmpty else { break }
                if nextPeek.count < configuration.maxBatchRecords {
                    let env = BindBatchEnvelope(
                        service: configuration.service,
                        env: configuration.env,
                        release: configuration.release,
                        records: nextPeek,
                        dropped: nil
                    )
                    if let check = try? BindPreparedBatch.prepare(envelope: env, createdAt: clock()),
                       check.compressedByteCount < configuration.maxBatchCompressedBytes
                    {
                        break
                    }
                }
                guard sealNextBatchFromMemory() else { break }
                sealedAny = true
            }
            if memoryQueue.snapshot().recordCount == 0 {
                cancelFlushTimer()
            } else {
                armFlushTimerIfNeeded()
            }
            return sealedAny
        }

        // Data compressed below threshold; conservatively estimate when to check again.
        let remainingCompressed = configuration.maxBatchCompressedBytes - trial.compressedByteCount
        let compressionRatio = max(1, estimatedBytes / max(1, trial.compressedByteCount))
        let additionalUncompressed = max(remainingCompressed, (remainingCompressed * compressionRatio) / 2)
        memoryQueue.updateNextCompressedCheckBytes(estimatedBytes + additionalUncompressed)
        return false
    }

    @discardableResult
    private func sealNextBatchFromMemory() -> Bool {
        guard let (records, dropped) = memoryQueue.popBatch(), !records.isEmpty else {
            return false
        }

        let now = clock()
        let droppedField: UInt64? = dropped > 0 ? dropped : nil
        let fullEnvelope = BindBatchEnvelope(
            service: configuration.service,
            env: configuration.env,
            release: configuration.release,
            records: records,
            dropped: droppedField
        )

        guard let fullPrepared = try? BindPreparedBatch.prepare(envelope: fullEnvelope, createdAt: now) else {
            // Encoding failed unexpectedly; count records as dropped so nothing silently disappears.
            memoryQueue.recordExternalDrops(UInt64(records.count) &+ dropped)
            return false
        }

        let finalPrepared: BindPreparedBatch
        if fullPrepared.compressedByteCount <= configuration.maxBatchCompressedBytes || records.count == 1 {
            finalPrepared = fullPrepared
        } else {
            // Binary-search the largest prefix that fits within maxBatchCompressedBytes.
            var low = 1
            var high = records.count - 1
            var bestCount = 1
            var bestBatch: BindPreparedBatch?

            while low <= high {
                let mid = low + (high - low) / 2
                let slice = Array(records[0..<mid])
                let env = BindBatchEnvelope(
                    service: configuration.service,
                    env: configuration.env,
                    release: configuration.release,
                    records: slice,
                    dropped: droppedField
                )
                if let candidate = try? BindPreparedBatch.prepare(envelope: env, createdAt: now),
                   candidate.compressedByteCount <= configuration.maxBatchCompressedBytes
                {
                    bestCount = mid
                    bestBatch = candidate
                    low = mid + 1
                } else {
                    high = mid - 1
                }
            }

            if let bestBatch {
                finalPrepared = bestBatch
                let leftovers = Array(records[bestCount...])
                memoryQueue.prependLeftovers(leftovers)
            } else {
                // Even the first record alone exceeds maxBatchCompressedBytes; send it solo.
                let soloEnv = BindBatchEnvelope(
                    service: configuration.service,
                    env: configuration.env,
                    release: configuration.release,
                    records: [records[0]],
                    dropped: droppedField
                )
                guard let soloPrepared = try? BindPreparedBatch.prepare(envelope: soloEnv, createdAt: now) else {
                    memoryQueue.recordExternalDrops(UInt64(records.count) &+ dropped)
                    return false
                }
                finalPrepared = soloPrepared
                let leftovers = Array(records[1...])
                memoryQueue.prependLeftovers(leftovers)
            }
        }

        enqueuePreparedBatch(finalPrepared)
        totalBatchesSealed &+= 1
        return true
    }

    private func enqueuePreparedBatch(_ batch: BindPreparedBatch) {
        if let offlineQueue {
            let result = offlineQueue.enqueue(batch, inFlightIDs: inFlightBatchIDs)
            if result.evictedRecords > 0 {
                memoryQueue.recordExternalDrops(result.evictedRecords)
            }
            if result.stored != nil {
                return
            }
        }
        ephemeralPending.append(
            EphemeralBatch(
                prepared: batch,
                attemptCount: 0,
                nextAttemptAt: nil,
                retryAfterPinned: false
            )
        )
    }

    // MARK: - Draining & Delivery

    private var hasPendingBatches: Bool {
        (offlineQueue?.count ?? 0) > 0 || !ephemeralPending.isEmpty
    }

    private func triggerDrain(useBackgroundSession: Bool, waitForCompletion: Bool) async {
        if let existing = activeDrainTask {
            drainRequestedAgain = true
            if waitForCompletion {
                await existing.value
                // If another drain was requested (for example after newly sealed records), run it now.
                if drainRequestedAgain && !isStopped {
                    drainRequestedAgain = false
                    await runDrainLoop(useBackgroundSession: useBackgroundSession)
                }
            }
            return
        }

        let task = Task {
            await self.runDrainLoop(useBackgroundSession: useBackgroundSession)
        }
        activeDrainTask = task
        if waitForCompletion {
            await task.value
        }
    }

    private func runDrainLoop(useBackgroundSession: Bool) async {
        defer {
            activeDrainTask = nil
        }

        repeat {
            drainRequestedAgain = false
            await drainOnce(useBackgroundSession: useBackgroundSession)
        } while drainRequestedAgain && !isStopped
    }

    private func drainOnce(useBackgroundSession: Bool) async {
        if let pause = configuration.budgets.pauseReason(for: conditions) {
            lastPauseReason = pause
            return
        }
        lastPauseReason = nil

        var earliestDeferred: BindTimestamp?

        // 1. Drain persisted offline batches first (FIFO).
        if let offlineQueue {
            let snapshot = offlineQueue.pendingBatches()
            for item in snapshot {
                if isStopped { return }
                let batchID = item.metadata.batchID
                if inFlightBatchIDs.contains(batchID) {
                    continue
                }

                let now = clock()
                if let nextAt = item.metadata.nextAttemptAt, nextAt > now {
                    earliestDeferred = minTimestamp(earliestDeferred, nextAt)
                    continue
                }

                if !dailyBudget.canSend(
                    bytes: item.metadata.compressedByteCount,
                    cap: configuration.budgets.dailyByteCap,
                    now: now
                ) {
                    lastPauseReason = .dailyByteCapReached
                    return
                }

                guard let prepared = offlineQueue.loadPreparedBatch(for: batchID) else {
                    offlineQueue.remove(batchID: batchID)
                    continue
                }

                let shouldContinue = await dispatchBatch(
                    prepared: prepared,
                    fileURL: item.payloadURL,
                    useBackgroundSession: useBackgroundSession
                )
                if !shouldContinue {
                    break
                }
            }
        }

        // 2. Drain ephemeral in-memory prepared batches (when offline queue is disabled or disk was unwritable).
        let ephemeralIDs = ephemeralPending.map { $0.prepared.batchID }
        for batchID in ephemeralIDs {
            if isStopped { return }
            if inFlightBatchIDs.contains(batchID) {
                continue
            }
            guard let entry = ephemeralPending.first(where: { $0.prepared.batchID == batchID }) else {
                continue
            }

            let now = clock()
            if let nextAt = entry.nextAttemptAt, nextAt > now {
                earliestDeferred = minTimestamp(earliestDeferred, nextAt)
                continue
            }

            if !dailyBudget.canSend(
                bytes: entry.prepared.compressedByteCount,
                cap: configuration.budgets.dailyByteCap,
                now: now
            ) {
                lastPauseReason = .dailyByteCapReached
                return
            }

            let shouldContinue = await dispatchBatch(
                prepared: entry.prepared,
                fileURL: nil,
                useBackgroundSession: false
            )
            if !shouldContinue {
                break
            }
        }

        if let nextWake = earliestDeferred {
            scheduleRetryTimer(for: nextWake)
        }
    }

    /// Dispatches a single prepared batch. Returns `true` to continue draining, `false` to pause after a retryable failure.
    private func dispatchBatch(
        prepared: BindPreparedBatch,
        fileURL: URL?,
        useBackgroundSession: Bool
    ) async -> Bool {
        let request = prepared.makeURLRequest(configuration: configuration)
        inFlightBatchIDs.insert(prepared.batchID)

        if useBackgroundSession, let fileURL {
            let compressedBytes = prepared.compressedByteCount
            let accepted = transport.enqueueBackgroundUpload(
                batch: prepared,
                fileURL: fileURL,
                request: request
            ) { [weak self] completedBatchID, outcome in
                Task {
                    await self?.handleUploadOutcome(
                        batchID: completedBatchID,
                        compressedBytes: compressedBytes,
                        outcome: outcome
                    )
                }
            }
            if accepted {
                totalBackgroundUploadsScheduled &+= 1
                return true
            }
        }

        let outcome = await transport.send(batch: prepared, request: request)
        return handleUploadOutcome(
            batchID: prepared.batchID,
            compressedBytes: prepared.compressedByteCount,
            outcome: outcome
        )
    }

    @discardableResult
    private func handleUploadOutcome(
        batchID: UUID,
        compressedBytes: Int,
        outcome: BindUploadOutcome
    ) -> Bool {
        inFlightBatchIDs.remove(batchID)
        let now = clock()

        switch outcome {
        case .success:
            dailyBudget.recordSent(bytes: compressedBytes, now: now)
            removePendingBatch(batchID: batchID)
            totalBatchesSucceeded &+= 1
            return true

        case .permanentFailure:
            dailyBudget.recordSent(bytes: compressedBytes, now: now)
            removePendingBatch(batchID: batchID)
            totalBatchesDroppedPermanent &+= 1
            return true

        case .retryable(let statusCode, let retryAfter, _):
            if statusCode != nil {
                dailyBudget.recordSent(bytes: compressedBytes, now: now)
            }
            totalBatchesRetried &+= 1

            let nextAttempt = incrementAttemptAndScheduleRetry(
                batchID: batchID,
                retryAfter: retryAfter,
                now: now
            )
            if let nextAttempt {
                scheduleRetryTimer(for: nextAttempt)
            }
            return false
        }
    }

    private func removePendingBatch(batchID: UUID) {
        offlineQueue?.remove(batchID: batchID)
        if let idx = ephemeralPending.firstIndex(where: { $0.prepared.batchID == batchID }) {
            ephemeralPending.remove(at: idx)
        }
    }

    private func incrementAttemptAndScheduleRetry(
        batchID: UUID,
        retryAfter: TimeInterval?,
        now: BindTimestamp
    ) -> BindTimestamp? {
        if let stored = offlineQueue?.batch(for: batchID) {
            let newAttempt = stored.metadata.attemptCount + 1
            let delay = BindRetryPolicy.nextDelay(
                attempt: newAttempt,
                retryAfter: retryAfter,
                config: configuration.retry,
                randomUnit: randomUnit()
            )
            let nextAt = now.adding(seconds: delay)
            offlineQueue?.updateRetry(
                batchID: batchID,
                attemptCount: newAttempt,
                nextAttemptAt: nextAt,
                retryAfterPinned: retryAfter != nil
            )
            return nextAt
        }

        if let idx = ephemeralPending.firstIndex(where: { $0.prepared.batchID == batchID }) {
            let newAttempt = ephemeralPending[idx].attemptCount + 1
            let delay = BindRetryPolicy.nextDelay(
                attempt: newAttempt,
                retryAfter: retryAfter,
                config: configuration.retry,
                randomUnit: randomUnit()
            )
            let nextAt = now.adding(seconds: delay)
            ephemeralPending[idx].attemptCount = newAttempt
            ephemeralPending[idx].nextAttemptAt = nextAt
            ephemeralPending[idx].retryAfterPinned = retryAfter != nil
            return nextAt
        }

        return nil
    }

    private func clearNonPinnedBackoff() {
        offlineQueue?.clearNonPinnedBackoff()
        for idx in ephemeralPending.indices {
            if !ephemeralPending[idx].retryAfterPinned {
                ephemeralPending[idx].nextAttemptAt = nil
            }
        }
    }

    // MARK: - Timers

    private func armFlushTimerIfNeeded() {
        guard !isStopped, flushTimerTask == nil else { return }
        let interval = configuration.flushInterval
        flushTimerTask = Task {
            let nanos = UInt64(max(1_000_000, (interval * 1_000_000_000).rounded()))
            try? await Task.sleep(nanoseconds: nanos)
            guard !Task.isCancelled else { return }
            await self.onFlushTimerFired()
        }
    }

    private func onFlushTimerFired() async {
        flushTimerTask = nil
        guard !isStopped else { return }
        sealAllFromMemory()
        if hasPendingBatches {
            await triggerDrain(useBackgroundSession: false, waitForCompletion: false)
        }
    }

    private func cancelFlushTimer() {
        flushTimerTask?.cancel()
        flushTimerTask = nil
    }

    private func scheduleRetryTimer(for deadline: BindTimestamp) {
        guard !isStopped else { return }
        if let existingDeadline = retryTimerDeadline, existingDeadline <= deadline, retryTimerTask != nil {
            return
        }
        retryTimerTask?.cancel()
        retryTimerDeadline = deadline
        let delay = max(0.01, clock().secondsUntil(deadline))
        retryTimerTask = Task {
            let nanos = UInt64(max(1_000_000, (delay * 1_000_000_000).rounded()))
            try? await Task.sleep(nanoseconds: nanos)
            guard !Task.isCancelled else { return }
            await self.onRetryTimerFired()
        }
    }

    private func onRetryTimerFired() async {
        retryTimerTask = nil
        retryTimerDeadline = nil
        guard !isStopped else { return }
        if hasPendingBatches {
            await triggerDrain(useBackgroundSession: false, waitForCompletion: false)
        }
    }

    private func cancelRetryTimer() {
        retryTimerTask?.cancel()
        retryTimerTask = nil
        retryTimerDeadline = nil
    }

    private func minTimestamp(_ lhs: BindTimestamp?, _ rhs: BindTimestamp) -> BindTimestamp {
        guard let lhs else { return rhs }
        return lhs < rhs ? lhs : rhs
    }
}
