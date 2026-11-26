/**
 * Hand-written UTF-8 byte scanners and exact Int64 millisecond parsers for
 * timestamps (section 5 `time` hole class and `parse_time` transform).
 * Zero RegExp, strictly linear time, deterministic Gregorian calendar arithmetic.
 */

import type { ParseTimeFormat, RuntimeOptions } from "./types.js";
import {
  decodeUtf8,
  encodeUtf8,
  INT64_MAX,
  INT64_MIN,
  isAsciiDigit,
} from "./utf8.js";

const MONTHS: Readonly<Record<string, number>> = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};

const WEEKDAYS: ReadonlySet<string> = new Set([
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
]);

const RFC2822_ZONES: Readonly<Record<string, number>> = {
  UTC: 0,
  GMT: 0,
  UT: 0,
  Z: 0,
  EST: -5 * 60,
  EDT: -4 * 60,
  CST: -6 * 60,
  CDT: -5 * 60,
  MST: -7 * 60,
  MDT: -6 * 60,
  PST: -8 * 60,
  PDT: -7 * 60,
};

/**
 * Resolves the UTC reference year used for yearless timestamp formats (RFC 3164 syslog).
 * Explicit `referenceYear` takes precedence over `referenceTsMs`, defaulting to 1970.
 */
export function resolveReferenceYear(options?: RuntimeOptions): number {
  if (options === undefined) {
    return 1970;
  }
  if (options.referenceYear !== undefined && Number.isInteger(options.referenceYear)) {
    return options.referenceYear;
  }
  if (options.referenceTsMs !== undefined && Number.isFinite(options.referenceTsMs)) {
    return new Date(options.referenceTsMs).getUTCFullYear();
  }
  return 1970;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

/**
 * Howard Hinnant's proleptic Gregorian days-since-1970-01-01 algorithm in BigInt.
 */
function daysFromCivil(year: number, month: number, day: number): bigint {
  const y = BigInt(year - (month <= 2 ? 1 : 0));
  const era = y >= 0n ? y / 400n : (y - 399n) / 400n;
  const yoe = y - era * 400n;
  const m = BigInt(month);
  const d = BigInt(day);
  const doy = (153n * (m + (m > 2n ? -3n : 9n)) + 2n) / 5n + d - 1n;
  const doe = yoe * 365n + yoe / 4n - yoe / 100n + doy;
  return era * 146097n + doe - 719468n;
}

function toEpochMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  tzOffsetMinutes: number,
): bigint | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  if (second < 0 || second > 60) return null;
  if (ms < 0 || ms > 999) return null;

  // Clamp leap second 60 to 59.999s (POSIX epoch convention)
  const effSec = second === 60 ? 59 : second;
  const effMs = second === 60 ? 999 : ms;

  const days = daysFromCivil(year, month, day);
  const totalSec =
    days * 86400n +
    BigInt(hour) * 3600n +
    BigInt(minute) * 60n +
    BigInt(effSec) -
    BigInt(tzOffsetMinutes) * 60n;
  const totalMs = totalSec * 1000n + BigInt(effMs);
  if (totalMs < INT64_MIN || totalMs > INT64_MAX) {
    return null;
  }
  return totalMs;
}

function readFixedDigits(
  bytes: Uint8Array,
  pos: number,
  end: number,
  count: number,
): number {
  if (pos + count > end) return -1;
  let val = 0;
  for (let i = 0; i < count; i++) {
    const b = bytes[pos + i]!;
    if (!isAsciiDigit(b)) return -1;
    val = val * 10 + (b - 0x30);
  }
  return val;
}

/**
 * Scans optional fractional seconds `.d+` and returns `{ end, ms }` truncated to 3 digits.
 */
function scanFractionalMs(
  bytes: Uint8Array,
  pos: number,
  end: number,
): { readonly end: number; readonly ms: number } | null {
  if (pos >= end || bytes[pos] !== 0x2e /* '.' */) {
    return { end: pos, ms: 0 };
  }
  pos++;
  if (pos >= end || !isAsciiDigit(bytes[pos]!)) {
    return null;
  }
  let ms = 0;
  let weight = 100;
  while (pos < end && isAsciiDigit(bytes[pos]!)) {
    if (weight >= 1) {
      ms += (bytes[pos]! - 0x30) * weight;
      weight = Math.floor(weight / 10);
    }
    pos++;
  }
  return { end: pos, ms };
}

