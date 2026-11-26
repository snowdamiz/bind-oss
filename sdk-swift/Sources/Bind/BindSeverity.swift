/// OpenTelemetry-compatible log severity number in the range `0...24`.
public struct BindSeverity: RawRepresentable, Sendable, Hashable, Comparable, Codable {
    public static let minRawValue: UInt8 = 0
    public static let maxRawValue: UInt8 = 24

    public let rawValue: UInt8

    public init?(rawValue: UInt8) {
        guard rawValue <= Self.maxRawValue else {
            return nil
        }
        self.rawValue = rawValue
    }

    private init(unchecked rawValue: UInt8) {
        self.rawValue = rawValue
    }

    public static let unspecified = BindSeverity(unchecked: 0)

    public static let trace = BindSeverity(unchecked: 1)
    public static let trace2 = BindSeverity(unchecked: 2)
    public static let trace3 = BindSeverity(unchecked: 3)
    public static let trace4 = BindSeverity(unchecked: 4)

    public static let debug = BindSeverity(unchecked: 5)
    public static let debug2 = BindSeverity(unchecked: 6)
    public static let debug3 = BindSeverity(unchecked: 7)
    public static let debug4 = BindSeverity(unchecked: 8)

    public static let info = BindSeverity(unchecked: 9)
    public static let info2 = BindSeverity(unchecked: 10)
    public static let notice = BindSeverity(unchecked: 10)
    public static let info3 = BindSeverity(unchecked: 11)
    public static let info4 = BindSeverity(unchecked: 12)

    public static let warn = BindSeverity(unchecked: 13)
    public static let warn2 = BindSeverity(unchecked: 14)
    public static let warn3 = BindSeverity(unchecked: 15)
    public static let warn4 = BindSeverity(unchecked: 16)

    public static let error = BindSeverity(unchecked: 17)
    public static let error2 = BindSeverity(unchecked: 18)
    public static let error3 = BindSeverity(unchecked: 19)
    public static let error4 = BindSeverity(unchecked: 20)

    public static let fatal = BindSeverity(unchecked: 21)
    public static let fatal2 = BindSeverity(unchecked: 22)
    public static let fatal3 = BindSeverity(unchecked: 23)
    public static let fatal4 = BindSeverity(unchecked: 24)

    public static func < (lhs: BindSeverity, rhs: BindSeverity) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = try container.decode(UInt8.self)
        guard let severity = BindSeverity(rawValue: value) else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Severity \(value) is outside the valid range 0...24."
            )
        }
        self = severity
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}
