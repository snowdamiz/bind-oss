import type { TimestampInput } from "./types.js";

const NS_PER_MS = 1_000_000n;
const RESYNC_DRIFT_NS = 1_000_000_000n;
const DECIMAL_UINT_RE = /^\d+$/;

/**
 * Creates a monotonic-assisted epoch nanosecond clock using only BigInt integer
 * arithmetic (never JS floating-point multiplication for nanoseconds).
 */
export function createNanosecondClock(): () => bigint {
  const hasHrtimeBigInt =
    typeof process !== "undefined" &&
    typeof process.hrtime === "function" &&
    typeof process.hrtime.bigint === "function";

  if (!hasHrtimeBigInt) {
    return () => BigInt(Date.now()) * NS_PER_MS;
  }

  let anchorEpochNs = BigInt(Date.now()) * NS_PER_MS;
  let anchorHrNs = process.hrtime.bigint();

  return () => {
    const hrNow = process.hrtime.bigint();
    const wallEpochNs = BigInt(Date.now()) * NS_PER_MS;
    const candidate = anchorEpochNs + (hrNow - anchorHrNs);
    const drift =
      candidate >= wallEpochNs
        ? candidate - wallEpochNs
        : wallEpochNs - candidate;

    if (drift > RESYNC_DRIFT_NS) {
      anchorEpochNs = wallEpochNs;
      anchorHrNs = hrNow;
      return wallEpochNs;
    }

    return candidate >= 0n ? candidate : 0n;
  };
}

const defaultClock = createNanosecondClock();

/**
 * Returns the current Unix epoch time in nanoseconds as a BigInt.
 */
export function nowEpochNs(): bigint {
  return defaultClock();
}

/**
 * Normalizes a timestamp input into a canonical non-negative base-10 integer string
 * representing nanoseconds since the Unix epoch.
 *
 * Rejects JS `number` values at runtime to prevent IEEE-754 precision loss.
 */
export function formatTimestampNs(
  input: TimestampInput | undefined,
  clock: () => bigint = defaultClock,
): string {
  if (input === undefined) {
    const ns = clock();
    if (typeof ns !== "bigint" || ns < 0n) {
      throw new RangeError("Clock must return a non-negative bigint");
    }
    return ns.toString(10);
  }

  if (typeof input === "bigint") {
    if (input < 0n) {
      throw new RangeError("Timestamp nanoseconds must be non-negative");
    }
    return input.toString(10);
  }

  if (typeof input === "string") {
    if (!DECIMAL_UINT_RE.test(input)) {
      throw new RangeError(
        "Timestamp string must be a non-negative base-10 integer of nanoseconds",
      );
    }
    return BigInt(input).toString(10);
  }

  if (input instanceof Date) {
    const ms = input.getTime();
    if (!Number.isInteger(ms) || ms < 0) {
      throw new RangeError("Date timestamp must be a valid non-negative date");
    }
    return (BigInt(ms) * NS_PER_MS).toString(10);
  }

  throw new TypeError(
    "Timestamp must be a bigint, decimal nanosecond string, or Date (floating-point numbers are not allowed)",
  );
}
