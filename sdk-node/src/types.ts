export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/**
 * OpenTelemetry severity numbers (0..24).
 * 0 = UNSPECIFIED, 1..4 = TRACE, 5..8 = DEBUG, 9..12 = INFO,
 * 13..16 = WARN, 17..20 = ERROR, 21..24 = FATAL.
 */
export type SeverityNumber =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20
  | 21
  | 22
  | 23
  | 24;

export const Severity = {
  UNSPECIFIED: 0,
  TRACE: 1,
  TRACE2: 2,
  TRACE3: 3,
  TRACE4: 4,
  DEBUG: 5,
  DEBUG2: 6,
  DEBUG3: 7,
  DEBUG4: 8,
  INFO: 9,
  INFO2: 10,
  INFO3: 11,
  INFO4: 12,
  WARN: 13,
  WARN2: 14,
  WARN3: 15,
  WARN4: 16,
  ERROR: 17,
  ERROR2: 18,
  ERROR3: 19,
  ERROR4: 20,
  FATAL: 21,
  FATAL2: 22,
  FATAL3: 23,
  FATAL4: 24,
} as const satisfies Record<string, SeverityNumber>;

export interface RecordTemplate {
  strings: readonly string[];
  args: readonly JsonValue[];
}

export interface CallSite {
  file: string;
  line: number;
  column?: number;
  function?: string;
}

export interface EdgeParsed {
  template: string;
  parser_version: number;
  fields: Record<string, JsonValue>;
}

export type RecordAttrs = Record<string, string>;

/**
 * Exact wire representation of a record inside POST /v1/batch -> records[].
 * `project_id` and `observed_ts` are injected server-side and never sent.
 */
export interface WireRecord {
  /** Non-negative base-10 integer nanoseconds since Unix epoch. */
  ts: string;
  /** OpenTelemetry severity number in 0..24. */
  severity: SeverityNumber;
  /** Unstructured message or structured JSON value. */
  body: JsonValue;
  tpl?: RecordTemplate;
  callsite?: CallSite;
  attrs?: RecordAttrs;
  trace_id?: string;
  span_id?: string;
  edge?: EdgeParsed;
}

/**
 * Epoch timestamp input accepted by the SDK.
 * JavaScript `number` is intentionally excluded to prevent IEEE-754 floating-point
 * precision loss for nanosecond epoch timestamps.
 */
export type TimestampInput = bigint | string | Date;

export interface LogRecordInput {
  ts?: TimestampInput;
  severity: SeverityNumber;
  body: JsonValue;
  tpl?: RecordTemplate;
  callsite?: CallSite;
  attrs?: RecordAttrs;
  trace_id?: string;
  span_id?: string;
  edge?: EdgeParsed;
}

export interface BatchIdentity {
  service: string;
  env: string;
  release: string;
}

export interface BatchEnvelope extends BatchIdentity {
  batch_id: string;
  records: WireRecord[];
  dropped?: number;
}

export type CompressionMode = "gzip" | "none";

export interface PreparedBatch {
  readonly batchId: string;
  readonly identity: Readonly<BatchIdentity>;
  readonly recordCount: number;
  readonly dropped: number;
  readonly rawByteLength: number;
  readonly body: Uint8Array;
  readonly contentEncoding: "gzip" | undefined;
}

export type TransportErrorCode =
  | "missing_key"
  | "invalid_record"
  | "record_too_large"
  | "queue_full"
  | "http_error"
  | "network_error"
  | "timeout"
  | "compression_error"
  | "retries_exhausted"
  | "shutdown_timeout"
  | "capture_error"
  | "callsite_error";

export interface TransportError {
  readonly code: TransportErrorCode;
  readonly message: string;
  readonly status?: number;
  readonly batchId?: string;
  readonly attempt?: number;
  readonly cause?: unknown;
}