function scanTimezoneOffset(
  bytes: Uint8Array,
  pos: number,
  end: number,
  requireColon: boolean,
): { readonly end: number; readonly offsetMinutes: number } | null {
  if (pos >= end) return null;
  const b = bytes[pos]!;
  if (b === 0x5a /* 'Z' */ || b === 0x7a /* 'z' */) {
    return { end: pos + 1, offsetMinutes: 0 };
  }
  if (b !== 0x2b /* '+' */ && b !== 0x2d /* '-' */) {
    return null;
  }
  const sign = b === 0x2d ? -1 : 1;
  const tzH = readFixedDigits(bytes, pos + 1, end, 2);
  if (tzH < 0 || tzH > 23) return null;
  let cur = pos + 3;
  if (cur < end && bytes[cur] === 0x3a /* ':' */) {
    cur++;
  } else if (requireColon) {
    return null;
  }
  const tzM = readFixedDigits(bytes, cur, end, 2);
  if (tzM < 0 || tzM > 59) return null;
  return { end: cur + 2, offsetMinutes: sign * (tzH * 60 + tzM) };
}

export interface ScannedTime {
  readonly end: number;
  readonly epochMs: bigint;
}

/**
 * Scans ISO 8601 / RFC 3339 with mandatory explicit timezone offset:
 * `YYYY-MM-DD(T|t| )HH:MM:SS(.frac)?(Z|z|[+-]HH:?MM)`
 */
export function scanIso8601(
  bytes: Uint8Array,
  start: number,
  end: number = bytes.length,
  strictRfc3339 = false,
): ScannedTime | null {
  if (start + 19 > end) return null;
  const year = readFixedDigits(bytes, start, end, 4);
  if (year < 0 || bytes[start + 4] !== 0x2d /* '-' */) return null;
  const month = readFixedDigits(bytes, start + 5, end, 2);
  if (month < 1 || bytes[start + 7] !== 0x2d /* '-' */) return null;
  const day = readFixedDigits(bytes, start + 8, end, 2);
  if (day < 1) return null;

  const sep = bytes[start + 10]!;
  if (sep !== 0x54 /* 'T' */ && sep !== 0x74 /* 't' */ && sep !== 0x20 /* ' ' */) {
    return null;
  }

  const hour = readFixedDigits(bytes, start + 11, end, 2);
  if (hour < 0 || bytes[start + 13] !== 0x3a /* ':' */) return null;
  const minute = readFixedDigits(bytes, start + 14, end, 2);
  if (minute < 0 || bytes[start + 16] !== 0x3a /* ':' */) return null;
  const second = readFixedDigits(bytes, start + 17, end, 2);
  if (second < 0) return null;

  let pos = start + 19;
  const frac = scanFractionalMs(bytes, pos, end);
  if (frac === null) return null;
  pos = frac.end;

  // Explicit timezone offset is mandatory (offset-less ISO timestamps are rejected).
  const tz = scanTimezoneOffset(bytes, pos, end, strictRfc3339);
  if (tz === null) return null;
  pos = tz.end;

  const epochMs = toEpochMs(year, month, day, hour, minute, second, frac.ms, tz.offsetMinutes);
  if (epochMs === null) return null;
  return { end: pos, epochMs };
}

/**
 * Scans Apache Common Log Format: `DD/Mon/YYYY:HH:MM:SS( [+-]HH:?MM| Z)?`
 */
