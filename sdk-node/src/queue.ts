import { formatTimestampNs } from "./clock.js";
import type {
  CallSite,
  EdgeParsed,
  JsonValue,
  LogRecordInput,
  RecordAttrs,
  RecordTemplate,
  SeverityNumber,
  WireRecord,
} from "./types.js";

export interface QueuedRecord {
  readonly seq: number;
  readonly severity: SeverityNumber;
  /** Pre-serialized UTF-8 JSON object string for this WireRecord. */
  readonly json: string;
  /** Exact UTF-8 byte length of `json`. */
  readonly byteLength: number;
}

export interface EnqueueOutcome {
  readonly accepted: boolean;
  readonly evictedCount: number;
  readonly rejectedReason?: "record_too_large" | "queue_full";
}

const textEncoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  if (typeof Buffer !== "undefined" && typeof Buffer.byteLength === "function") {
    return Buffer.byteLength(text, "utf8");
  }
  return textEncoder.encode(text).byteLength;
}

/**
 * Debug-level and below (OTel TRACE 1..4 and DEBUG 5..8) are evicted first
 * when the bounded queue reaches its byte limit.
 */
export function isDebugLevel(severity: SeverityNumber): boolean {
  return severity >= 1 && severity <= 8;
}

function isValidSeverity(value: unknown): value is SeverityNumber {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 24
  );
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, current: unknown) => {
      if (typeof current === "bigint") {
        return current.toString(10);
      }
      if (typeof current === "object" && current !== null) {
        if (seen.has(current)) {
          return "[Circular]";
        }
        seen.add(current);
      }
      return current;
    });
  }
}

function sanitizeTemplate(tpl: RecordTemplate): RecordTemplate {
  if (
    typeof tpl !== "object" ||
    tpl === null ||
    !Array.isArray(tpl.strings) ||
    !Array.isArray(tpl.args)
  ) {
    throw new TypeError("Record tpl must have strings and args arrays");
  }
  const strings: string[] = [];
  for (const part of tpl.strings) {
    if (typeof part !== "string") {
      throw new TypeError("Record tpl.strings entries must be strings");
    }
    strings.push(part);
  }
  const args: JsonValue[] = [];
  for (const arg of tpl.args) {
    args.push((arg === undefined ? null : arg) as JsonValue);
  }
  return { strings, args };
}

function sanitizeCallSite(callsite: CallSite): CallSite {
  if (typeof callsite !== "object" || callsite === null) {
    throw new TypeError("Record callsite must be an object");
  }
  if (typeof callsite.file !== "string") {
    throw new TypeError("Record callsite.file must be a string");
  }
  if (
    typeof callsite.line !== "number" ||
    !Number.isInteger(callsite.line) ||
    callsite.line < 0
  ) {
    throw new TypeError("Record callsite.line must be a non-negative integer");
  }
  const out: CallSite = {
    file: callsite.file,
    line: callsite.line,
  };
  if (callsite.column !== undefined) {
    if (
      typeof callsite.column !== "number" ||
      !Number.isInteger(callsite.column) ||
      callsite.column < 0
    ) {
      throw new TypeError("Record callsite.column must be a non-negative integer");
    }
    out.column = callsite.column;
  }
  if (callsite.function !== undefined) {
    if (typeof callsite.function !== "string") {
      throw new TypeError("Record callsite.function must be a string");
    }
    out.function = callsite.function;
  }
  return out;
}

function sanitizeAttrs(attrs: RecordAttrs): RecordAttrs {
  if (typeof attrs !== "object" || attrs === null || Array.isArray(attrs)) {
    throw new TypeError("Record attrs must be a string map");
  }
  const out: RecordAttrs = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) {
      continue;
    }
    if (typeof v !== "string") {
      throw new TypeError(`Record attrs[${JSON.stringify(k)}] must be a string`);
    }
    out[k] = v;
  }
  return out;
}

function sanitizeEdge(edge: EdgeParsed): EdgeParsed {
  if (typeof edge !== "object" || edge === null || Array.isArray(edge)) {
    throw new TypeError("Record edge must be an object");
  }
  if (typeof edge.template !== "string") {
    throw new TypeError("Record edge.template must be a string");
  }
  if (
    typeof edge.parser_version !== "number" ||
    !Number.isInteger(edge.parser_version) ||
    edge.parser_version < 0
  ) {
    throw new TypeError("Record edge.parser_version must be a non-negative integer");
  }
  if (
    typeof edge.fields !== "object" ||
    edge.fields === null ||
    Array.isArray(edge.fields)
  ) {
    throw new TypeError("Record edge.fields must be an object");
  }
  const fields: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(edge.fields)) {
    if (v !== undefined) {
      fields[k] = v;
    }
  }
  return {
    template: edge.template,
    parser_version: edge.parser_version,
    fields,
  };
}

