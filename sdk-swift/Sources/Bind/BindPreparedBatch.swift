import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// An immutable, gzip-compressed batch sealed for delivery and retry.
///
/// Encoding and compressing once guarantees that every retry (in-memory, across offline
/// disk persistence, or via a background `URLSession` file upload) transmits the exact
/// same `batch_id` and byte payload.
public struct BindPreparedBatch: Sendable, Hashable {
    public let batchID: UUID
    public let createdAt: BindTimestamp
    public let recordCount: Int
    public let droppedCount: UInt64
    public let uncompressedByteCount: Int
    public let compressedPayload: Data

    public init(
        batchID: UUID,
        createdAt: BindTimestamp,
        recordCount: Int,
        droppedCount: UInt64,
        uncompressedByteCount: Int,
        compressedPayload: Data
    ) {
        self.batchID = batchID
        self.createdAt = createdAt
        self.recordCount = recordCount
        self.droppedCount = droppedCount
        self.uncompressedByteCount = uncompressedByteCount
        self.compressedPayload = compressedPayload
    }

    public var compressedByteCount: Int {
        compressedPayload.count
    }

    /// Encodes `envelope` to UTF-8 JSON and gzip-compresses it once into an immutable batch.
    public static func prepare(
        envelope: BindBatchEnvelope,
        createdAt: BindTimestamp = BindTimestamp.now()
    ) throws -> BindPreparedBatch {
        let jsonData = try envelope.encodeJSON()
        let compressed = try BindGzip.compress(jsonData)
        return BindPreparedBatch(
            batchID: envelope.batchID,
            createdAt: createdAt,
            recordCount: envelope.records.count,
            droppedCount: envelope.dropped ?? 0,
            uncompressedByteCount: jsonData.count,
            compressedPayload: compressed
        )
    }

    /// Builds the `POST /v1/batch` HTTP request for this prepared batch (headers only; body is supplied via upload task).
    public func makeURLRequest(configuration: BindConfiguration) -> URLRequest {
        var request = URLRequest(url: configuration.batchEndpointURL)
        request.httpMethod = BindProtocol.batchHTTPMethod
        request.timeoutInterval = configuration.retry.requestTimeout
        request.setValue(
            BindProtocol.authorizationValue(ingestKey: configuration.ingestKey),
            forHTTPHeaderField: BindProtocol.authorizationHeader
        )
        request.setValue(
            BindProtocol.contentTypeJSON,
            forHTTPHeaderField: BindProtocol.contentTypeHeader
        )
        request.setValue(
            BindProtocol.contentEncodingGzip,
            forHTTPHeaderField: BindProtocol.contentEncodingHeader
        )
        return request
    }
}