export function scanApacheTime(
  bytes: Uint8Array,
  start: number,
  end: number = bytes.length,
): ScannedTime | null {
  if (start + 20 > end) return null;
  const day = readFixedDigits(bytes, start, end, 2);
  if (day < 1 || bytes[start + 2] !== 0x2f /* '/' */) return null;
  const monStr = decodeUtf8(bytes, start + 3, start + 6);
  const month = MONTHS[monStr];
  if (month === undefined || bytes[start + 6] !== 0x2f /* '/' */) return null;
  const year = readFixedDigits(bytes, start + 7, end, 4);
  if (year < 0 || bytes[start + 11] !== 0x3a /* ':' */) return null;
  const hour = readFixedDigits(bytes, start + 12, end, 2);
  if (hour < 0 || bytes[start + 14] !== 0x3a /* ':' */) return null;
  const minute = readFixedDigits(bytes, start + 15, end, 2);
  if (minute < 0 || bytes[start + 17] !== 0x3a /* ':' */) return null;
  const second = readFixedDigits(bytes, start + 18, end, 2);
  if (second < 0) return null;

  let pos = start + 20;
  let tzOffset = 0;
  if (pos < end && bytes[pos] === 0x20 /* ' ' */) {
    const tz = scanTimezoneOffset(bytes, pos + 1, end, false);
    if (tz !== null) {
      pos = tz.end;
      tzOffset = tz.offsetMinutes;
    }
  }

  const epochMs = toEpochMs(year, month, day, hour, minute, second, 0, tzOffset);
  if (epochMs === null) return null;
  return { end: pos, epochMs };
}

/**
 * Scans RFC 3164 Syslog timestamp: `Mon  D HH:MM:SS`, `Mon D HH:MM:SS`, or `Mon DD HH:MM:SS`
 * (+ optional fractional seconds).
 */
export function scanSyslogTime(
  bytes: Uint8Array,
  start: number,
  end: number = bytes.length,
  referenceYear = 1970,
): ScannedTime | null {
  if (start + 14 > end) return null;
  const monStr = decodeUtf8(bytes, start, start + 3);
  const month = MONTHS[monStr];
  if (month === undefined || bytes[start + 3] !== 0x20 /* ' ' */) return null;

  let pos = start + 4;
  // Allow a second space before a single-digit day (standard RFC 3164 padding)
  if (pos < end && bytes[pos] === 0x20) {
    pos++;
  }
  if (pos >= end || !isAsciiDigit(bytes[pos]!)) return null;
  let day = bytes[pos]! - 0x30;
  pos++;
  if (pos < end && isAsciiDigit(bytes[pos]!)) {
    day = day * 10 + (bytes[pos]! - 0x30);
    pos++;
  }
  if (pos >= end || bytes[pos] !== 0x20 /* ' ' */) return null;
  pos++;

  const hour = readFixedDigits(bytes, pos, end, 2);
  if (hour < 0 || pos + 2 >= end || bytes[pos + 2] !== 0x3a) return null;
  const minute = readFixedDigits(bytes, pos + 3, end, 2);
  if (minute < 0 || pos + 5 >= end || bytes[pos + 5] !== 0x3a) return null;
  const second = readFixedDigits(bytes, pos + 6, end, 2);
  if (second < 0) return null;
  pos += 8;

  const frac = scanFractionalMs(bytes, pos, end);
  if (frac === null) return null;
  pos = frac.end;

  const epochMs = toEpochMs(referenceYear, month, day, hour, minute, second, frac.ms, 0);
  if (epochMs === null) return null;
  return { end: pos, epochMs };
}

/**
 * Scans RFC 2822 / HTTP-date: `(Day, )?D{1,2} Mon YYYY HH:MM:SS (GMT|UTC|UT|[+-]HHMM|...)`
 */
