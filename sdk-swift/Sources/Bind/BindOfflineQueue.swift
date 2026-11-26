import Foundation

/// Persisted metadata for an immutable prepared batch stored in the offline queue directory.
internal struct BindPersistedBatchMetadata: Codable, Sendable, Hashable {
    var sequence: UInt64
    var batchID: UUID
    var createdAt: BindTimestamp
    var recordCount: Int
    var droppedCount: UInt64
    var uncompressedByteCount: Int
    var compressedByteCount: Int
    var attemptCount: Int
    var nextAttemptAt: BindTimestamp?
    var retryAfterPinned: Bool
}

/// Handle to a persisted batch on disk, including the direct file URL for background `URLSession` upload.
internal struct BindStoredBatch: Sendable, Hashable {
    var metadata: BindPersistedBatchMetadata
    let payloadURL: URL
    let metadataURL: URL
    var diskBytes: Int
}

internal struct BindOfflineEnqueueResult: Sendable {
    let stored: BindStoredBatch?
    let evictedRecords: UInt64
}

/// Size-capped, atomic file-backed queue of immutable `BindPreparedBatch` entries.
internal final class BindOfflineQueue: @unchecked Sendable {
    let directory: URL
    let maxDiskBytes: Int
    private let fileManager: FileManager
    private var itemsByID: [UUID: BindStoredBatch] = [:]
    private var orderedIDs: [UUID] = []
    private var nextSequence: UInt64 = 1
    private var currentDiskBytes: Int = 0

    init(directory: URL, maxDiskBytes: Int, fileManager: FileManager = .default) {
        self.directory = directory
        self.maxDiskBytes = max(1, maxDiskBytes)
        self.fileManager = fileManager
        loadFromDisk()
    }

    var ledgerURL: URL {
        directory.appendingPathComponent("daily-budget.json", isDirectory: false)
    }

    var count: Int {
        orderedIDs.count
    }

    var totalDiskBytes: Int {
        currentDiskBytes
    }

    func pendingBatches() -> [BindStoredBatch] {
        orderedIDs.compactMap { itemsByID[$0] }
    }

    func batch(for id: UUID) -> BindStoredBatch? {
        itemsByID[id]
    }

    func loadPreparedBatch(for id: UUID) -> BindPreparedBatch? {
        guard let stored = itemsByID[id],
              let payload = try? Data(contentsOf: stored.payloadURL)
        else {
            return nil
        }
        return BindPreparedBatch(
            batchID: stored.metadata.batchID,
            createdAt: stored.metadata.createdAt,
            recordCount: stored.metadata.recordCount,
            droppedCount: stored.metadata.droppedCount,
            uncompressedByteCount: stored.metadata.uncompressedByteCount,
            compressedPayload: payload
        )
    }

