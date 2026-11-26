import { randomUUID } from "node:crypto";
import { gzip as gzipCallback } from "node:zlib";
import { promisify } from "node:util";
import { createNanosecondClock } from "./clock.js";
import {
  buildIdentityPayloadFragment,
  getDefaultEnvSource,
  resolveBatchUrl,
  resolveIdentity,
} from "./identity.js";
import {
  BoundedRecordQueue,
  serializeRecordInput,
  utf8ByteLength,
  type QueuedRecord,
} from "./queue.js";
import {
  computeBackoffMs,
  defaultSleep,
  isRetryableStatus,
  parseRetryAfterMs,
} from "./retry.js";
import type {
  BatchIdentity,
  CompressionMode,
  FetchLike,
  FetchResponseLike,
  LogRecordInput,
  PreparedBatch,
  RecordSink,
  SleepFn,
  TransportError,
  TransportOptions,
  TransportStats,
} from "./types.js";

const gzipAsync = promisify(gzipCallback);

export const DEFAULT_MAX_BATCH_RECORDS = 500;
export const DEFAULT_MAX_BATCH_COMPRESSED_BYTES = 256 * 1024;
export const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
export const DEFAULT_MAX_QUEUE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_RECORD_BYTES = 64 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RETRIES = 5;
export const DEFAULT_INITIAL_BACKOFF_MS = 250;
export const DEFAULT_MAX_BACKOFF_MS = 30_000;
export const DEFAULT_MAX_RETRY_AFTER_MS = 120_000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
export const DEFAULT_COMPRESSION_LEVEL = 6;

const GZIP_HEADER_SLACK_BYTES = 32;
const UUID_PLACEHOLDER_LENGTH = 36;

interface EncodedEnvelope {
  readonly rawByteLength: number;
  readonly body: Uint8Array;
}

type SendOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly pauseDrain: boolean };

function positiveInt(value: number | undefined, fallback: number, min = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.floor(value));
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function defaultFetchImpl(
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: Uint8Array;
    signal: AbortSignal;
  },
): Promise<FetchResponseLike> {
  return globalThis.fetch(url, init as unknown as RequestInit);
}

/**
 * Core non-blocking batching HTTP transport for `POST /v1/batch`.
 *
 * Guarantees:
 * - Bounded in-memory queue with oldest-debug-first eviction and drop counting
 * - Flush triggers at max record count (500), max compressed payload size (256 KiB), or interval (5s)
 * - Size-aware batch splitting so no multi-record request exceeds `maxBatchCompressedBytes`
 * - Exact byte-for-byte payload and `batch_id` stability across retries
 * - Strict retryable statuses (429, 502, 503, 504), `Retry-After`, exponential backoff + jitter, timeouts
 * - Never throws into customer code
 */
export class BatchTransport implements RecordSink {
  readonly identity: Readonly<BatchIdentity>;

  private readonly key: string;
  private readonly batchUrl: string;
  private readonly identityPayloadFragment: string;
  private readonly identityOverheadBaseBytes: number;
  private readonly compression: CompressionMode;
  private readonly compressionLevel: number;
  private readonly maxBatchRecords: number;
  private readonly maxBatchCompressedBytes: number;
  private readonly flushIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly onError?: (error: TransportError) => void;
  private readonly fetchFn: FetchLike;
  private readonly nowNs: () => bigint;
  private readonly nowMs: () => number;
  private readonly random: () => number;
  private readonly sleepFn: SleepFn;
  private readonly generateBatchId: () => string;

  private readonly queue: BoundedRecordQueue;
  private readonly shutdownAbortController = new AbortController();
  private readonly disabled: boolean;

  private closed = false;
  private shutdownPromise?: Promise<void>;
  private activeDrain?: Promise<void>;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private sizeCheckPending = false;
  private sizeCheckRecheckNeeded = false;
  private lastSizeCheckRawBytes = 0;
  private lastSizeCheckCompressedBytes = 0;

  private totalSentRecords = 0;
  private totalSentBatches = 0;
  private totalFailedBatches = 0;
  private totalRetries = 0;