/**
 * Validates a `LogRecordInput`, captures or normalizes its BigInt nanosecond
 * timestamp, and serializes it once into its exact wire JSON representation.
 * Snapshotting at enqueue time isolates queued records from later caller mutation.
 */
export function serializeRecordInput(
  input: LogRecordInput,
  clock: () => bigint,
): { severity: SeverityNumber; json: string; byteLength: number } {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("Log record must be an object");
  }
  if (!isValidSeverity(input.severity)) {
    throw new RangeError(
      `Record severity must be an integer in 0..24, got ${String(input.severity)}`,
    );
  }

  const ts = formatTimestampNs(input.ts, clock);
  const body: JsonValue = input.body === undefined ? null : input.body;

  const wire: WireRecord = {
    ts,
    severity: input.severity,
    body,
  };

  if (input.tpl !== undefined) {
    wire.tpl = sanitizeTemplate(input.tpl);
  }
  if (input.callsite !== undefined) {
    wire.callsite = sanitizeCallSite(input.callsite);
  }
  if (input.attrs !== undefined) {
    wire.attrs = sanitizeAttrs(input.attrs);
  }
  if (input.trace_id !== undefined) {
    if (typeof input.trace_id !== "string") {
      throw new TypeError("Record trace_id must be a string");
    }
    wire.trace_id = input.trace_id;
  }
  if (input.span_id !== undefined) {
    if (typeof input.span_id !== "string") {
      throw new TypeError("Record span_id must be a string");
    }
    wire.span_id = input.span_id;
  }
  if (input.edge !== undefined) {
    wire.edge = sanitizeEdge(input.edge);
  }

  const json = safeJsonStringify(wire);
  const byteLength = utf8ByteLength(json);
  return { severity: input.severity, json, byteLength };
}

export interface BoundedQueueOptions {
  maxQueueBytes: number;
  maxRecordBytes: number;
}

/**
 * Byte-bounded in-memory record queue that evicts oldest debug-level records
 * (severity 1..8) before higher-severity records and tracks drop counts.
 */
export class BoundedRecordQueue {
  private readonly items: QueuedRecord[] = [];
  private readonly maxQueueBytes: number;
  private readonly maxRecordBytes: number;

  private _queuedBytes = 0;
  private _debugBytes = 0;
  private _pendingDropped = 0;
  private _totalDropped = 0;
  private _totalEnqueued = 0;
  private _nextSeq = 0;

  constructor(options: BoundedQueueOptions) {
    this.maxQueueBytes = Math.max(1, Math.floor(options.maxQueueBytes));
    this.maxRecordBytes = Math.max(1, Math.floor(options.maxRecordBytes));
  }

  get length(): number {
    return this.items.length;
  }

  get queuedBytes(): number {
    return this._queuedBytes;
  }

  get pendingDropped(): number {
    return this._pendingDropped;
  }

  get totalDropped(): number {
    return this._totalDropped;
  }

  get totalEnqueued(): number {
    return this._totalEnqueued;
  }

  get lastSeq(): number {
    return this._nextSeq;
  }