export function scanRfc2822Time(
  bytes: Uint8Array,
  start: number,
  end: number = bytes.length,
): ScannedTime | null {
  let pos = start;
  // Optional weekday prefix `Thu, `
  if (pos + 5 <= end && bytes[pos + 3] === 0x2c /* ',' */ && bytes[pos + 4] === 0x20) {
    const wd = decodeUtf8(bytes, pos, pos + 3);
    if (!WEEKDAYS.has(wd)) return null;
    pos += 5;
  }

  if (pos >= end || !isAsciiDigit(bytes[pos]!)) return null;
  let day = bytes[pos]! - 0x30;
  pos++;
  if (pos < end && isAsciiDigit(bytes[pos]!)) {
    day = day * 10 + (bytes[pos]! - 0x30);
    pos++;
  }
  if (pos >= end || bytes[pos] !== 0x20) return null;
  pos++;

  if (pos + 4 > end) return null;
  const monStr = decodeUtf8(bytes, pos, pos + 3);
  const month = MONTHS[monStr];
  if (month === undefined || bytes[pos + 3] !== 0x20) return null;
  pos += 4;

  const year = readFixedDigits(bytes, pos, end, 4);
  if (year < 0 || pos + 4 >= end || bytes[pos + 4] !== 0x20) return null;
  pos += 5;

  const hour = readFixedDigits(bytes, pos, end, 2);
  if (hour < 0 || pos + 2 >= end || bytes[pos + 2] !== 0x3a) return null;
  const minute = readFixedDigits(bytes, pos + 3, end, 2);
  if (minute < 0 || pos + 5 >= end || bytes[pos + 5] !== 0x3a) return null;
  const second = readFixedDigits(bytes, pos + 6, end, 2);
  if (second < 0) return null;
  pos += 8;

  if (pos >= end || bytes[pos] !== 0x20) return null;
  pos++;

  let tzOffset: number | undefined;
  const numericTz = scanTimezoneOffset(bytes, pos, end, false);
  if (numericTz !== null) {
    tzOffset = numericTz.offsetMinutes;
    pos = numericTz.end;
  } else {
    // Named timezone (1..3 uppercase ASCII letters)
    const tzStart = pos;
    while (pos < end && bytes[pos]! >= 0x41 && bytes[pos]! <= 0x5a && pos - tzStart < 3) {
      pos++;
    }
    const tzName = decodeUtf8(bytes, tzStart, pos);
    tzOffset = RFC2822_ZONES[tzName];
    if (tzOffset === undefined) return null;
  }

  const epochMs = toEpochMs(year, month, day, hour, minute, second, 0, tzOffset);
  if (epochMs === null) return null;
  return { end: pos, epochMs };
}

/**
 * Scans any supported `time` hole format starting at `start` (ISO 8601, Apache, RFC 2822, Syslog).
 */
export function scanTimeHole(
  bytes: Uint8Array,
  start: number,
  end: number = bytes.length,
  referenceYear = 1970,
): ScannedTime | null {
  return (
    scanIso8601(bytes, start, end, false) ??
    scanApacheTime(bytes, start, end) ??
    scanRfc2822Time(bytes, start, end) ??
    scanSyslogTime(bytes, start, end, referenceYear)
  );
}

function parseStrictSignedBigInt(str: string): bigint | null {
  if (str.length === 0) return null;
  let i = 0;
  if (str.charCodeAt(0) === 0x2b || str.charCodeAt(0) === 0x2d) {
    i = 1;
  }
  if (i >= str.length) return null;
  for (; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return null;
  }
  try {
    return BigInt(str);
  } catch {
    return null;
  }
}

/**
 * Exact base-10 decimal conversion of epoch seconds to Int64 milliseconds,
 * truncating sub-millisecond digits toward zero without IEEE-754 multiplication drift.
 */
