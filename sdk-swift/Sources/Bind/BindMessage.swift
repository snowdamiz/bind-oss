import Foundation

/// A captured string-interpolation template with literal parts and typed argument values.
///
/// Follows the invariant `strings.count == args.count + 1`, where `strings[i]` appears
/// immediately before `args[i]` and `strings[args.count]` is the trailing literal segment.
public struct BindTemplate: Sendable, Hashable, Codable {
    public let strings: [String]
    public let args: [BindValue]

    public init(strings: [String], args: [BindValue]) {
        self.strings = strings
        self.args = args
    }
}

/// A structured log message built via Swift string interpolation.
///
/// Captures literal template segments (`strings`), typed interpolated values (`args`),
/// and the rendered message text (`rendered`) in a single pass with zero runtime
/// format-string parsing.
public struct BindMessage: Sendable, Hashable, ExpressibleByStringInterpolation {
    public let template: BindTemplate
    public let rendered: String

    public var strings: [String] { template.strings }
    public var args: [BindValue] { template.args }

    public init(stringLiteral value: String) {
        self.template = BindTemplate(strings: [value], args: [])
        self.rendered = value
    }

    public init(stringInterpolation: StringInterpolation) {
        self.template = BindTemplate(
            strings: stringInterpolation.strings,
            args: stringInterpolation.args
        )
        self.rendered = stringInterpolation.rendered
    }

    public struct StringInterpolation: StringInterpolationProtocol {
        fileprivate var strings: [String]
        fileprivate var args: [BindValue]
        fileprivate var rendered: String

        public init(literalCapacity: Int, interpolationCount: Int) {
            self.strings = [""]
            self.strings.reserveCapacity(interpolationCount + 1)
            self.args = []
            self.args.reserveCapacity(interpolationCount)
            self.rendered = ""
            self.rendered.reserveCapacity(literalCapacity + interpolationCount * 8)
        }

        public mutating func appendLiteral(_ literal: String) {
            strings[strings.count - 1].append(literal)
            rendered.append(literal)
        }

        private mutating func appendValue(_ value: BindValue, renderedText: String? = nil) {
            args.append(value)
            strings.append("")
            rendered.append(renderedText ?? value.renderedDescription)
        }

        // MARK: - String types

        public mutating func appendInterpolation(_ value: String) {
            appendValue(.string(value), renderedText: value)
        }

        public mutating func appendInterpolation(_ value: String?) {
            if let value {
                appendInterpolation(value)
            } else {
                appendValue(.null)
            }
        }

        public mutating func appendInterpolation(_ value: Substring) {
            let string = String(value)
            appendValue(.string(string), renderedText: string)
        }

        public mutating func appendInterpolation(_ value: Substring?) {
            if let value {
                appendInterpolation(value)
            } else {
                appendValue(.null)
            }
        }

        public mutating func appendInterpolation(_ value: StaticString) {
            let string = value.description
            appendValue(.string(string), renderedText: string)
        }

        // MARK: - Boolean

        public mutating func appendInterpolation(_ value: Bool) {
            appendValue(.bool(value))
        }

        public mutating func appendInterpolation(_ value: Bool?) {
            if let value {
                appendInterpolation(value)
            } else {
                appendValue(.null)
            }
        }

        // MARK: - Signed integers

        public mutating func appendInterpolation(_ value: Int) {
            appendValue(.int(Int64(value)))
        }

        public mutating func appendInterpolation(_ value: Int?) {
            if let value {
                appendInterpolation(value)
            } else {
                appendValue(.null)
            }
        }

        public mutating func appendInterpolation(_ value: Int8) {
            appendValue(.int(Int64(value)))
        }

        public mutating func appendInterpolation(_ value: Int8?) {
            if let value {
                appendInterpolation(value)
            } else {
                appendValue(.null)
            }
        }

        public mutating func appendInterpolation(_ value: Int16) {
            appendValue(.int(Int64(value)))
        }

        public mutating func appendInterpolation(_ value: Int16?) {
            if let value {
                appendInterpolation(value)
            } else {
                appendValue(.null)
            }
        }

        public mutating func appendInterpolation(_ value: Int32) {
            appendValue(.int(Int64(value)))
        }

        public mutating func appendInterpolation(_ value: Int32?) {
            if let value {
                appendInterpolation(value)
            } else {
                appendValue(.null)
            }
        }

        public mutating func appendInterpolation(_ value: Int64) {
            appendValue(.int(value))
        }

