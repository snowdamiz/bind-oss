import Foundation

/// Action hints returned by `BindMemoryQueue.enqueue(_:)` to wake the background transport engine.
internal struct BindQueueEnqueueEffect: Sendable {
    let becameNonEmpty: Bool
    let shouldFlushForCount: Bool
    let shouldCheckCompressedSize: Bool
    let droppedOnEnqueue: UInt64
}

/// Snapshot of in-memory queue metrics for diagnostics and testing.
internal struct BindMemoryQueueSnapshot: Sendable {
    let recordCount: Int
    let byteCount: Int
    let pendingDroppedCount: UInt64
}

/// Lock-protected, byte-bounded in-memory record queue.
///
/// Enqueueing is synchronous, non-blocking, and non-throwing. When full, the oldest
/// debug-level (`severity <= .debug4`) records are evicted first before older higher-severity
/// records, and every drop is counted for inclusion in the next batch envelope.
internal final class BindMemoryQueue: Sendable {
    private struct Entry: Sendable {
        let record: BindRecord
        let estimatedBytes: Int
    }

    private struct State: Sendable {
        var entries: [Entry] = []
        var currentBytes: Int = 0
        var droppedCount: UInt64 = 0
        var nextCompressedCheckBytes: Int
    }

    private let maxMemoryBytes: Int
    private let maxBatchRecords: Int
    private let maxBatchCompressedBytes: Int
    private let state: BindLockedState<State>

    init(
        maxMemoryBytes: Int,
        maxBatchRecords: Int,
        maxBatchCompressedBytes: Int
    ) {
        self.maxMemoryBytes = max(128, maxMemoryBytes)
        self.maxBatchRecords = max(1, maxBatchRecords)
        self.maxBatchCompressedBytes = max(128, maxBatchCompressedBytes)
        self.state = BindLockedState(
            State(nextCompressedCheckBytes: max(128, maxBatchCompressedBytes))
        )
    }

    func enqueue(_ record: BindRecord) -> BindQueueEnqueueEffect {
        let recordBytes = Self.estimateByteSize(of: record)
        let incomingIsDebugOrLower = Self.isDebugLevel(record.severity)

        return state.withLock { s in
            let wasEmpty = s.entries.isEmpty

            if recordBytes > maxMemoryBytes {
                s.droppedCount &+= 1
                return BindQueueEnqueueEffect(
                    becameNonEmpty: false,
                    shouldFlushForCount: false,
                    shouldCheckCompressedSize: false,
                    droppedOnEnqueue: 1
                )
            }

            var droppedThisCall: UInt64 = 0
            while s.currentBytes + recordBytes > maxMemoryBytes {
                if let debugIdx = s.entries.firstIndex(where: { Self.isDebugLevel($0.record.severity) }) {
                    let removed = s.entries.remove(at: debugIdx)
                    s.currentBytes -= removed.estimatedBytes
                    s.droppedCount &+= 1
                    droppedThisCall &+= 1
                } else if incomingIsDebugOrLower {
                    // Queue is full of higher-severity records; drop incoming debug record rather than evicting info/error.
                    s.droppedCount &+= 1
                    droppedThisCall &+= 1
                    return BindQueueEnqueueEffect(
                        becameNonEmpty: false,
                        shouldFlushForCount: s.entries.count >= maxBatchRecords,
                        shouldCheckCompressedSize: s.currentBytes >= s.nextCompressedCheckBytes,
                        droppedOnEnqueue: droppedThisCall
                    )
                } else if !s.entries.isEmpty {
                    let removed = s.entries.removeFirst()
                    s.currentBytes -= removed.estimatedBytes
                    s.droppedCount &+= 1
                    droppedThisCall &+= 1
                } else {
                    break
                }
            }

            s.entries.append(Entry(record: record, estimatedBytes: recordBytes))
            s.currentBytes += recordBytes

            return BindQueueEnqueueEffect(
                becameNonEmpty: wasEmpty && !s.entries.isEmpty,
                shouldFlushForCount: s.entries.count >= maxBatchRecords,
                shouldCheckCompressedSize: s.currentBytes >= s.nextCompressedCheckBytes,
                droppedOnEnqueue: droppedThisCall
            )
        }
    }

    /// Adds drops caused outside the memory queue (for example, offline disk cap evictions).
    func recordExternalDrops(_ count: UInt64) {
        guard count > 0 else { return }
        state.withLock { s in
            s.droppedCount &+= count
        }
    }

