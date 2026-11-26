import Foundation

/// A JSON-compatible, strongly typed value stored in log bodies, template arguments, and edge fields.
public enum BindValue: Sendable, Hashable {
    case null
    case bool(Bool)
    case int(Int64)
    case uint(UInt64)
    case double(Double)
    case string(String)
    case array([BindValue])
    case object([String: BindValue])

    /// Normalizes unsigned integers that fit in `Int64` to `.int` so JSON round-trips are canonical.
    public static func unsigned(_ value: UInt64) -> BindValue {
        if value <= UInt64(Int64.max) {
            return .int(Int64(value))
        }
        return .uint(value)
    }

    /// Converts finite floating-point numbers to `.double` and non-finite values to `.string`
    /// so JSON encoding never fails.
    public static func number(_ value: Double) -> BindValue {
        value.isFinite ? .double(value) : .string(String(value))
    }

    /// Converts an `Encodable` value into a `BindValue`, falling back to `String(describing:)` on failure.
    public static func fromEncodable<T: Encodable>(_ value: T) -> BindValue {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        guard let data = try? encoder.encode(value),
              let decoded = try? JSONDecoder().decode(BindValue.self, from: data)
        else {
            return .string(String(describing: value))
        }
        return decoded
    }

    /// Renders the value as a human-readable string segment for interpolated message bodies.
    public var renderedDescription: String {
        switch self {
        case .null:
            return "nil"
        case .bool(let value):
            return value ? "true" : "false"
        case .int(let value):
            return String(value)
        case .uint(let value):
            return String(value)
        case .double(let value):
            return String(value)
        case .string(let value):
            return value
        case .array, .object:
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            guard let data = try? encoder.encode(self),
                  let json = String(data: data, encoding: .utf8)
            else {
                return String(describing: self)
            }
            return json
        }
    }
}

extension BindValue: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        if container.decodeNil() {
            self = .null
        } else if let boolValue = try? container.decode(Bool.self) {
            self = .bool(boolValue)
        } else if let intValue = try? container.decode(Int64.self) {
            self = .int(intValue)
        } else if let uintValue = try? container.decode(UInt64.self) {
            self = .unsigned(uintValue)
        } else if let doubleValue = try? container.decode(Double.self) {
            self = .double(doubleValue)
        } else if let stringValue = try? container.decode(String.self) {
            self = .string(stringValue)
        } else if let arrayValue = try? container.decode([BindValue].self) {
            self = .array(arrayValue)
        } else if let objectValue = try? container.decode([String: BindValue].self) {
            self = .object(objectValue)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported JSON value for BindValue."
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()

        switch self {
        case .null:
            try container.encodeNil()
        case .bool(let value):
            try container.encode(value)
        case .int(let value):
            try container.encode(value)
        case .uint(let value):
            try container.encode(value)
        case .double(let value):
            if value.isFinite {
                try container.encode(value)
            } else {
                try container.encode(String(value))
            }
        case .string(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        }
    }
}

extension BindValue: ExpressibleByNilLiteral {
    public init(nilLiteral: ()) {
        self = .null
    }
}

extension BindValue: ExpressibleByBooleanLiteral {
    public init(booleanLiteral value: Bool) {
        self = .bool(value)
    }
}

extension BindValue: ExpressibleByIntegerLiteral {
    public init(integerLiteral value: Int64) {
        self = .int(value)
    }
}

extension BindValue: ExpressibleByFloatLiteral {
    public init(floatLiteral value: Double) {
        self = .number(value)
    }
}

extension BindValue: ExpressibleByStringLiteral {
    public init(stringLiteral value: String) {
        self = .string(value)
    }
}

extension BindValue: ExpressibleByArrayLiteral {
    public init(arrayLiteral elements: BindValue...) {
        self = .array(elements)
    }
}

extension BindValue: ExpressibleByDictionaryLiteral {
    public init(dictionaryLiteral elements: (String, BindValue)...) {
        var dictionary: [String: BindValue] = [:]
        dictionary.reserveCapacity(elements.count)
        for (key, value) in elements {
            dictionary[key] = value
        }
        self = .object(dictionary)
    }
}
