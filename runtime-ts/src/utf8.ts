/**
 * UTF-8 byte helpers, ASCII byte classification, linear-time KMP byte search,
 * and IEEE 754 binary64 hex formatting. Zero RegExp, zero external dependencies.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

const HEX_DIGITS = "0123456789abcdef";

export const INT64_MIN = -9223372036854775808n;
export const INT64_MAX = 9223372036854775807n;

export function encodeUtf8(str: string): Uint8Array {
  return textEncoder.encode(str);
}

export function decodeUtf8(bytes: Uint8Array, start = 0, end = bytes.length): string {
  if (start === 0 && end === bytes.length) {
    return textDecoder.decode(bytes);
  }
  return textDecoder.decode(bytes.subarray(start, end));
}

/**
 * ASCII whitespace matching RE2 `\s` (`[\t\n\f\r ]`).
 * Explicitly excludes non-ASCII spaces such as U+00A0 and U+3000 so that
 * Mesh, SQL (RE2), TypeScript, and Swift agree on UTF-8 byte boundaries.
 */
export function isAsciiSpace(byte: number): boolean {
  return (
    byte === 0x20 || // ' '
    byte === 0x09 || // '\t'
    byte === 0x0a || // '\n'
    byte === 0x0c || // '\f'
    byte === 0x0d // '\r'
  );
}

export function isAsciiDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

export function isAsciiHex(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x46) ||
    (byte >= 0x61 && byte <= 0x66)
  );
}

export function isAsciiLowerHex(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66);
}

export function isAsciiLowerAlpha(byte: number): boolean {
  return byte >= 0x61 && byte <= 0x7a;
}

export function isAsciiAlpha(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}

export function isRedactionIdentChar(byte: number): boolean {
  return (
    (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x30 && byte <= 0x39) ||
    byte === 0x5f // '_'
  );
}

export function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  return -1;
}

export function bytesEqualAt(
  haystack: Uint8Array,
  offset: number,
  needle: Uint8Array,
): boolean {
  const nLen = needle.length;
  if (offset < 0 || offset + nLen > haystack.length) {
    return false;
  }
  for (let i = 0; i < nLen; i++) {
    if (haystack[offset + i] !== needle[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Builds a KMP failure table (prefix function) for linear-time O(n + m) search.
 */
export function buildKmpTable(needle: Uint8Array): Int32Array {
  const m = needle.length;
  const table = new Int32Array(m);
  let len = 0;
  for (let i = 1; i < m; i++) {
    while (len > 0 && needle[i] !== needle[len]) {
      len = table[len - 1]!;
    }
    if (needle[i] === needle[len]) {
      len++;
      table[i] = len;
    }
  }
  return table;
}

/**
 * Finds the earliest index >= `start` and <= `end - needle.length` where `needle`
 * occurs inside `haystack[start..end)` using KMP in guaranteed O((end - start) + needle.length) time.
 * Returns -1 if not found.
 */
export function findBytesKmp(
  haystack: Uint8Array,
  needle: Uint8Array,
  start: number,
  end: number = haystack.length,
  table?: Int32Array,
): number {
  const m = needle.length;
  if (m === 0) {
    return start <= end ? start : -1;
  }
  if (end - start < m) {
    return -1;
  }
  if (m === 1) {
    const b0 = needle[0]!;
    for (let i = start; i < end; i++) {
      if (haystack[i] === b0) return i;
    }
    return -1;
  }

  const lps = table ?? buildKmpTable(needle);
  let j = 0;
  for (let i = start; i < end; i++) {
    const b = haystack[i]!;
    while (j > 0 && b !== needle[j]) {
      j = lps[j - 1]!;
    }
    if (b === needle[j]) {
      j++;
      if (j === m) {
        return i - m + 1;
      }
    }
  }
  return -1;
}

export function toLowerHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX_DIGITS[(b >>> 4) & 0x0f]! + HEX_DIGITS[b & 0x0f]!;
  }
  return out;
}

export function fromHex(hex: string): Uint8Array | null {
  if ((hex.length & 1) !== 0) return null;
  const out = new Uint8Array(hex.length >>> 1);
  for (let i = 0; i < out.length; i++) {
    const hi = hexValue(hex.charCodeAt(i * 2));
    const lo = hexValue(hex.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) return null;
    out[i] = (hi << 4) | lo;
  }
  return out;
}

const floatBuf = new ArrayBuffer(8);
const floatView = new DataView(floatBuf);

/**
 * Encodes an IEEE 754 double-precision float as its 16-char big-endian lowercase hex bit pattern.
 */
export function float64ToHex(value: number): string {
  floatView.setFloat64(0, value, false);
  const hi = floatView.getUint32(0, false);
  const lo = floatView.getUint32(4, false);
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

export function toSafeIntOrBigInt(value: bigint): number | bigint {
  if (
    value >= BigInt(Number.MIN_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  return value;
}

export function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
