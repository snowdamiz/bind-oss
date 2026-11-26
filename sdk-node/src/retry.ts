const RETRYABLE_STATUSES = new Set<number>([429, 502, 503, 504]);
const DELAY_SECONDS_RE = /^\d+$/;
const HTTP_DATE_PREFIX_RE = /^[A-Za-z]{3}/;

/**
 * Returns true strictly for HTTP status codes retryable by Bind ingest:
 * 429, 502, 503, and 504.
 */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

/**
 * Parses an RFC 9110 `Retry-After` header (either delay-seconds or HTTP-date)
 * into a bounded millisecond delay. Returns `undefined` when absent or invalid.
 */
export function parseRetryAfterMs(
  headerValue: string | null | undefined,
  nowMs: number,
  maxRetryAfterMs: number,
): number | undefined {
  if (typeof headerValue !== "string") {
    return undefined;
  }
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const cap = Math.max(0, Math.floor(maxRetryAfterMs));

  if (DELAY_SECONDS_RE.test(trimmed)) {
    const seconds = BigInt(trimmed);
    const delayMsBig = seconds * 1000n;
    const capBig = BigInt(cap);
    return Number(delayMsBig > capBig ? capBig : delayMsBig);
  }

  // RFC 9110 HTTP-date formats always start with a 3-letter weekday name.
  // Checking this prevents V8's Date.parse from accepting strings like "-5".
  if (!HTTP_DATE_PREFIX_RE.test(trimmed)) {
    return undefined;
  }

  const parsedDateMs = Date.parse(trimmed);
  if (!Number.isFinite(parsedDateMs)) {
    return undefined;
  }

  const delta = Math.floor(parsedDateMs - nowMs);
  if (delta <= 0) {
    return 0;
  }
  return Math.min(cap, delta);
}

/**
 * Computes exponential backoff with equal jitter in `[0.5 * exp, exp]`.
 */
export function computeBackoffMs(
  retryIndex: number,
  initialBackoffMs: number,
  maxBackoffMs: number,
  random: () => number = Math.random,
): number {
  const safeIndex = Math.max(0, Math.floor(retryIndex));
  const safeInitial = Math.max(0, initialBackoffMs);
  const safeMax = Math.max(safeInitial, maxBackoffMs);
  const exp = Math.min(safeMax, safeInitial * 2 ** safeIndex);
  const rawRandom = random();
  const r = Number.isFinite(rawRandom) ? Math.min(1, Math.max(0, rawRandom)) : 0.5;
  return Math.floor(exp * (0.5 + 0.5 * r));
}

/**
 * Default abort-aware sleep that resolves early when `signal` aborts.
 */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  const delay = Math.max(0, Math.floor(ms));
  if (delay === 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);

    if (typeof timer.unref === "function") {
      timer.unref();
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
