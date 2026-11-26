/**
 * Core types for the Bind TypeScript parser runtime (section 5 of the Bind spec).
 * Mirrors `spec/schemas/common.schema.json`, `spec/schemas/parser-spec.schema.json`,
 * and `spec/vectors/vector.schema.json`.
 */

export type FieldType =
  | "string"
  | "int"
  | "float"
  | "bool"
  | "timestamp"
  | "enum"
  | "json";

export type PiiClass =
  | "none"
  | "pseudonymous_id"
  | "email"
  | "phone"
  | "ip"
  | "name"
  | "address"
  | "secret"
  | "free_text";

export type HoleClass =
  | "word"
  | "int"
  | "float"
  | "uuid"
  | "hex"
  | "ip"
  | "time"
  | "quoted"
  | "json"
  | "until"
  | "rest";

export type MatchKind = "text" | "object" | "args";

export type SpecStatus = "provisional" | "active" | "retired";
export type SpecOrigin = "agent" | "user";
export type SourceKind = "callsite" | "sdk_template" | "mined";

export type TimeUnit = "ns" | "us" | "ms" | "s" | "m" | "h" | "d";
export type ByteUnit =
  | "B"
  | "KB"
  | "MB"
  | "GB"
  | "TB"
  | "KiB"
  | "MiB"
  | "GiB"
  | "TiB";

export type ParseTimeFormat =
  | "auto"
  | "iso8601"
  | "rfc3339"
  | "rfc2822"
  | "syslog"
  | "apache"
  | "unix_s"
  | "unix_ms"
  | "unix_us"
  | "unix_ns";

export interface LiteralSegment {
  readonly lit: string;
}

export interface HoleSegment {
  readonly hole: string;
  readonly class?: HoleClass;
}

export type TextSegment = LiteralSegment | HoleSegment;

export interface TextMatch {
  readonly kind: "text";
  readonly segments: readonly TextSegment[];
}

export interface ObjectMessageSubpattern {
  readonly path: string;
  readonly segments: readonly TextSegment[];
}

export interface ObjectMatch {
  readonly kind: "object";
  readonly shape: readonly string[];
  readonly message?: ObjectMessageSubpattern;
}

export interface ArgsMatch {
  readonly kind: "args";
  readonly strings: readonly string[];
}

export type MatchSpec = TextMatch | ObjectMatch | ArgsMatch;

export interface CastTransform {
  readonly op: "cast";
  readonly to: "string" | "int" | "float" | "bool" | "json";
}

export interface ScaleTransform {
  readonly op: "scale";
  readonly mul?: number;
  readonly div?: number;
}

export interface UnitTransform {
  readonly op: "unit";
  readonly from: TimeUnit | ByteUnit;
  readonly to: TimeUnit | ByteUnit;
}

export interface ParseTimeTransform {
  readonly op: "parse_time";
  readonly format?: ParseTimeFormat;
}

export interface LowerTransform {
  readonly op: "lower";
}

export interface EnumMapTransform {
  readonly op: "enum_map";
  readonly map: Readonly<Record<string, string>>;
  readonly default?: string;
}

export interface HashTransform {
  readonly op: "hash";
  readonly kind?: string;
}

export interface MaskTransform {
  readonly op: "mask";
  readonly mode?: "token" | "ip_prefix";
  readonly kind?: string;
}

export interface DropTransform {
  readonly op: "drop";
}

export type Transform =
  | CastTransform
  | ScaleTransform
  | UnitTransform
  | ParseTimeTransform
  | LowerTransform
  | EnumMapTransform
  | HashTransform
  | MaskTransform
  | DropTransform;

export type FieldFrom =
  | { readonly hole: string }
  | { readonly path: string }
  | { readonly arg: number };

export interface FieldEvidence {
  readonly kind?: "hole" | "payload_key" | "sample";
  readonly expr?: string;
  readonly path?: string;
  readonly line?: number;
  readonly reason?: string;
}