    /// Persists an immutable prepared batch to disk, evicting oldest batches if needed to stay under `maxDiskBytes`.
    func enqueue(
        _ batch: BindPreparedBatch,
        inFlightIDs: Set<UUID>
    ) -> BindOfflineEnqueueResult {
        do {
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            return BindOfflineEnqueueResult(stored: nil, evictedRecords: 0)
        }

        let seq = nextSequence
        nextSequence &+= 1
        let stem = Self.fileStem(sequence: seq, batchID: batch.batchID)
        let payloadURL = directory.appendingPathComponent("\(stem).bin.gz", isDirectory: false)
        let metadataURL = directory.appendingPathComponent("\(stem).meta.json", isDirectory: false)

        let metadata = BindPersistedBatchMetadata(
            sequence: seq,
            batchID: batch.batchID,
            createdAt: batch.createdAt,
            recordCount: batch.recordCount,
            droppedCount: batch.droppedCount,
            uncompressedByteCount: batch.uncompressedByteCount,
            compressedByteCount: batch.compressedByteCount,
            attemptCount: 0,
            nextAttemptAt: nil,
            retryAfterPinned: false
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        guard let metaData = try? encoder.encode(metadata) else {
            return BindOfflineEnqueueResult(stored: nil, evictedRecords: 0)
        }

        let incomingDiskBytes = batch.compressedPayload.count + metaData.count
        if incomingDiskBytes > maxDiskBytes {
            return BindOfflineEnqueueResult(stored: nil, evictedRecords: 0)
        }

        var evictedRecords: UInt64 = 0
        while currentDiskBytes + incomingDiskBytes > maxDiskBytes {
            guard let victimID = oldestEvictableID(excluding: inFlightIDs) else {
                break
            }
            if let victim = itemsByID[victimID] {
                evictedRecords &+= UInt64(max(0, victim.metadata.recordCount)) &+ victim.metadata.droppedCount
            }
            remove(batchID: victimID)
        }

        if currentDiskBytes + incomingDiskBytes > maxDiskBytes {
            return BindOfflineEnqueueResult(stored: nil, evictedRecords: evictedRecords)
        }

        do {
            try batch.compressedPayload.write(to: payloadURL, options: [.atomic])
            try metaData.write(to: metadataURL, options: [.atomic])
        } catch {
            try? fileManager.removeItem(at: payloadURL)
            try? fileManager.removeItem(at: metadataURL)
            return BindOfflineEnqueueResult(stored: nil, evictedRecords: evictedRecords)
        }

        let stored = BindStoredBatch(
            metadata: metadata,
            payloadURL: payloadURL,
            metadataURL: metadataURL,
            diskBytes: incomingDiskBytes
        )
        itemsByID[batch.batchID] = stored
        orderedIDs.append(batch.batchID)
        currentDiskBytes += incomingDiskBytes
        return BindOfflineEnqueueResult(stored: stored, evictedRecords: evictedRecords)
    }

    /// Updates retry attempt count and schedule without modifying the immutable `.bin.gz` payload file.
    func updateRetry(
        batchID: UUID,
        attemptCount: Int,
        nextAttemptAt: BindTimestamp?,
        retryAfterPinned: Bool
    ) {
        guard var stored = itemsByID[batchID] else { return }
        let oldMetaSize = stored.diskBytes - stored.metadata.compressedByteCount
        stored.metadata.attemptCount = attemptCount
        stored.metadata.nextAttemptAt = nextAttemptAt
        stored.metadata.retryAfterPinned = retryAfterPinned

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        if let metaData = try? encoder.encode(stored.metadata) {
            try? metaData.write(to: stored.metadataURL, options: [.atomic])
            let newDiskBytes = stored.metadata.compressedByteCount + metaData.count
            currentDiskBytes = max(0, currentDiskBytes - oldMetaSize + metaData.count)
            stored.diskBytes = newDiskBytes
        }
        itemsByID[batchID] = stored
    }

    /// Clears non-`Retry-After` backoff timers so batches upload immediately when connectivity returns.
    func clearNonPinnedBackoff() {
        for id in orderedIDs {
            guard let stored = itemsByID[id] else { continue }
            if !stored.metadata.retryAfterPinned && stored.metadata.nextAttemptAt != nil {
                updateRetry(
                    batchID: id,
                    attemptCount: stored.metadata.attemptCount,
                    nextAttemptAt: nil,
                    retryAfterPinned: false
                )
            }
        }
    }

    /// Removes a completed or permanently rejected batch from disk.
    func remove(batchID: UUID) {
        guard let stored = itemsByID.removeValue(forKey: batchID) else {
            return
        }
        if let idx = orderedIDs.firstIndex(of: batchID) {
            orderedIDs.remove(at: idx)
        }
        currentDiskBytes = max(0, currentDiskBytes - stored.diskBytes)
        try? fileManager.removeItem(at: stored.payloadURL)
        try? fileManager.removeItem(at: stored.metadataURL)
    }

    // MARK: - Loading & Reconciliation

    private func loadFromDisk() {
        guard fileManager.fileExists(atPath: directory.path) else {
            return
        }
        guard let contents = try? fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.fileSizeKey],
            options: [.skipsHiddenFiles]
        ) else {
            return
        }

        var loaded: [BindStoredBatch] = []
        var validPayloads: Set<String> = []
        let decoder = JSONDecoder()

        for url in contents where url.lastPathComponent.hasSuffix(".meta.json") {
            let fileName = url.lastPathComponent
            let stem = String(fileName.dropLast(".meta.json".count))
            let payloadURL = directory.appendingPathComponent("\(stem).bin.gz", isDirectory: false)

            guard fileManager.fileExists(atPath: payloadURL.path),
                  let metaData = try? Data(contentsOf: url),
                  let metadata = try? decoder.decode(BindPersistedBatchMetadata.self, from: metaData)
            else {
                try? fileManager.removeItem(at: url)
                continue
            }

            let payloadSize = (try? payloadURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? metadata.compressedByteCount
            let diskBytes = payloadSize + metaData.count
            let stored = BindStoredBatch(
                metadata: metadata,
                payloadURL: payloadURL,
                metadataURL: url,
                diskBytes: diskBytes
            )
            loaded.append(stored)
            validPayloads.insert(payloadURL.lastPathComponent)
        }

        // Remove orphaned .bin.gz files whose sidecar metadata was never committed or was deleted.
        for url in contents where url.lastPathComponent.hasSuffix(".bin.gz") {
            if !validPayloads.contains(url.lastPathComponent) {
                try? fileManager.removeItem(at: url)
            }
        }

        loaded.sort { lhs, rhs in
            if lhs.metadata.sequence != rhs.metadata.sequence {
                return lhs.metadata.sequence < rhs.metadata.sequence
            }
            return lhs.metadata.createdAt < rhs.metadata.createdAt
        }

        var maxSeq: UInt64 = 0
        for item in loaded {
            itemsByID[item.metadata.batchID] = item
            orderedIDs.append(item.metadata.batchID)
            currentDiskBytes += item.diskBytes
            maxSeq = max(maxSeq, item.metadata.sequence)
        }
        nextSequence = maxSeq &+ 1
    }

    private func oldestEvictableID(excluding inFlightIDs: Set<UUID>) -> UUID? {
        if let candidate = orderedIDs.first(where: { !inFlightIDs.contains($0) }) {
            return candidate
        }
        return orderedIDs.first
    }

    private static func fileStem(sequence: UInt64, batchID: UUID) -> String {
        let raw = String(sequence)
        let padded = raw.count >= 20 ? raw : String(repeating: "0", count: 20 - raw.count) + raw
        return "\(padded)_\(batchID.uuidString.lowercased())"
    }
}