  /**
   * Enqueues a pre-serialized record while enforcing `maxRecordBytes` and
   * `maxQueueBytes`. Never mutates existing records if the incoming record
   * cannot fit.
   */
  enqueue(record: {
    severity: SeverityNumber;
    json: string;
    byteLength: number;
  }): EnqueueOutcome {
    if (record.byteLength > this.maxRecordBytes) {
      this._pendingDropped += 1;
      this._totalDropped += 1;
      return {
        accepted: false,
        evictedCount: 0,
        rejectedReason: "record_too_large",
      };
    }

    if (record.byteLength > this.maxQueueBytes) {
      this._pendingDropped += 1;
      this._totalDropped += 1;
      return {
        accepted: false,
        evictedCount: 0,
        rejectedReason: "queue_full",
      };
    }

    const incomingIsDebug = isDebugLevel(record.severity);
    let evictedCount = 0;

    if (this._queuedBytes + record.byteLength > this.maxQueueBytes) {
      if (incomingIsDebug) {
        // Never evict higher-severity records to make room for a debug record.
        if (
          this._queuedBytes - this._debugBytes + record.byteLength >
          this.maxQueueBytes
        ) {
          this._pendingDropped += 1;
          this._totalDropped += 1;
          return {
            accepted: false,
            evictedCount: 0,
            rejectedReason: "queue_full",
          };
        }
        evictedCount += this.evictDebugRecords(record.byteLength);
      } else {
        if (this._debugBytes > 0) {
          evictedCount += this.evictDebugRecords(record.byteLength);
        }
        if (this._queuedBytes + record.byteLength > this.maxQueueBytes) {
          evictedCount += this.evictOldestRecords(record.byteLength);
        }
      }
    }

    const seq = ++this._nextSeq;
    this.items.push({
      seq,
      severity: record.severity,
      json: record.json,
      byteLength: record.byteLength,
    });
    this._queuedBytes += record.byteLength;
    if (incomingIsDebug) {
      this._debugBytes += record.byteLength;
    }
    this._totalEnqueued += 1;

    return { accepted: true, evictedCount };
  }

  /**
   * Returns records (e.g. unsent remainder after a size-aware batch split) to
   * the front of the queue while preserving `queuedBytes <= maxQueueBytes`.
   */
  prepend(records: readonly QueuedRecord[]): number {
    if (records.length === 0) {
      return 0;
    }
    this.items.unshift(...records);
    for (const item of records) {
      this._queuedBytes += item.byteLength;
      if (isDebugLevel(item.severity)) {
        this._debugBytes += item.byteLength;
      }
    }
    let evicted = 0;
    if (this._queuedBytes > this.maxQueueBytes) {
      if (this._debugBytes > 0) {
        evicted += this.evictDebugRecords(0);
      }
      if (this._queuedBytes > this.maxQueueBytes) {
        evicted += this.evictOldestRecords(0);
      }
    }
    return evicted;
  }

  peekPrefix(maxCount: number): QueuedRecord[] {
    const count = Math.min(this.items.length, Math.max(0, Math.floor(maxCount)));
    return this.items.slice(0, count);
  }

  shiftCount(count: number): QueuedRecord[] {
    const actual = Math.min(this.items.length, Math.max(0, Math.floor(count)));
    if (actual === 0) {
      return [];
    }
    const removed = this.items.splice(0, actual);
    for (const item of removed) {
      this._queuedBytes -= item.byteLength;
      if (isDebugLevel(item.severity)) {
        this._debugBytes -= item.byteLength;
      }
    }
    return removed;
  }

  takePendingDropped(): number {
    const dropped = this._pendingDropped;
    this._pendingDropped = 0;
    return dropped;
  }

  /**
   * Restores drop accounting when a sealed batch fails permanently so the next
   * successful batch reports both its prior drop count and its lost records.
   */
  restoreFailedBatch(previouslyDropped: number, lostRecords: number): void {
    this._pendingDropped += previouslyDropped + lostRecords;
    this._totalDropped += lostRecords;
  }

  private evictDebugRecords(incomingBytes: number): number {
    let evicted = 0;
    let writeIdx = 0;
    for (let readIdx = 0; readIdx < this.items.length; readIdx += 1) {
      const item = this.items[readIdx]!;
      if (
        this._queuedBytes + incomingBytes > this.maxQueueBytes &&
        isDebugLevel(item.severity)
      ) {
        this._queuedBytes -= item.byteLength;
        this._debugBytes -= item.byteLength;
        this._pendingDropped += 1;
        this._totalDropped += 1;
        evicted += 1;
      } else {
        if (writeIdx !== readIdx) {
          this.items[writeIdx] = item;
        }
        writeIdx += 1;
      }
    }
    if (writeIdx !== this.items.length) {
      this.items.length = writeIdx;
    }
    return evicted;
  }

  private evictOldestRecords(incomingBytes: number): number {
    let removeCount = 0;
    while (
      removeCount < this.items.length &&
      this._queuedBytes + incomingBytes > this.maxQueueBytes
    ) {
      const item = this.items[removeCount]!;
      this._queuedBytes -= item.byteLength;
      if (isDebugLevel(item.severity)) {
        this._debugBytes -= item.byteLength;
      }
      this._pendingDropped += 1;
      this._totalDropped += 1;
      removeCount += 1;
    }
    if (removeCount > 0) {
      this.items.splice(0, removeCount);
    }
    return removeCount;
  }
}