  constructor(options: TransportOptions = {}) {
    const envSource = options.envSource ?? getDefaultEnvSource();
    this.onError = options.onError;
    this.identity = resolveIdentity({
      service: options.service,
      env: options.env,
      release: options.release,
      envSource,
    });
    this.identityPayloadFragment = buildIdentityPayloadFragment(this.identity);
    this.identityOverheadBaseBytes =
      utf8ByteLength(`{"batch_id":"","records":[]}`) +
      UUID_PLACEHOLDER_LENGTH +
      utf8ByteLength(this.identityPayloadFragment);

    this.compression = options.compression === "none" ? "none" : "gzip";
    this.compressionLevel = Math.min(
      9,
      Math.max(0, nonNegativeInt(options.compressionLevel, DEFAULT_COMPRESSION_LEVEL)),
    );
    this.maxBatchRecords = positiveInt(
      options.maxBatchRecords,
      DEFAULT_MAX_BATCH_RECORDS,
    );
    this.maxBatchCompressedBytes = positiveInt(
      options.maxBatchCompressedBytes,
      DEFAULT_MAX_BATCH_COMPRESSED_BYTES,
    );
    this.flushIntervalMs = nonNegativeInt(
      options.flushIntervalMs,
      DEFAULT_FLUSH_INTERVAL_MS,
    );
    this.requestTimeoutMs = positiveInt(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.maxRetries = nonNegativeInt(options.maxRetries, DEFAULT_MAX_RETRIES);
    this.initialBackoffMs = nonNegativeInt(
      options.initialBackoffMs,
      DEFAULT_INITIAL_BACKOFF_MS,
    );
    this.maxBackoffMs = Math.max(
      this.initialBackoffMs,
      nonNegativeInt(options.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS),
    );
    this.maxRetryAfterMs = nonNegativeInt(
      options.maxRetryAfterMs,
      DEFAULT_MAX_RETRY_AFTER_MS,
    );
    this.shutdownTimeoutMs = nonNegativeInt(
      options.shutdownTimeoutMs,
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
    );

    const maxQueueBytes = positiveInt(
      options.maxQueueBytes,
      DEFAULT_MAX_QUEUE_BYTES,
    );
    const maxRecordBytes = positiveInt(
      options.maxRecordBytes,
      DEFAULT_MAX_RECORD_BYTES,
    );
    this.queue = new BoundedRecordQueue({ maxQueueBytes, maxRecordBytes });

    this.fetchFn = options.fetch ?? defaultFetchImpl;
    this.nowNs = options.nowNs ?? createNanosecondClock();
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.sleepFn = options.sleep ?? defaultSleep;
    this.generateBatchId = options.generateBatchId ?? randomUUID;

    const resolvedKey = (options.key ?? envSource.BIND_KEY ?? "").trim();
    this.key = resolvedKey;

    let resolvedUrl = "";
    let configDisabled = false;
    if (!resolvedKey) {
      configDisabled = true;
      this.reportError({
        code: "missing_key",
        message: "Bind ingest key is required; transport is disabled",
      });
    } else {
      try {
        resolvedUrl = resolveBatchUrl(options.endpoint ?? envSource.BIND_ENDPOINT);
      } catch (err) {
        configDisabled = true;
        this.reportError({
          code: "http_error",
          message: "Invalid Bind ingest endpoint URL; transport is disabled",
          cause: err,
        });
      }
    }
    this.batchUrl = resolvedUrl;
    this.disabled = configDisabled;
  }

  /**
   * Enqueues a log record synchronously without blocking or throwing.
   * Returns `true` if accepted into the bounded queue, `false` otherwise.
   */
  enqueue(record: LogRecordInput): boolean {
    if (this.closed || this.disabled) {
      return false;
    }

    let serialized: { severity: LogRecordInput["severity"]; json: string; byteLength: number };
    try {
      serialized = serializeRecordInput(record, this.nowNs);
    } catch (err) {
      this.reportError({
        code: "invalid_record",
        message:
          err instanceof Error ? err.message : "Failed to serialize log record",
        cause: err,
      });
      return false;
    }

    const outcome = this.queue.enqueue(serialized);
    if (!outcome.accepted) {
      if (outcome.rejectedReason === "record_too_large") {
        this.reportError({
          code: "record_too_large",
          message: `Record size (${serialized.byteLength} bytes) exceeds maxRecordBytes`,
        });
      } else if (outcome.rejectedReason === "queue_full") {
        this.reportError({
          code: "queue_full",
          message: "Bounded queue is full; record dropped",
        });
      }
      return false;
    }

    if (outcome.evictedCount > 0) {
      this.resetSizeCheckCache();
    }

    this.scheduleFlushIfNeeded();
    return true;
  }

  /**
   * Flushes all currently queued records and waits for completion.
   * Never throws into customer code.
   */
  async flush(): Promise<void> {
    if (this.disabled) {
      return;
    }
    this.clearFlushTimer();

    try {
      while (true) {
        if (this.activeDrain) {
          await this.activeDrain;
        }
        if (
          this.queue.length === 0 ||
          this.shutdownAbortController.signal.aborted
        ) {
          break;
        }
        const paused = await this.runDrain(true);
        if (paused) {
          break;
        }
      }
    } catch (err) {
      this.reportError({
        code: "network_error",
        message: "Unexpected error during flush",
        cause: err,
      });
    }
  }

  /**
   * Stops accepting new records and flushes remaining records up to `timeoutMs`.
   * Idempotent and never throws into customer code.
   */
  shutdown(timeoutMs?: number): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.closed = true;
    this.clearFlushTimer();

    const effectiveTimeout =
      timeoutMs !== undefined
        ? nonNegativeInt(timeoutMs, this.shutdownTimeoutMs)
        : this.shutdownTimeoutMs;

    this.shutdownPromise = this.performShutdown(effectiveTimeout);
    return this.shutdownPromise;
  }