function parseExactDecimalSecondsToMs(str: string): bigint | null {
  if (str.length === 0) return null;
  let pos = 0;
  let sign = 1n;
  const first = str.charCodeAt(0);
  if (first === 0x2d /* '-' */) {
    sign = -1n;
    pos = 1;
  } else if (first === 0x2b /* '+' */) {
    pos = 1;
  }

  const intStart = pos;
  while (pos < str.length) {
    const c = str.charCodeAt(pos);
    if (c < 0x30 || c > 0x39) break;
    pos++;
  }
  if (pos === intStart) return null;
  const intPart = str.slice(intStart, pos);

  let fracPart = "";
  if (pos < str.length && str.charCodeAt(pos) === 0x2e /* '.' */) {
    pos++;
    const fracStart = pos;
    while (pos < str.length) {
      const c = str.charCodeAt(pos);
      if (c < 0x30 || c > 0x39) break;
      pos++;
    }
    if (pos === fracStart) return null;
    fracPart = str.slice(fracStart, pos);
  }

  let exp = 0;
  if (pos < str.length && (str.charCodeAt(pos) === 0x65 || str.charCodeAt(pos) === 0x45)) {
    pos++;
    let expSign = 1;
    if (pos < str.length) {
      const ec = str.charCodeAt(pos);
      if (ec === 0x2d /* '-' */) {
        expSign = -1;
        pos++;
      } else if (ec === 0x2b /* '+' */) {
        pos++;
      }
    }
    const expStart = pos;
    while (pos < str.length) {
      const c = str.charCodeAt(pos);
      if (c < 0x30 || c > 0x39) break;
      pos++;
    }
    if (pos === expStart) return null;
    const expDigits = str.slice(expStart, pos);
    if (expDigits.length > 8) {
      return expSign < 0 ? 0n : null;
    }
    exp = expSign * Number(expDigits);
    if (!Number.isSafeInteger(exp)) return null;
  }

  if (pos !== str.length) return null;

  const combined = intPart + fracPart;
  let nz = 0;
  while (nz < combined.length && combined.charCodeAt(nz) === 0x30 /* '0' */) {
    nz++;
  }
  if (nz === combined.length) {
    return 0n;
  }
  const digits = combined.slice(nz);
  const totalShift = exp + 3 - fracPart.length;
  const intLen = digits.length + totalShift;
  if (intLen <= 0) {
    return 0n;
  }
  if (intLen > 19) {
    return null;
  }
  const scaled =
    totalShift >= 0 ? digits + "0".repeat(totalShift) : digits.slice(0, intLen);
  const bi = sign * BigInt(scaled);
  if (bi < INT64_MIN || bi > INT64_MAX) {
    return null;
  }
  return bi;
}

function parseUnixEpoch(
  input: string | number | bigint,
  unit: "unix_s" | "unix_ms" | "unix_us" | "unix_ns",
): bigint | null {
  if (unit === "unix_s") {
    if (typeof input === "bigint") {
      const ms = input * 1000n;
      return ms >= INT64_MIN && ms <= INT64_MAX ? ms : null;
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) return null;
      return parseExactDecimalSecondsToMs(String(input));
    }
    return parseExactDecimalSecondsToMs(input);
  }

  let rawInt: bigint | null;
  if (typeof input === "bigint") {
    rawInt = input;
  } else if (typeof input === "number") {
    if (!Number.isFinite(input) || !Number.isInteger(input)) return null;
    rawInt = BigInt(input);
  } else {
    rawInt = parseStrictSignedBigInt(input);
  }

  if (rawInt === null || rawInt < INT64_MIN || rawInt > INT64_MAX) {
    return null;
  }

  const ms =
    unit === "unix_ms"
      ? rawInt
      : unit === "unix_us"
        ? rawInt / 1000n
        : rawInt / 1_000_000n;
  if (ms < INT64_MIN || ms > INT64_MAX) return null;
  return ms;
}

/**
 * Parses a complete timestamp value into integer milliseconds since the Unix epoch (Int64).
 */
export function parseTimeValue(
  input: string | number | bigint,
  format: ParseTimeFormat = "auto",
  referenceYear = 1970,
): bigint | null {
  if (
    format === "unix_s" ||
    format === "unix_ms" ||
    format === "unix_us" ||
    format === "unix_ns"
  ) {
    return parseUnixEpoch(input, format);
  }

  if (typeof input !== "string" || input.length === 0) {
    return null;
  }

  const bytes = encodeUtf8(input);
  const len = bytes.length;
  let scanned: ScannedTime | null = null;

  switch (format) {
    case "iso8601":
      scanned = scanIso8601(bytes, 0, len, false);
      break;
    case "rfc3339":
      scanned = scanIso8601(bytes, 0, len, true);
      break;
    case "apache":
      scanned = scanApacheTime(bytes, 0, len);
      break;
    case "syslog":
      // RFC 5424 ISO/RFC 3339 syslog timestamp or yearless RFC 3164 BSD syslog timestamp
      scanned =
        scanIso8601(bytes, 0, len, true) ??
        scanSyslogTime(bytes, 0, len, referenceYear);
      break;
    case "rfc2822":
      scanned = scanRfc2822Time(bytes, 0, len);
      break;
    case "auto":
      scanned = scanTimeHole(bytes, 0, len, referenceYear);
      break;
  }

  if (scanned === null || scanned.end !== len) {
    return null;
  }
  return scanned.epochMs;
}
