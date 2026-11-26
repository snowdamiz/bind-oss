/// Result of client-side edge parsing attached to a record when edge mode is enabled.
public struct BindEdgeParse: Sendable, Hashable, Codable {
    public let template: String
    public let parserVersion: UInt32
    public let fields: [String: BindValue]

    public init(template: String, parserVersion: UInt32, fields: [String: BindValue]) {
        self.template = template
        self.parserVersion = parserVersion
        self.fields = fields
    }

    private enum CodingKeys: String, CodingKey {
        case template
        case parserVersion = "parser_version"
        case fields
    }
}

/// Wire representation of a single raw log record inside a `POST /v1/batch` envelope.
///
/// `project_id` and `observed_ts` are injected server-side and are intentionally omitted here.
public struct BindRecord: Sendable, Hashable, Codable {
    public let ts: BindTimestamp
    public let severity: BindSeverity
    public let body: BindValue
    public let tpl: BindTemplate?
    public let callsite: BindCallsite?
    public let attrs: [String: String]?
    public let traceID: String?
    public let spanID: String?
    public let edge: BindEdgeParse?

    public init(
        ts: BindTimestamp,
        severity: BindSeverity,
        body: BindValue,
        tpl: BindTemplate? = nil,
        callsite: BindCallsite? = nil,
        attrs: [String: String]? = nil,
        traceID: String? = nil,
        spanID: String? = nil,
        edge: BindEdgeParse? = nil
    ) {
        self.ts = ts
        self.severity = severity
        self.body = body
        self.tpl = tpl
        self.callsite = callsite
        self.attrs = attrs
        self.traceID = traceID
        self.spanID = spanID
        self.edge = edge
    }

    private enum CodingKeys: String, CodingKey {
        case ts
        case severity
        case body
        case tpl
        case callsite
        case attrs
        case traceID = "trace_id"
        case spanID = "span_id"
        case edge
    }
}