export interface TransportStats {
  readonly queuedRecords: number;
  readonly queuedBytes: number;
  readonly pendingDropped: number;
  readonly totalEnqueued: number;
  readonly totalDropped: number;
  readonly totalSentRecords: number;
  readonly totalSentBatches: number;
  readonly totalFailedBatches: number;
  readonly totalRetries: number;
  readonly closed: boolean;
}

export interface FetchResponseLike {
  readonly status: number;
  readonly headers: {
    get(name: string): string | null;
  };
  readonly body?: {
    cancel(): Promise<unknown>;
  } | null;
}

export interface FetchRequestInitLike {
  method: "POST";
  headers: Record<string, string>;
  body: Uint8Array;
  signal: AbortSignal;
}

export type FetchLike = (
  url: string,
  init: FetchRequestInitLike,
) => Promise<FetchResponseLike>;

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface RawStackFrame {
  readonly fileName: string;
  /** 1-based line number in the executed file. */
  readonly lineNumber: number;
  /** 1-based column number in the executed file. */
  readonly columnNumber: number;
  /** Enclosing function or method name, if available. */
  readonly functionName?: string;
}

export interface SourceMapLookupResult {
  readonly file: string;
  /** 1-based line number in the mapped source file. */
  readonly line: number;
  /** 1-based column number in the mapped source file, if available. */
  readonly column?: number;
}

export interface CallSiteResolverOptions {
  /** Enable call-site capture. Defaults to `true`. */
  enabled?: boolean;
  /**
   * Number of initial stack samples per distinct shape key (for structured events)
   * before settling the cache. Tagged templates cache once per `TemplateStringsArray` call site.
   * Defaults to `3`. Setting `0` disables capture.
   */
  sampleLimit?: number;
  /** Maximum shape-key cache entries retained in memory. Defaults to `2048`. */
  maxShapeCacheEntries?: number;
  /** Maximum parsed source-map files retained in memory. Defaults to `256`. */
  maxSourceMapCacheEntries?: number;
  /** Non-throwing diagnostic callback for call-site or source-map failures. */
  onError?: (error: TransportError) => void;
  /** Optional stack frame capture override (for deterministic unit tests). */
  captureFrame?: (
    skipAbove: (...args: never[]) => unknown,
  ) => RawStackFrame | undefined;
  /** Optional source-map resolution override (for deterministic unit tests). */
  resolveSourceMap?: (frame: RawStackFrame) => SourceMapLookupResult | undefined;
}

export interface CallSiteCacheStats {
  readonly stackCaptures: number;
  readonly templateHits: number;
  readonly templateMisses: number;
  readonly shapeHits: number;
  readonly shapeMisses: number;
  readonly shapeCacheSize: number;
  readonly sourceMapCacheSize: number;
}

export type StructuredFields = Readonly<Record<string, unknown>>;

export interface StructuredBody {
  readonly event: string;
  readonly fields: JsonObject;
}

export interface LogCallOptions {
  ts?: TimestampInput;
  attrs?: RecordAttrs;
  trace_id?: string;
  span_id?: string;
  callsite?: CallSite;
}

export interface LoggerContext {
  readonly attrs?: RecordAttrs;
  readonly trace_id?: string;
  readonly span_id?: string;
  readonly fields?: StructuredFields;
}

export interface LoggerOptions {
  /** Call-site capture and source-map caching options. */
  callsite?: CallSiteResolverOptions;
  /** Non-throwing error callback for capture/serialization/callsite diagnostics. */
  onError?: (error: TransportError) => void;
  /** Default context bound to all records emitted by this logger. */
  context?: LoggerContext;
}

export interface LogMethod {
  /**
   * Tagged-template capture: records literal parts and typed interpolated values
   * separately in `tpl`, renders a searchable `body` string, and caches the
   * source-mapped call site once per call site.
   */
  (strings: TemplateStringsArray, ...values: readonly unknown[]): boolean;

  /**
   * Structured event capture: records the event name and typed fields in `body`,
   * emits `tpl` with the event name literal, and caches the source-mapped call site
   * by shape key.
   */
  (
    event: string,
    fields?: StructuredFields,
    options?: LogCallOptions,
  ): boolean;
}