export interface ParserField {
  readonly id: string;
  readonly name: string;
  readonly from: FieldFrom;
  readonly type: FieldType;
  readonly semantic: string;
  readonly entity?: string;
  readonly unit?: string;
  readonly pii?: PiiClass;
  readonly transforms?: readonly Transform[];
  readonly confidence?: number;
  readonly evidence?: FieldEvidence;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface TextSpecTest {
  readonly description?: string;
  readonly line: string;
  readonly expect: Readonly<Record<string, JsonValue>>;
}

export interface ObjectSpecTest {
  readonly description?: string;
  readonly object: Readonly<Record<string, unknown>>;
  readonly expect: Readonly<Record<string, JsonValue>>;
}

export interface ArgsSpecTest {
  readonly description?: string;
  readonly args: readonly unknown[];
  readonly expect: Readonly<Record<string, JsonValue>>;
}

export type SpecTest = TextSpecTest | ObjectSpecTest | ArgsSpecTest;

export interface ParserSpec {
  readonly spec_version: 1;
  readonly template: string;
  readonly event: string;
  readonly version: number;
  readonly status: SpecStatus;
  readonly origin: SpecOrigin;
  readonly source: Readonly<Record<string, unknown>>;
  readonly match: MatchSpec;
  readonly fields: readonly ParserField[];
  readonly tests: readonly SpecTest[];
}

/**
 * UTF-8 byte offset span `[start, end)` within the matched string's UTF-8 byte sequence.
 */
export interface ByteSpan {
  readonly start: number;
  readonly end: number;
}

export type RedactionTokenKind = "mask" | "pseudonym" | "inner_pseudonym";

export interface RedactionTokenInfo {
  readonly category: RedactionTokenKind;
  readonly kind: string;
  readonly subkind?: string;
  readonly tag?: string;
  readonly innerHex?: string;
  readonly raw: string;
}

export interface HoleCapture {
  readonly name: string;
  readonly holeClass: HoleClass;
  /** Exact UTF-8 byte range `[start, end)` in the scanned text. */
  readonly span: ByteSpan;
  /** Exact matched slice (for `quoted`, includes surrounding quotes). */
  readonly raw: string;
  /** Semantic extracted string (for `quoted`, unquoted & unescaped). */
  readonly text: string;
  /** Populated when the hole matched a section 14 redaction token. */
  readonly redaction?: RedactionTokenInfo;
}

export interface TextMatchResult {
  readonly matched: true;
  readonly byteLength: number;
  readonly holes: Readonly<Record<string, HoleCapture>>;
}

export interface ObjectMatchResult {
  readonly matched: true;
  readonly object: Readonly<Record<string, unknown>>;
  readonly messagePath?: string;
  readonly messageByteLength?: number;
  readonly holes: Readonly<Record<string, HoleCapture>>;
}

export interface ArgsMatchResult {
  readonly matched: true;
  readonly args: readonly unknown[];
}

export interface NoMatchResult {
  readonly matched: false;
}

export type MatchResult =
  | TextMatchResult
  | ObjectMatchResult
  | ArgsMatchResult
  | NoMatchResult;

export interface TextVectorInput {
  readonly kind: "text";
  readonly line: string;
}

export interface ObjectVectorInput {
  readonly kind: "object";
  readonly object: Readonly<Record<string, unknown>>;
}

export interface ArgsVectorInput {
  readonly kind: "args";
  readonly strings: readonly string[];
  readonly args: readonly unknown[];
}

export type VectorInput = TextVectorInput | ObjectVectorInput | ArgsVectorInput;

export interface ArgsInput {
  readonly strings?: readonly string[];
  readonly args: readonly unknown[];
}

export type RecordInput =
  | VectorInput
  | string
  | { readonly line: string }
  | { readonly object: Readonly<Record<string, unknown>> }
  | ArgsInput
  | readonly unknown[];

export interface HashKeys {
  /** Per-project edge key (`k_edge`). String keys are UTF-8 encoded unless Uint8Array is passed. */
  readonly edgeKey?: Uint8Array | string;
  /** Per-project server key (`k_server`). String keys are UTF-8 encoded unless Uint8Array is passed. */
  readonly serverKey?: Uint8Array | string;
}

/**
 * Execution authority controlling edge inner-pseudonym (<kind:~64hex>) handling:
 * - `"hosted"` (default): canonical hosted conformance; requires both `edgeKey` and `serverKey`
 *   for `hash` and redacts unexpected incoming `<kind:~64hex>` tokens as `<redacted>`.
 * - `"edge"`: explicit edge-SDK authority allowing `hash` with `edgeKey`-only to emit `<kind:~64hex>`.
 * - `"gateway"`: explicit gateway authority allowing incoming `<kind:~64hex>` tokens on string fields
 *   with a `hash` transform and `serverKey` to upgrade to final `<kind:16hex>`.
 */
export type HashAuthorityMode = "hosted" | "edge" | "gateway";

export interface RuntimeOptions {
  readonly hashKeys?: HashKeys;
  /** Explicit hash authority mode. Defaults to `"hosted"`. */
  readonly hashMode?: HashAuthorityMode;
  /** Deterministic reference year for yearless syslog timestamps. Takes precedence over `referenceTsMs`. */
  readonly referenceYear?: number;
  /** UTC epoch milliseconds used as the record reference timestamp for yearless formats (e.g. RFC 3164 syslog). */
  readonly referenceTsMs?: number;
}

export type FieldErrorCode =
  | "MISSING_HOLE"
  | "MISSING_ARG"
  | "INVALID_SPEC"
  | "INVALID_TRANSFORM"
  | "INVALID_NUMBER"
  | "INT64_OVERFLOW"
  | "FLOAT_OVERFLOW"
  | "CAST_FAILED"
  | "INVALID_BOOL"
  | "INVALID_JSON"
  | "INVALID_TIMESTAMP"
  | "INVALID_IP"
  | "INVALID_UNIT_CONVERSION"
  | "ENUM_UNMAPPED"
  | "MISSING_HASH_KEY"
  | "EXPECTED_STRING"
  | "TYPE_MISMATCH_STRING"
  | "TYPE_MISMATCH_INT"
  | "TYPE_MISMATCH_FLOAT"
  | "TYPE_MISMATCH_BOOL"
  | "TYPE_MISMATCH_TIMESTAMP"
  | "TYPE_MISMATCH_ENUM"
  | "TYPE_MISMATCH_JSON";

export type FieldValue = string | number | bigint | boolean | JsonValue | null;

export interface ExtractedFieldOk {
  readonly status: "ok";
  readonly id: string;
  readonly name: string;
  readonly type: FieldType;
  readonly value: FieldValue;
  /** Exact 64-bit integer value for `int` and `timestamp` fields. */
  readonly int64?: bigint;
  /** True when the string value is a pseudonym token (`<kind:tag>` or `<kind:~inner>`). */
  readonly pseudonymized?: boolean;
  readonly span?: ByteSpan;
}

export interface ExtractedFieldRedacted {
  readonly status: "redacted";
  readonly id: string;
  readonly name: string;
  readonly type: FieldType;
  readonly value: null;
  readonly token: string;
  readonly span?: ByteSpan;
}

export interface ExtractedFieldDropped {
  readonly status: "dropped";
  readonly id: string;
  readonly name: string;
  readonly type: FieldType;
  readonly value: null;
  readonly span?: ByteSpan;
}

export interface ExtractedFieldMissing {
  readonly status: "missing";
  readonly id: string;
  readonly name: string;
  readonly type: FieldType;
  readonly value: null;
}

export interface ExtractedFieldError {
  readonly status: "error";
  readonly id: string;
  readonly name: string;
  readonly type: FieldType;
  readonly value: null;
  readonly code: FieldErrorCode;
  readonly message: string;
  readonly span?: ByteSpan;
}

export type ExtractedField =
  | ExtractedFieldOk
  | ExtractedFieldRedacted
  | ExtractedFieldDropped
  | ExtractedFieldMissing
  | ExtractedFieldError;

export interface ParseSuccess {
  readonly matched: true;
  readonly template: string;
  readonly event: string;
  readonly version: number;
  readonly spans: Readonly<Record<string, ByteSpan>>;
  readonly fields: Readonly<Record<string, ExtractedField>>;
  readonly errors: readonly ExtractedFieldError[];
}

export interface ParseNoMatch {
  readonly matched: false;
  readonly template: string;
  readonly event: string;
  readonly version: number;
}

export type ParseResult = ParseSuccess | ParseNoMatch;

/**
 * Section 17 cross-runtime canonical encoding for a single field result (detailed form).
 */
export type CanonicalFieldResult =
  | {
      readonly status: "ok";
      readonly type: "string" | "enum";
      readonly value: string;
      readonly utf8_hex: string;
      readonly pseudonymized?: true;
    }
  | {
      readonly status: "ok";
      readonly type: "int";
      readonly value: string;
    }
  | {
      readonly status: "ok";
      readonly type: "float";
      readonly value_hex: string;
    }
  | {
      readonly status: "ok";
      readonly type: "bool";
      readonly value: boolean;
    }
  | {
      readonly status: "ok";
      readonly type: "timestamp";
      readonly value: string;
    }
  | {
      readonly status: "ok";
      readonly type: "json";
      readonly value: string;
    }
  | {
      readonly status: "redacted";
      readonly type: FieldType;
      readonly token: string;
    }
  | {
      readonly status: "dropped";
      readonly type: FieldType;
    }
  | {
      readonly status: "missing";
      readonly type: FieldType;
    }
  | {
      readonly status: "error";
      readonly type: FieldType;
      readonly code: FieldErrorCode;
    };

export interface CanonicalMatchResult {
  readonly id: string;
  readonly matched: true;
  readonly spans: Readonly<Record<string, ByteSpan>>;
  readonly fields: Readonly<Record<string, CanonicalFieldResult>>;
}

export interface CanonicalNoMatchResult {
  readonly id: string;
  readonly matched: false;
}

export type CanonicalResult = CanonicalMatchResult | CanonicalNoMatchResult;

/**
 * Exact section 17 golden vector schema types (`spec/vectors/vector.schema.json`).
 */
export type VectorParseErrorCode =
  | "int_overflow"
  | "float_overflow"
  | "cast_failed"
  | "invalid_time"
  | "unmapped_enum"
  | "invalid_ip"
  | "type_mismatch"
  | "invalid_json";

export type VectorFieldResult =
  | { readonly status: "ok"; readonly type: "string"; readonly value: string }
  | { readonly status: "ok"; readonly type: "enum"; readonly value: string }
  | { readonly status: "ok"; readonly type: "int"; readonly value: string }
  | { readonly status: "ok"; readonly type: "float"; readonly value: string }
  | { readonly status: "ok"; readonly type: "bool"; readonly value: boolean }
  | { readonly status: "ok"; readonly type: "timestamp"; readonly value: number | bigint }
  | { readonly status: "ok"; readonly type: "json"; readonly value: JsonValue }
  | { readonly status: "redacted"; readonly token: string }
  | { readonly status: "dropped" }
  | { readonly status: "missing" }
  | { readonly status: "parse_error"; readonly code: VectorParseErrorCode | string };

export type VectorExpectedResult =
  | { readonly matched: false }
  | {
      readonly matched: true;
      readonly fields: Readonly<Record<string, VectorFieldResult>>;
    };

export interface VectorExecutionContext {
  readonly hmac_keys?: {
    readonly edge: string;
    readonly server: string;
  };
  readonly reference_ts_ms?: number;
}

export type VectorSqlExpectation =
  | { readonly supported: true }
  | {
      readonly supported: false;
      readonly refusal_code: string;
      readonly reason: string;
    };
