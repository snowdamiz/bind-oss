#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#elseif canImport(Musl)
import Musl
#else
import Foundation
#endif

/// An exact integer Unix epoch timestamp with nanosecond precision.
///
/// Encodes on the wire as a base-10 decimal nanoseconds string to preserve full
/// 64-bit+ precision across JSON parsers without floating-point rounding.
public struct BindTimestamp: Sendable, Hashable, Comparable, Codable {
    private static let nanosPerSecond: Int64 = 1_000_000_000
    private static let nanosPerSecondInt32: Int32 = 1_000_000_000

    /// Whole seconds since the Unix epoch (1970-01-01T00:00:00Z).
    public let seconds: Int64

    /// Non-negative nanosecond offset within `seconds`, always normalized to `0 ..< 1_000_000_000`.
    public let nanoseconds: Int32

    public init(seconds: Int64, nanoseconds: Int32 = 0) {
        let secAdjust = Int64(nanoseconds) / Self.nanosPerSecond
        var rem = Int64(nanoseconds) % Self.nanosPerSecond
        var normalizedSeconds = seconds + secAdjust
        if rem < 0 {
            rem += Self.nanosPerSecond
            normalizedSeconds -= 1
        }
        self.seconds = normalizedSeconds
        self.nanoseconds = Int32(rem)
    }

    public init(epochNanoseconds: Int64) {
        var sec = epochNanoseconds / Self.nanosPerSecond
        var rem = epochNanoseconds % Self.nanosPerSecond
        if rem < 0 {
            rem += Self.nanosPerSecond
            sec -= 1
        }
        self.seconds = sec
        self.nanoseconds = Int32(rem)
    }

    /// Parses a base-10 integer string representing Unix epoch nanoseconds.
    public init?(decimalNanoseconds: String) {
        guard !decimalNanoseconds.isEmpty else {
            return nil
        }

        let isNegative = decimalNanoseconds.first == "-"
        let digits = isNegative ? decimalNanoseconds.dropFirst() : decimalNanoseconds[...]
        guard !digits.isEmpty, digits.allSatisfy({ $0.isASCII && $0.isNumber }) else {
            return nil
        }

        let trimmed = digits.drop(while: { $0 == "0" })
        if trimmed.isEmpty {
            self.seconds = 0
            self.nanoseconds = 0
            return
        }

        let secMagnitude: UInt64
        let nanoMagnitude: Int32

        if trimmed.count <= 9 {
            guard let n = Int32(trimmed) else {
                return nil
            }
            secMagnitude = 0
            nanoMagnitude = n
        } else {
            let splitIndex = trimmed.index(trimmed.endIndex, offsetBy: -9)
            let secPart = trimmed[..<splitIndex]
            let nanoPart = trimmed[splitIndex...]
            guard let s = UInt64(secPart), let n = Int32(nanoPart) else {
                return nil
            }
            secMagnitude = s
            nanoMagnitude = n
        }

        if isNegative {
            if nanoMagnitude == 0 {
                if secMagnitude == UInt64(Int64.max) + 1 {
                    self.seconds = Int64.min
                    self.nanoseconds = 0
                } else if secMagnitude <= UInt64(Int64.max) {
                    self.seconds = -Int64(secMagnitude)
                    self.nanoseconds = 0
                } else {
                    return nil
                }
            } else {
                // -((secMagnitude * 10^9) + nanoMagnitude)
                // = (-(secMagnitude + 1)) * 10^9 + (10^9 - nanoMagnitude)
                if secMagnitude == UInt64(Int64.max) {
                    self.seconds = Int64.min
                    self.nanoseconds = Self.nanosPerSecondInt32 - nanoMagnitude
                } else if secMagnitude < UInt64(Int64.max) {
                    self.seconds = -Int64(secMagnitude) - 1
                    self.nanoseconds = Self.nanosPerSecondInt32 - nanoMagnitude
                } else {
                    return nil
                }
            }
        } else {
            guard secMagnitude <= UInt64(Int64.max) else {
                return nil
            }
            self.seconds = Int64(secMagnitude)
            self.nanoseconds = nanoMagnitude
        }
    }

    /// Captures the current wall-clock time using `clock_gettime(CLOCK_REALTIME)` without floating-point conversion.
    public static func now() -> BindTimestamp {
        #if canImport(Darwin) || canImport(Glibc) || canImport(Musl)
        var ts = timespec()
        clock_gettime(CLOCK_REALTIME, &ts)
        return BindTimestamp(seconds: Int64(ts.tv_sec), nanoseconds: Int32(ts.tv_nsec))
        #else
        let interval = Date().timeIntervalSince1970
        let sec = Int64(interval.rounded(.down))
        let nsec = Int32(((interval - Double(sec)) * 1_000_000_000).rounded())
        return BindTimestamp(seconds: sec, nanoseconds: nsec)
        #endif
    }

    /// Returns the exact signed 64-bit epoch nanoseconds if representable within `Int64`.
    public var epochNanoseconds: Int64? {
        let (secNanos, mulOverflow) = seconds.multipliedReportingOverflow(by: Self.nanosPerSecond)
        guard !mulOverflow else {
            return nil
        }
        let (total, addOverflow) = secNanos.addingReportingOverflow(Int64(nanoseconds))
        guard !addOverflow else {
            return nil
        }
        return total
    }

    /// Exact base-10 decimal string representation of Unix epoch nanoseconds.
    public var decimalNanoseconds: String {
        if seconds >= 0 {
            if seconds == 0 {
                return String(nanoseconds)
            }
            return "\(seconds)\(Self.paddedNanoseconds(nanoseconds))"
        }

        if nanoseconds == 0 {
            return "-\(seconds.magnitude)\(Self.paddedNanoseconds(0))"
        }

        // Negative timestamp with non-zero remainder:
        // total = seconds * 10^9 + nanoseconds = -((-(seconds + 1)) * 10^9 + (10^9 - nanoseconds))
        let magSeconds = (seconds + 1).magnitude
        let magNanos = Self.nanosPerSecondInt32 - nanoseconds
        if magSeconds == 0 {
            return "-\(magNanos)"
        }
        return "-\(magSeconds)\(Self.paddedNanoseconds(magNanos))"
    }

    private static func paddedNanoseconds(_ nanos: Int32) -> String {
        let raw = String(nanos)
        if raw.count >= 9 {
            return raw
        }
        return String(repeating: "0", count: 9 - raw.count) + raw
    }

    public static func < (lhs: BindTimestamp, rhs: BindTimestamp) -> Bool {
        if lhs.seconds != rhs.seconds {
            return lhs.seconds < rhs.seconds
        }
        return lhs.nanoseconds < rhs.nanoseconds
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        guard let parsed = BindTimestamp(decimalNanoseconds: raw) else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid decimal nanoseconds timestamp: '\(raw)'."
            )
        }
        self = parsed
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(decimalNanoseconds)
    }
}