export interface Logger {
  readonly trace: LogMethod;
  readonly debug: LogMethod;
  readonly info: LogMethod;
  readonly warn: LogMethod;
  readonly error: LogMethod;
  readonly fatal: LogMethod;
  /**
   * Creates a derived logger sharing the same sink and call-site cache with
   * additional bound `attrs`, `trace_id`, `span_id`, and/or default structured `fields`.
   */
  child(context: LoggerContext): Logger;
}

export interface TransportOptions {
  /** Ingest key sent via `Authorization: Bearer <key>`. Defaults to `process.env.BIND_KEY`. */
  key?: string;
  /** Base ingest URL or full `/v1/batch` URL. Defaults to `process.env.BIND_ENDPOINT` or `https://ingest.bind.dev`. */
  endpoint?: string;
  /** Service identity sent in every batch envelope. */
  service?: string;
  /** Environment identity sent in every batch envelope. */
  env?: string;
  /** Release identity sent in every batch envelope. */
  release?: string;
  /** Payload compression mode. Defaults to `"gzip"`. */
  compression?: CompressionMode;
  /** zlib gzip compression level (0..9). Defaults to `6`. */
  compressionLevel?: number;
  /** Maximum records per batch. Defaults to `500`. */
  maxBatchRecords?: number;
  /** Maximum encoded/compressed payload bytes per batch. Defaults to `262144` (256 KiB). */
  maxBatchCompressedBytes?: number;
  /** Maximum time before flushing a non-empty queue in milliseconds. Defaults to `5000`. */
  flushIntervalMs?: number;
  /** Maximum queued record bytes in memory. Defaults to `4194304` (4 MiB). */
  maxQueueBytes?: number;
  /** Maximum serialized bytes for a single record. Defaults to `65536` (64 KiB). */
  maxRecordBytes?: number;
  /** Per-attempt HTTP request timeout in milliseconds. Defaults to `10000`. */
  requestTimeoutMs?: number;
  /** Maximum retry attempts after an initial failed attempt. Defaults to `5`. */
  maxRetries?: number;
  /** Initial exponential backoff delay in milliseconds. Defaults to `250`. */
  initialBackoffMs?: number;
  /** Maximum exponential backoff delay in milliseconds. Defaults to `30000`. */
  maxBackoffMs?: number;
  /** Upper bound applied to server `Retry-After` delays in milliseconds. Defaults to `120000`. */
  maxRetryAfterMs?: number;
  /** Default timeout in milliseconds for `shutdown()`. Defaults to `10000`. */
  shutdownTimeoutMs?: number;
  /** Non-throwing error callback for diagnostics. */
  onError?: (error: TransportError) => void;
  /** Optional `fetch` override for testing or custom runtimes. */
  fetch?: FetchLike;
  /** Optional BigInt nanosecond epoch clock override. */
  nowNs?: () => bigint;
  /** Optional millisecond wall clock override (used for Retry-After HTTP-date parsing). */
  nowMs?: () => number;
  /** Optional RNG override returning `[0, 1)` for deterministic backoff jitter tests. */
  random?: () => number;
  /** Optional abortable sleep override for deterministic retry tests. */
  sleep?: SleepFn;
  /** Optional batch UUID generator override. */
  generateBatchId?: () => string;
  /** Optional environment map override for deterministic identity default resolution. */
  envSource?: Record<string, string | undefined>;
}

export interface BindInitOptions extends TransportOptions {
  /** Call-site capture and source-map caching options for `log.*` APIs. */
  callsite?: CallSiteResolverOptions;
}

/**
 * Minimal sink contract shared by the core transport and higher-level SDK layers
 * (T1.6.2 tagged-template/structured `log`, T1.6.3 console/pino/winston bridges).
 */
export interface RecordSink {
  readonly identity: Readonly<BatchIdentity>;
  enqueue(record: LogRecordInput): boolean;
  flush(): Promise<void>;
  shutdown(timeoutMs?: number): Promise<void>;
  getStats(): TransportStats;
}
