import type { CallSiteResolver } from "./callsite.js";
import { BindLoggerCore, createBoundLogger } from "./logger.js";
import { BatchTransport } from "./transport.js";
import type {
  BatchIdentity,
  BindInitOptions,
  CallSiteCacheStats,
  Logger,
  LogRecordInput,
  RecordSink,
  TransportStats,
} from "./types.js";

/**
 * Thin Bind Node client owning a single `BatchTransport` instance and its
 * paired capture `Logger` (`client.log`).
 */
export class BindClient implements RecordSink {
  readonly transport: BatchTransport;
  readonly log: Logger;
  readonly callsiteResolver: CallSiteResolver;

  /** @internal */
  readonly _loggerCore: BindLoggerCore;

  constructor(options: BindInitOptions = {}) {
    this.transport = new BatchTransport(options);
    this._loggerCore = new BindLoggerCore(this.transport, {
      onError: options.onError,
      callsite: options.callsite,
    });
    this.callsiteResolver = this._loggerCore.callsiteResolver;
    this.log = createBoundLogger(() => this._loggerCore);
  }

  get identity(): Readonly<BatchIdentity> {
    return this.transport.identity;
  }

  enqueue(record: LogRecordInput): boolean {
    return this.transport.enqueue(record);
  }

  flush(): Promise<void> {
    return this.transport.flush();
  }

  shutdown(timeoutMs?: number): Promise<void> {
    return this.transport.shutdown(timeoutMs);
  }

  getStats(): TransportStats {
    return this.transport.getStats();
  }

  getCallSiteStats(): CallSiteCacheStats {
    return this.callsiteResolver.getStats();
  }
}

let defaultClient: BindClient | undefined;

/**
 * Process-wide Bind logger bound dynamically to the active client initialized
 * by `init()`. Safe to call (no-op returning `false`) before `init()` or after
 * `shutdown()`. Child loggers created via `log.child(...)` before `init()`
 * automatically bind once `init()` runs.
 */
export const log: Logger = createBoundLogger(() => defaultClient?._loggerCore);

export function createClient(options: BindInitOptions = {}): BindClient {
  return new BindClient(options);
}

/**
 * Initializes the process-wide default Bind client with resolved identity
 * (`service`, `env`, `release`) and ingest key.
 */
export function init(options: BindInitOptions = {}): BindClient {
  const previous = defaultClient;
  const next = new BindClient(options);
  defaultClient = next;
  if (previous) {
    void previous.shutdown(0);
  }
  return next;
}

/**
 * Returns the active default Bind client initialized by `init()`, if any.
 */
export function getClient(): BindClient | undefined {
  return defaultClient;
}

/**
 * Flushes the active default Bind client, if initialized.
 */
export function flush(): Promise<void> {
  if (!defaultClient) {
    return Promise.resolve();
  }
  return defaultClient.flush();
}

/**
 * Shuts down and clears the active default Bind client, if initialized.
 */
export function shutdown(timeoutMs?: number): Promise<void> {
  const current = defaultClient;
  defaultClient = undefined;
  if (!current) {
    return Promise.resolve();
  }
  return current.shutdown(timeoutMs);
}
