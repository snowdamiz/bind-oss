import { BatchTransport } from "./transport.js";
import type {
  BatchIdentity,
  BindInitOptions,
  LogRecordInput,
  RecordSink,
  TransportStats,
} from "./types.js";

/**
 * Thin Bind Node client owning a single `BatchTransport` instance.
 * Higher-level capture APIs (T1.6.2 `log`, T1.6.3 `console`/pino/winston)
 * write into this `RecordSink`.
 */
export class BindClient implements RecordSink {
  readonly transport: BatchTransport;

  constructor(options: BindInitOptions = {}) {
    this.transport = new BatchTransport(options);
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
}

let defaultClient: BindClient | undefined;

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
