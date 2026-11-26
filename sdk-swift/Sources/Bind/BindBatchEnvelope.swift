import Foundation

/// HTTP protocol constants for Bind batch ingestion (`POST /v1/batch`).
public enum BindProtocol {
    public static let batchPath = "/v1/batch"
    public static let batchHTTPMethod = "POST"
    public static let authorizationHeader = "Authorization"
    public static let contentTypeHeader = "Content-Type"
    public static let contentEncodingHeader = "Content-Encoding"
    public static let contentTypeJSON = "application/json"
    public static let contentEncodingGzip = "gzip"

    public static func authorizationValue(ingestKey: String) -> String {
        "Bearer \(ingestKey)"
    }
}

/// Top-level JSON payload sent to `POST /v1/batch`.
public struct BindBatchEnvelope: Sendable, Hashable, Codable {
    public let batchID: UUID
    public let service: String
    public let env: String
    public let release: String
    public let records: [BindRecord]
    public let dropped: UInt64?

    public init(
        batchID: UUID = UUID(),
        service: String,
        env: String,
        release: String,
        records: [BindRecord],
        dropped: UInt64? = nil
    ) {
        self.batchID = batchID
        self.service = service
        self.env = env
        self.release = release
        self.records = records
        self.dropped = dropped
    }

    private enum CodingKeys: String, CodingKey {
        case batchID = "batch_id"
        case service
        case env
        case release
        case records
        case dropped
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let batchIDString = try container.decode(String.self, forKey: .batchID)
        guard let uuid = UUID(uuidString: batchIDString) else {
            throw DecodingError.dataCorruptedError(
                forKey: .batchID,
                in: container,
                debugDescription: "Invalid UUID string for batch_id: '\(batchIDString)'."
            )
        }
        self.batchID = uuid
        self.service = try container.decode(String.self, forKey: .service)
        self.env = try container.decode(String.self, forKey: .env)
        self.release = try container.decode(String.self, forKey: .release)
        self.records = try container.decode([BindRecord].self, forKey: .records)
        self.dropped = try container.decodeIfPresent(UInt64.self, forKey: .dropped)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(batchID.uuidString.lowercased(), forKey: .batchID)
        try container.encode(service, forKey: .service)
        try container.encode(env, forKey: .env)
        try container.encode(release, forKey: .release)
        try container.encode(records, forKey: .records)
        try container.encodeIfPresent(dropped, forKey: .dropped)
    }

    /// Encodes the batch envelope as UTF-8 JSON without escaping forward slashes (preserving `#fileID` cleanly).
    public func encodeJSON(sortedKeys: Bool = false) throws -> Data {
        let encoder = JSONEncoder()
        var formatting: JSONEncoder.OutputFormatting = [.withoutEscapingSlashes]
        if sortedKeys {
            formatting.insert(.sortedKeys)
        }
        encoder.outputFormatting = formatting
        return try encoder.encode(self)
    }
}