  getStats(): TransportStats {
    return {
      queuedRecords: this.queue.length,
      queuedBytes: this.queue.queuedBytes,
      pendingDropped: this.queue.pendingDropped,
      totalEnqueued: this.queue.totalEnqueued,
      totalDropped: this.queue.totalDropped,
      totalSentRecords: this.totalSentRecords,
      totalSentBatches: this.totalSentBatches,
      totalFailedBatches: this.totalFailedBatches,
      totalRetries: this.totalRetries,
      closed: this.closed,
    };
  }

  private async performShutdown(timeoutMs: number): Promise<void> {
    if (this.disabled) {
      return;
    }

    if (timeoutMs === 0) {
      this.shutdownAbortController.abort(new Error("Shutdown aborted immediately"));
      if (this.activeDrain) {
        await this.activeDrain.catch(() => {});
      }
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      timer = setTimeout(() => {
        this.shutdownAbortController.abort(new Error("Shutdown timed out"));
      }, timeoutMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }

      await this.flush();
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private estimateEnvelopeRawBytes(recordCount: number, recordBytes: number, dropped: number): number {
    const commas = recordCount > 1 ? recordCount - 1 : 0;
    const droppedBytes = dropped > 0 ? 11 + String(dropped).length : 0;
    return this.identityOverheadBaseBytes + recordBytes + commas + droppedBytes;
  }

  private resetSizeCheckCache(): void {
    this.lastSizeCheckRawBytes = 0;
    this.lastSizeCheckCompressedBytes = 0;
  }

  private scheduleFlushIfNeeded(): void {
    if (this.closed || this.disabled) {
      return;
    }

    const pendingCount = this.queue.length;
    if (pendingCount >= this.maxBatchRecords) {
      this.resetSizeCheckCache();
      this.triggerBackgroundDrain();
      return;
    }

    const estimatedRaw = this.estimateEnvelopeRawBytes(
      pendingCount,
      this.queue.queuedBytes,
      this.queue.pendingDropped,
    );

    if (this.compression === "none") {
      if (estimatedRaw >= this.maxBatchCompressedBytes) {
        this.triggerBackgroundDrain();
        return;
      }
    } else if (
      estimatedRaw + GZIP_HEADER_SLACK_BYTES >=
      this.maxBatchCompressedBytes
    ) {
      const rawBytes = this.queue.queuedBytes;
      const remainingHeadroom =
        this.maxBatchCompressedBytes - this.lastSizeCheckCompressedBytes;
      if (
        this.lastSizeCheckCompressedBytes === 0 ||
        rawBytes - this.lastSizeCheckRawBytes >= Math.max(1, remainingHeadroom)
      ) {
        this.scheduleAsyncCompressedSizeCheck();
      }
    }

    this.armFlushTimer();
  }

  private scheduleAsyncCompressedSizeCheck(): void {
    if (this.activeDrain || this.closed || this.disabled) {
      return;
    }
    if (this.sizeCheckPending) {
      this.sizeCheckRecheckNeeded = true;
      return;
    }
    this.sizeCheckPending = true;

    void this.checkCompressedSizeAndMaybeDrain().finally(() => {
      this.sizeCheckPending = false;
      if (this.sizeCheckRecheckNeeded) {
        this.sizeCheckRecheckNeeded = false;
        if (!this.activeDrain && !this.closed && this.queue.length > 0) {
          this.scheduleFlushIfNeeded();
        }
      }
    });
  }

  private async checkCompressedSizeAndMaybeDrain(): Promise<void> {
    if (this.activeDrain || this.closed || this.disabled || this.queue.length === 0) {
      return;
    }

    const candidates = this.queue.peekPrefix(this.maxBatchRecords);
    if (candidates.length === 0) {
      return;
    }

    const rawSnapshot = this.queue.queuedBytes;
    const droppedSnapshot = this.queue.pendingDropped;
    try {
      const encoded = await this.encodeEnvelope(
        "00000000-0000-4000-8000-000000000000",
        candidates,
        droppedSnapshot,
      );
      if (encoded.body.byteLength >= this.maxBatchCompressedBytes) {
        this.resetSizeCheckCache();
        this.triggerBackgroundDrain();
      } else {
        this.lastSizeCheckRawBytes = rawSnapshot;
        this.lastSizeCheckCompressedBytes = encoded.body.byteLength;
      }
    } catch {
      // Fall back to regular flush path on any unexpected probe error.
      this.triggerBackgroundDrain();
    }
  }

  private armFlushTimer(): void {
    if (
      this.flushTimer !== undefined ||
      this.flushIntervalMs <= 0 ||
      this.closed ||
      this.disabled ||
      this.activeDrain
    ) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (this.queue.length > 0 && !this.disabled) {
        this.triggerBackgroundDrain();
      }
    }, this.flushIntervalMs);

    if (typeof this.flushTimer.unref === "function") {
      this.flushTimer.unref();
    }
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private triggerBackgroundDrain(): void {
    if (this.activeDrain || this.disabled) {
      return;
    }
    this.clearFlushTimer();
    void this.runDrain(false);
  }

  private runDrain(explicitFlush: boolean): Promise<boolean> {
    if (this.activeDrain) {
      return this.activeDrain.then(() => false);
    }

    let pausedOnFailure = false;
    const drainPromise = (async () => {
      while (
        this.queue.length > 0 &&
        !this.shutdownAbortController.signal.aborted
      ) {
        const batch = await this.prepareNextBatch();
        if (!batch) {
          break;
        }
        const outcome = await this.sendBatch(batch);
        if (!outcome.ok) {
          this.queue.restoreFailedBatch(batch.dropped, batch.recordCount);
          if (outcome.pauseDrain) {
            pausedOnFailure = true;
            break;
          }
        }
      }
    })()
      .catch((err) => {
        pausedOnFailure = true;
        this.reportError({
          code: "network_error",
          message: "Unexpected error in transport drain loop",
          cause: err,
        });
      })
      .finally(() => {
        this.activeDrain = undefined;
        if (!this.closed && this.queue.length > 0) {
          if (pausedOnFailure || explicitFlush) {
            this.armFlushTimer();
          } else {
            this.scheduleFlushIfNeeded();
          }
        }
      });

    this.activeDrain = drainPromise;
    return drainPromise.then(() => pausedOnFailure);
  }

  /**
   * Dequeues up to `maxBatchRecords`, splits to fit within
   * `maxBatchCompressedBytes`, and seals an immutable `PreparedBatch` whose
   * `batchId`, identity payload, and encoded `body` bytes remain identical
   * across every retry attempt.
   */
  private async prepareNextBatch(): Promise<PreparedBatch | undefined> {
    const candidates = this.queue.shiftCount(this.maxBatchRecords);
    if (candidates.length === 0) {
      return undefined;
    }

    this.resetSizeCheckCache();
    const dropped = this.queue.takePendingDropped();
    const batchId = this.generateBatchId();

    try {
      let chosenCount = candidates.length;
      let chosenEncoded: EncodedEnvelope;

      if (this.compression === "none") {
        chosenCount = this.findUncompressedBatchCount(batchId, candidates, dropped);
        chosenEncoded = await this.encodeEnvelope(
          batchId,
          candidates.slice(0, chosenCount),
          dropped,
        );
      } else {
        const fullEncoded = await this.encodeEnvelope(batchId, candidates, dropped);
        if (
          fullEncoded.body.byteLength <= this.maxBatchCompressedBytes ||
          candidates.length === 1
        ) {
          chosenCount = candidates.length;
          chosenEncoded = fullEncoded;
        } else {
          const split = await this.findCompressedBatchSplit(
            batchId,
            candidates,
            dropped,
          );
          chosenCount = split.count;
          chosenEncoded = split.encoded;
        }
      }

      if (chosenCount < candidates.length) {
        this.queue.prepend(candidates.slice(chosenCount));
      }

      return Object.freeze({
        batchId,
        identity: this.identity,
        recordCount: chosenCount,
        dropped,
        rawByteLength: chosenEncoded.rawByteLength,
        body: chosenEncoded.body,
        contentEncoding: this.compression === "gzip" ? "gzip" : undefined,
      });
    } catch (err) {
      this.queue.prepend(candidates);
      this.queue.restoreFailedBatch(dropped, 0);
      this.reportError({
        code: "compression_error",
        message: "Failed to encode or compress batch",
        batchId,
        cause: err,
      });
      return undefined;
    }
  }

  private findUncompressedBatchCount(
    batchId: string,
    candidates: readonly QueuedRecord[],
    dropped: number,
  ): number {
    const droppedPart = dropped > 0 ? `,"dropped":${dropped}` : "";
    const shellBytes = utf8ByteLength(
      `{"batch_id":${JSON.stringify(batchId)}${this.identityPayloadFragment},"records":[]${droppedPart}}`,
    );

    let total = shellBytes;
    let count = 0;
    for (let i = 0; i < candidates.length; i += 1) {
      const next = total + (i > 0 ? 1 : 0) + candidates[i]!.byteLength;
      if (i > 0 && next > this.maxBatchCompressedBytes) {
        break;
      }
      total = next;
      count = i + 1;
    }
    return Math.max(1, count);
  }

  private async findCompressedBatchSplit(
    batchId: string,
    candidates: readonly QueuedRecord[],
    dropped: number,
  ): Promise<{ count: number; encoded: EncodedEnvelope }> {
    let lo = 1;
    let hi = candidates.length - 1;
    let bestCount = 1;
    let bestEncoded: EncodedEnvelope | undefined;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const encoded = await this.encodeEnvelope(
        batchId,
        candidates.slice(0, mid),
        dropped,
      );
      if (encoded.body.byteLength <= this.maxBatchCompressedBytes) {
        bestCount = mid;
        bestEncoded = encoded;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (!bestEncoded) {
      bestCount = 1;
      bestEncoded = await this.encodeEnvelope(
        batchId,
        candidates.slice(0, 1),
        dropped,
      );
    }

    return { count: bestCount, encoded: bestEncoded };
  }

  private async encodeEnvelope(
    batchId: string,
    records: readonly QueuedRecord[],
    dropped: number,
  ): Promise<EncodedEnvelope> {
    const droppedPart = dropped > 0 ? `,"dropped":${dropped}` : "";
    const recordParts = new Array<string>(records.length);
    for (let i = 0; i < records.length; i += 1) {
      recordParts[i] = records[i]!.json;
    }
    const envelopeJson = `{"batch_id":${JSON.stringify(batchId)}${this.identityPayloadFragment},"records":[${recordParts.join(",")}]${droppedPart}}`;
    const rawBuffer = Buffer.from(envelopeJson, "utf8");

    if (this.compression === "none") {
      return {
        rawByteLength: rawBuffer.byteLength,
        body: new Uint8Array(
          rawBuffer.buffer,
          rawBuffer.byteOffset,
          rawBuffer.byteLength,
        ),
      };
    }

    const compressed = await gzipAsync(rawBuffer, {
      level: this.compressionLevel,
    });
    return {
      rawByteLength: rawBuffer.byteLength,
      body: new Uint8Array(
        compressed.buffer,
        compressed.byteOffset,
        compressed.byteLength,
      ),
    };
  }

  private async sendBatch(batch: PreparedBatch): Promise<SendOutcome> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
    };
    if (batch.contentEncoding) {
      headers["Content-Encoding"] = batch.contentEncoding;
    }

    const shutdownSignal = this.shutdownAbortController.signal;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (shutdownSignal.aborted) {
        this.totalFailedBatches += 1;
        this.reportError({
          code: "shutdown_timeout",
          message: "Batch aborted because shutdown timed out",
          batchId: batch.batchId,
          attempt: attempt + 1,
        });
        return { ok: false, pauseDrain: true };
      }

      const attemptController = new AbortController();
      let timedOut = false;

      const onShutdownAbort = () => {
        attemptController.abort(shutdownSignal.reason);
      };
      shutdownSignal.addEventListener("abort", onShutdownAbort, { once: true });

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        attemptController.abort(new Error("Request timed out"));
      }, this.requestTimeoutMs);
      if (typeof timeoutTimer.unref === "function") {
        timeoutTimer.unref();
      }

      let response: FetchResponseLike | undefined;
      try {
        response = await this.fetchFn(this.batchUrl, {
          method: "POST",
          headers,
          body: batch.body,
          signal: attemptController.signal,
        });
      } catch (err) {
        clearTimeout(timeoutTimer);
        shutdownSignal.removeEventListener("abort", onShutdownAbort);

        if (shutdownSignal.aborted) {
          this.totalFailedBatches += 1;
          this.reportError({
            code: "shutdown_timeout",
            message: "Batch request aborted because shutdown timed out",
            batchId: batch.batchId,
            attempt: attempt + 1,
            cause: err,
          });
          return { ok: false, pauseDrain: true };
        }

        if (attempt >= this.maxRetries) {
          this.totalFailedBatches += 1;
          this.reportError({
            code: timedOut ? "timeout" : "retries_exhausted",
            message: timedOut
              ? `Batch ${batch.batchId} timed out after ${attempt + 1} attempts`
              : `Batch ${batch.batchId} failed after ${attempt + 1} attempts`,
            batchId: batch.batchId,
            attempt: attempt + 1,
            cause: err,
          });
          return { ok: false, pauseDrain: true };
        }

        const delayMs = computeBackoffMs(
          attempt,
          this.initialBackoffMs,
          this.maxBackoffMs,
          this.random,
        );
        this.totalRetries += 1;
        await this.sleepFn(delayMs, shutdownSignal);
        continue;
      }

      clearTimeout(timeoutTimer);
      shutdownSignal.removeEventListener("abort", onShutdownAbort);

      const status = response.status;
      const retryAfterHeader = response.headers.get("retry-after");
      try {
        await response.body?.cancel();
      } catch {
        // Ignore body cancellation errors on closed connections.
      }

      if (status >= 200 && status < 300) {
        this.totalSentBatches += 1;
        this.totalSentRecords += batch.recordCount;
        return { ok: true };
      }

      if (!isRetryableStatus(status)) {
        this.totalFailedBatches += 1;
        this.reportError({
          code: "http_error",
          message: `Non-retryable HTTP ${status} for batch ${batch.batchId}`,
          status,
          batchId: batch.batchId,
          attempt: attempt + 1,
        });
        const pauseDrain = status === 401 || status === 403;
        return { ok: false, pauseDrain };
      }

      if (attempt >= this.maxRetries) {
        this.totalFailedBatches += 1;
        this.reportError({
          code: "retries_exhausted",
          message: `Batch ${batch.batchId} exhausted retries with HTTP ${status}`,
          status,
          batchId: batch.batchId,
          attempt: attempt + 1,
        });
        return { ok: false, pauseDrain: true };
      }

      const retryAfterMs = parseRetryAfterMs(
        retryAfterHeader,
        this.nowMs(),
        this.maxRetryAfterMs,
      );
      const delayMs =
        retryAfterMs !== undefined
          ? retryAfterMs
          : computeBackoffMs(
              attempt,
              this.initialBackoffMs,
              this.maxBackoffMs,
              this.random,
            );
      this.totalRetries += 1;
      await this.sleepFn(delayMs, shutdownSignal);
    }

    this.totalFailedBatches += 1;
    return { ok: false, pauseDrain: true };
  }

  private reportError(error: TransportError): void {
    if (!this.onError) {
      return;
    }
    try {
      this.onError(error);
    } catch {
      // Never allow user error callbacks to throw back into customer code.
    }
  }
}

export function createTransport(options: TransportOptions = {}): BatchTransport {
  return new BatchTransport(options);
}