    /// Peeks up to `maxBatchRecords` records without removing them (used for compressed size checks).
    func peekFrontBatch() -> (records: [BindRecord], estimatedBytes: Int) {
        state.withLock { s in
            let count = min(maxBatchRecords, s.entries.count)
            guard count > 0 else { return ([], 0) }
            var records: [BindRecord] = []
            records.reserveCapacity(count)
            var bytes = 0
            for idx in 0..<count {
                records.append(s.entries[idx].record)
                bytes += s.entries[idx].estimatedBytes
            }
            return (records, bytes)
        }
    }

    /// Advances the next byte threshold at which the engine should re-measure compressed batch size.
    func updateNextCompressedCheckBytes(_ nextThreshold: Int) {
        state.withLock { s in
            s.nextCompressedCheckBytes = max(maxBatchCompressedBytes, nextThreshold)
        }
    }

    /// Removes up to `maxBatchRecords` entries from the front together with the accumulated drop count.
    func popBatch() -> (records: [BindRecord], dropped: UInt64)? {
        state.withLock { s in
            guard !s.entries.isEmpty else {
                return nil
            }
            let takeCount = min(maxBatchRecords, s.entries.count)
            var records: [BindRecord] = []
            records.reserveCapacity(takeCount)
            var removedBytes = 0
            for idx in 0..<takeCount {
                records.append(s.entries[idx].record)
                removedBytes += s.entries[idx].estimatedBytes
            }
            s.entries.removeFirst(takeCount)
            s.currentBytes = max(0, s.currentBytes - removedBytes)
            let dropped = s.droppedCount
            s.droppedCount = 0
            s.nextCompressedCheckBytes = maxBatchCompressedBytes
            return (records, dropped)
        }
    }

    /// Re-inserts leftover records at the head of the queue when a batch had to be split for compressed size.
    func prependLeftovers(_ records: [BindRecord], restoredDropped: UInt64 = 0) {
        guard !records.isEmpty || restoredDropped > 0 else { return }
        let entries = records.map { Entry(record: $0, estimatedBytes: Self.estimateByteSize(of: $0)) }
        let addedBytes = entries.reduce(0) { $0 + $1.estimatedBytes }
        state.withLock { s in
            if !entries.isEmpty {
                s.entries.insert(contentsOf: entries, at: 0)
                s.currentBytes += addedBytes
            }
            s.droppedCount &+= restoredDropped
            s.nextCompressedCheckBytes = maxBatchCompressedBytes
        }
    }

    func snapshot() -> BindMemoryQueueSnapshot {
        state.withLock { s in
            BindMemoryQueueSnapshot(
                recordCount: s.entries.count,
                byteCount: s.currentBytes,
                pendingDroppedCount: s.droppedCount
            )
        }
    }

    static func isDebugLevel(_ severity: BindSeverity) -> Bool {
        severity.rawValue <= BindSeverity.debug4.rawValue
    }

    /// Fast, deterministic UTF-8 wire-size estimate for bounded-memory accounting.
    static func estimateByteSize(of record: BindRecord) -> Int {
        // Base JSON framing: {"ts":"1795636278123456789","severity":9,"body":...}
        var total = 64
        total += estimateValueBytes(record.body)

        if let tpl = record.tpl {
            total += 24
            for literal in tpl.strings {
                total += literal.utf8.count + 3
            }
            for arg in tpl.args {
                total += estimateValueBytes(arg) + 1
            }
        }

        if let callsite = record.callsite {
            total += 36 + callsite.file.utf8.count
            if let function = callsite.function {
                total += function.utf8.count + 14
            }
            if callsite.column != nil {
                total += 12
            }
        }

        if let attrs = record.attrs {
            total += 12
            for (k, v) in attrs {
                total += k.utf8.count + v.utf8.count + 6
            }
        }

        if let traceID = record.traceID {
            total += traceID.utf8.count + 14
        }
        if let spanID = record.spanID {
            total += spanID.utf8.count + 13
        }

        if let edge = record.edge {
            total += 48 + edge.template.utf8.count
            for (k, v) in edge.fields {
                total += k.utf8.count + estimateValueBytes(v) + 5
            }
        }

        return total
    }

    private static func estimateValueBytes(_ value: BindValue) -> Int {
        switch value {
        case .null:
            return 4
        case .bool(let b):
            return b ? 4 : 5
        case .int:
            return 12
        case .uint:
            return 12
        case .double:
            return 16
        case .string(let s):
            return s.utf8.count + 2
        case .array(let items):
            var sum = 2
            for item in items {
                sum += estimateValueBytes(item) + 1
            }
            return sum
        case .object(let map):
            var sum = 2
            for (k, v) in map {
                sum += k.utf8.count + estimateValueBytes(v) + 4
            }
            return sum
        }
    }
}