        public mutating func appendInterpolation(_ value: Int64?) {
            if let value {
                appendInterpolation(value)
            } else {
                appendValue(.null)
            }
        }

        // MARK: - Unsigned integers

        public mutating func appendInterpolation(_ value: UInt) {
            appendValue(.unsigned(UInt64(value)))
        }

        public mutating func appendInterpolation(_ value: UInt?) {
            if let value {
                appendInterpolation(value)
            } else {
                appendValue(.null)
            }
        }

        public mutating func appendInterpolation(_ value: UInt8) {
            appendValue(.unsigned(UInt64(value)))
        }

        public mutating func appendInterpolation(_ value: UInt8?) {
            if let value {
                appendInterpolation(value)
            } else {
                appendValue(.null)
            }
        }

        public mutating func appendInterpolation(_ value: UInt16) {
            appendValue(.unsigned(UInt64(value)))
        }

        public mutating func appendInterpolation(_ value: UInt16?) {
            if let value {
                appendInterpolation(value)
            } else {
                appendValue(.null)
            }
        }

        public mutating func appendInterpolation(_ value: UInt32) {
            appendValue(.unsigned(UInt64(value)))
        }

        public mutating func appendInterpolation(_ value: UInt32?) {
            if let value {
                appendInterpolation(value)
            } else {
                appendValue(.null)
            }
        }

        public mutating func appendInterpolation(_ value: UInt64) {
            appendValue(.unsigned(value))
        }

        public mutating func appendInterpolation(_ value: UInt64?) {
            if let value {
                appendInterpolation(value)
            } else {
                appendValue(.null)
            }
        }

        // MARK: - Floating point

        public mutating func appendInterpolation(_ value: Double) {
            appendValue(.number(value), renderedText: String(value))
        }

        public mutating func appendInterpolation(_ value: Double?) {
            if let value {
                appendInterpolation(value)
            } else {
                appendValue(.null)
            }
        }

        public mutating func appendInterpolation(_ value: Float) {
            appendValue(.number(Double(value)), renderedText: String(value))
        }

        public mutating func appendInterpolation(_ value: Float?) {
            if let value {
                appendInterpolation(value)
            } else {
                appendValue(.null)
            }
        }

        // MARK: - Structured BindValue & JSON Encodable

        public mutating func appendInterpolation(_ value: BindValue) {
            appendValue(value)
        }

        public mutating func appendInterpolation(_ value: BindValue?) {
            if let value {
                appendInterpolation(value)
            } else {
                appendValue(.null)
            }
        }

        public mutating func appendInterpolation<T: Encodable>(json value: T) {
            appendValue(.fromEncodable(value))
        }

        public mutating func appendInterpolation<T: Encodable>(json value: T?) {
            if let value {
                appendValue(.fromEncodable(value))
            } else {
                appendValue(.null)
            }
        }

        // MARK: - Common Foundation & Error types

        public mutating func appendInterpolation(_ value: UUID) {
            let text = value.uuidString
            appendValue(.string(text), renderedText: text)
        }

        public mutating func appendInterpolation(_ value: UUID?) {
            if let value {
                appendInterpolation(value)
            } else {
                appendValue(.null)
            }
        }

        public mutating func appendInterpolation(_ value: URL) {
            let text = value.absoluteString
            appendValue(.string(text), renderedText: text)
        }

        public mutating func appendInterpolation(_ value: URL?) {
            if let value {
                appendInterpolation(value)
            } else {
                appendValue(.null)
            }
        }

        public mutating func appendInterpolation(_ value: any Error) {
            let text = String(describing: value)
            appendValue(.string(text), renderedText: text)
        }

        public mutating func appendInterpolation(_ value: (any Error)?) {
            if let value {
                appendInterpolation(value)
            } else {
                appendValue(.null)
            }
        }

        // MARK: - Generic fallbacks

        public mutating func appendInterpolation<T: CustomStringConvertible>(_ value: T) {
            let text = value.description
            appendValue(.string(text), renderedText: text)
        }

        public mutating func appendInterpolation<T: CustomStringConvertible>(_ value: T?) {
            if let value {
                appendInterpolation(value)
            } else {
                appendValue(.null)
            }
        }

        public mutating func appendInterpolation<T>(_ value: T) {
            let text = String(describing: value)
            appendValue(.string(text), renderedText: text)
        }

        public mutating func appendInterpolation<T>(_ value: T?) {
            if let value {
                appendInterpolation(value)
            } else {
                appendValue(.null)
            }
        }
    }
}
