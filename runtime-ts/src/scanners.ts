/**
 * Hand-written deterministic UTF-8 byte scanners for all 11 Bind hole classes
 * (section 5): word, int, float, uuid, hex, ip, time, quoted, json, until, rest.
 *
 * Zero RegExp. Strictly linear-time O(n) scanning with exact UTF-8 byte bounds.
 */

import type { HoleClass, RedactionTokenInfo } from "./types.js";
import { scanIp } from "./ip.js";
import { parseRedactionTokenBytes, scanRedactionToken } from "./redaction.js";
import { scanTimeHole } from "./time.js";
import {
  bytesEqualAt,
  decodeUtf8,
  findBytesKmp,
  hexValue,
  isAsciiDigit,
  isAsciiHex,
  isAsciiSpace,
} from "./utf8.js";

const MAX_JSON_DEPTH = 512;

export interface HoleScanResult {
  readonly end: number;
  readonly raw: string;
  readonly text: string;
  readonly redaction?: RedactionTokenInfo;
}

export interface HoleScanContext {
  readonly nextLit?: Uint8Array;
  readonly nextLitKmp?: Int32Array;
  readonly isNextLitFinal?: boolean;
  readonly isFinalSegment?: boolean;
  readonly referenceYear: number;
}

/**
 * Scans a signed integer `[+-]?[0-9]+`.
 */
export function scanIntBytes(
  bytes: Uint8Array,
  start: number,
  end: number = bytes.length,
): number {
  let pos = start;
  if (pos >= end) return -1;
  if (bytes[pos] === 0x2b /* '+' */ || bytes[pos] === 0x2d /* '-' */) {
    pos++;
  }
  const digitStart = pos;
  while (pos < end && isAsciiDigit(bytes[pos]!)) {
    pos++;
  }
  return pos > digitStart ? pos : -1;
}

/**
 * Scans a signed decimal float `[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?`.
 */
export function scanFloatBytes(
  bytes: Uint8Array,
  start: number,
  end: number = bytes.length,
): number {
  let pos = start;
  if (pos >= end) return -1;
  if (bytes[pos] === 0x2b /* '+' */ || bytes[pos] === 0x2d /* '-' */) {
    pos++;
  }
  if (pos >= end) return -1;

  let hasDigits = false;
  while (pos < end && isAsciiDigit(bytes[pos]!)) {
    hasDigits = true;
    pos++;
  }

  // Only consume `.` if followed by at least one digit
  if (pos + 1 < end && bytes[pos] === 0x2e /* '.' */ && isAsciiDigit(bytes[pos + 1]!)) {
    pos++; // skip '.'
    while (pos < end && isAsciiDigit(bytes[pos]!)) {
      hasDigits = true;
      pos++;
    }
  }

  if (!hasDigits) return -1;

  // Optional exponent: only consume `e`/`E` if followed by optional sign + >= 1 digit
  if (pos < end && (bytes[pos] === 0x65 /* 'e' */ || bytes[pos] === 0x45 /* 'E' */)) {
    let expPos = pos + 1;
    if (
      expPos < end &&
      (bytes[expPos] === 0x2b /* '+' */ || bytes[expPos] === 0x2d /* '-' */)
    ) {
      expPos++;
    }
    if (expPos < end && isAsciiDigit(bytes[expPos]!)) {
      pos = expPos + 1;
      while (pos < end && isAsciiDigit(bytes[pos]!)) {
        pos++;
      }
    }
  }

  return pos;
}

/**
 * Scans a standard 36-byte UUID (`8-4-4-4-12` hex with `-` hyphens).
 */
export function scanUuidBytes(
  bytes: Uint8Array,
  start: number,
  end: number = bytes.length,
): number {
  if (start + 36 > end) return -1;
  for (let i = 0; i < 36; i++) {
    const b = bytes[start + i]!;
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (b !== 0x2d /* '-' */) return -1;
    } else if (!isAsciiHex(b)) {
      return -1;
    }
  }
  return start + 36;
}

/**
 * Scans a hexadecimal token: `(?:0[xX][0-9a-fA-F]+|[0-9a-fA-F]+)`.
 */
export function scanHexBytes(
  bytes: Uint8Array,
  start: number,
  end: number = bytes.length,
): number {
  let pos = start;
  if (pos >= end) return -1;
  if (
    bytes[pos] === 0x30 /* '0' */ &&
    pos + 2 < end &&
    (bytes[pos + 1] === 0x78 /* 'x' */ || bytes[pos + 1] === 0x58 /* 'X' */) &&
    isAsciiHex(bytes[pos + 2]!)
  ) {
    pos += 2;
  }
  const digitStart = pos;
  while (pos < end && isAsciiHex(bytes[pos]!)) {
    pos++;
  }
  return pos > digitStart ? pos : -1;
}

/**
 * Scans a single-quoted or double-quoted string with backslash escapes.
 */
export function scanQuotedBytes(
  bytes: Uint8Array,
  start: number,
  end: number = bytes.length,
): number {
  if (start >= end) return -1;
  const quote = bytes[start]!;
  if (quote !== 0x22 /* '"' */ && quote !== 0x27 /* "'" */) {
    return -1;
  }
  let pos = start + 1;
  while (pos < end) {
    const b = bytes[pos]!;
    if (b === 0x5c /* '\\' */) {
      if (pos + 1 >= end) {
        return -1;
      }
      pos += 2;
      continue;
    }
    if (b === quote) {
      return pos + 1;
    }
    pos++;
  }
  return -1;
}

/**
 * Strips surrounding quotes from a matched `quoted` hole and unescapes backslash sequences.
 */
export function unescapeQuoted(raw: string): string {
  const inner = raw.slice(1, raw.length - 1);
  if (inner.indexOf("\\") === -1) {
    return inner;
  }
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner.charCodeAt(i);
    if (ch !== 0x5c /* '\\' */ || i + 1 >= inner.length) {
      out += inner[i]!;
      continue;
    }
    i++;
    const next = inner.charCodeAt(i);
    switch (next) {
      case 0x22: // '"'
        out += '"';
        break;
      case 0x27: // "'"
        out += "'";
        break;
      case 0x5c: // '\\'
        out += "\\";
        break;
      case 0x2f: // '/'
        out += "/";
        break;
      case 0x62: // 'b'
        out += "\b";
        break;
      case 0x66: // 'f'
        out += "\f";
        break;
      case 0x6e: // 'n'
        out += "\n";
        break;
      case 0x72: // 'r'
        out += "\r";
        break;
      case 0x74: // 't'
        out += "\t";
        break;
      case 0x75: {
        // 'u' -> \uXXXX
        if (i + 4 < inner.length) {
          const h0 = hexValue(inner.charCodeAt(i + 1));
          const h1 = hexValue(inner.charCodeAt(i + 2));
          const h2 = hexValue(inner.charCodeAt(i + 3));
          const h3 = hexValue(inner.charCodeAt(i + 4));
          if (h0 >= 0 && h1 >= 0 && h2 >= 0 && h3 >= 0) {
            out += String.fromCharCode((h0 << 12) | (h1 << 8) | (h2 << 4) | h3);
            i += 4;
            break;
          }
        }
        out += "u";
        break;
      }
      default:
        out += inner[i]!;
        break;
    }
  }
  return out;
}

function isJsonWs(b: number): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
}

function skipJsonWs(bytes: Uint8Array, pos: number, end: number): number {
  while (pos < end && isJsonWs(bytes[pos]!)) {
    pos++;
  }
  return pos;
}

function scanJsonStringBytes(bytes: Uint8Array, start: number, end: number): number {
  if (start >= end || bytes[start] !== 0x22 /* '"' */) return -1;
  let pos = start + 1;
  while (pos < end) {
    const b = bytes[pos]!;
    if (b === 0x22 /* '"' */) {
      return pos + 1;
    }
    if (b < 0x20) {
      // Unescaped control character is forbidden by RFC 8259
      return -1;
    }
    if (b === 0x5c /* '\\' */) {
      pos++;
      if (pos >= end) return -1;
      const esc = bytes[pos]!;
      if (
        esc === 0x22 || // "
        esc === 0x5c || // \
        esc === 0x2f || // /
        esc === 0x62 || // b
        esc === 0x66 || // f
        esc === 0x6e || // n
        esc === 0x72 || // r
        esc === 0x74 // t
      ) {
        pos++;
      } else if (esc === 0x75 /* 'u' */) {
        if (pos + 4 >= end) return -1;
        for (let k = 1; k <= 4; k++) {
          if (!isAsciiHex(bytes[pos + k]!)) return -1;
        }
        pos += 5;
      } else {
        return -1;
      }
    } else {
      pos++;
    }
  }
  return -1;
}

function scanJsonNumberBytes(bytes: Uint8Array, start: number, end: number): number {
  let pos = start;
  if (pos < end && bytes[pos] === 0x2d /* '-' */) {
    pos++;
  }
  if (pos >= end) return -1;
  if (bytes[pos] === 0x30 /* '0' */) {
    pos++;
    // RFC 8259 forbids leading zeros like 01
    if (pos < end && isAsciiDigit(bytes[pos]!)) {
      return -1;
    }
  } else if (bytes[pos]! >= 0x31 && bytes[pos]! <= 0x39) {
    pos++;
    while (pos < end && isAsciiDigit(bytes[pos]!)) {
      pos++;
    }
  } else {
    return -1;
  }

  if (pos < end && bytes[pos] === 0x2e /* '.' */) {
    pos++;
    if (pos >= end || !isAsciiDigit(bytes[pos]!)) return -1;
    while (pos < end && isAsciiDigit(bytes[pos]!)) {
      pos++;
    }
  }

  if (pos < end && (bytes[pos] === 0x65 /* 'e' */ || bytes[pos] === 0x45 /* 'E' */)) {
    pos++;
    if (pos < end && (bytes[pos] === 0x2b || bytes[pos] === 0x2d)) {
      pos++;
    }
    if (pos >= end || !isAsciiDigit(bytes[pos]!)) return -1;
    while (pos < end && isAsciiDigit(bytes[pos]!)) {
      pos++;
    }
  }

  return pos;
}

const TRUE_BYTES = new Uint8Array([0x74, 0x72, 0x75, 0x65]);
const FALSE_BYTES = new Uint8Array([0x66, 0x61, 0x6c, 0x73, 0x65]);
const NULL_BYTES = new Uint8Array([0x6e, 0x75, 0x6c, 0x6c]);

const enum JsonContainerKind {
  Object = 1,
  Array = 2,
}

const enum JsonState {
  ExpectValue = 1,
  ExpectObjKeyOrEnd = 2,
  ExpectObjKey = 3,
  ExpectObjColon = 4,
  ExpectObjCommaOrEnd = 5,
  ExpectArrValueOrEnd = 6,
  ExpectArrCommaOrEnd = 7,
}

/**
 * Iterative, strictly linear-time RFC 8259 scanner for a balanced JSON object or array
 * starting at `start`. Stops immediately upon closing the root `{` or `[`.
 */
export function scanJsonContainerBytes(
  bytes: Uint8Array,
  start: number,
  end: number = bytes.length,
): number {
  if (start >= end) return -1;
  const first = bytes[start]!;
  if (first !== 0x7b /* '{' */ && first !== 0x5b /* '[' */) {
    return -1;
  }

  const stack: JsonContainerKind[] = [];
  let pos = start;
  let state: JsonState = JsonState.ExpectValue;

  while (pos < end) {
    pos = skipJsonWs(bytes, pos, end);
    if (pos >= end) return -1;
    const b = bytes[pos]!;

    switch (state) {
      case JsonState.ExpectValue: {
        if (b === 0x7b /* '{' */) {
          if (stack.length >= MAX_JSON_DEPTH) return -1;
          stack.push(JsonContainerKind.Object);
          pos++;
          state = JsonState.ExpectObjKeyOrEnd;
        } else if (b === 0x5b /* '[' */) {
          if (stack.length >= MAX_JSON_DEPTH) return -1;
          stack.push(JsonContainerKind.Array);
          pos++;
          state = JsonState.ExpectArrValueOrEnd;
        } else if (b === 0x22 /* '"' */) {
          pos = scanJsonStringBytes(bytes, pos, end);
          if (pos < 0) return -1;
          state = afterValueState(stack);
        } else if (b === 0x2d || isAsciiDigit(b)) {
          pos = scanJsonNumberBytes(bytes, pos, end);
          if (pos < 0) return -1;
          state = afterValueState(stack);
        } else if (bytesEqualAt(bytes, pos, TRUE_BYTES)) {
          pos += 4;
          state = afterValueState(stack);
        } else if (bytesEqualAt(bytes, pos, FALSE_BYTES)) {
          pos += 5;
          state = afterValueState(stack);
        } else if (bytesEqualAt(bytes, pos, NULL_BYTES)) {
          pos += 4;
          state = afterValueState(stack);
        } else {
          return -1;
        }
        break;
      }

      case JsonState.ExpectObjKeyOrEnd: {
        if (b === 0x7d /* '}' */) {
          stack.pop();
          pos++;
          if (stack.length === 0) return pos;
          state = afterValueState(stack);
        } else if (b === 0x22 /* '"' */) {
          pos = scanJsonStringBytes(bytes, pos, end);
          if (pos < 0) return -1;
          state = JsonState.ExpectObjColon;
        } else {
          return -1;
        }
        break;
      }

      case JsonState.ExpectObjKey: {
        if (b !== 0x22 /* '"' */) return -1;
        pos = scanJsonStringBytes(bytes, pos, end);
        if (pos < 0) return -1;
        state = JsonState.ExpectObjColon;
        break;
      }

      case JsonState.ExpectObjColon: {
        if (b !== 0x3a /* ':' */) return -1;
        pos++;
        state = JsonState.ExpectValue;
        break;
      }

      case JsonState.ExpectObjCommaOrEnd: {
        if (b === 0x2c /* ',' */) {
          pos++;
          state = JsonState.ExpectObjKey;
        } else if (b === 0x7d /* '}' */) {
          stack.pop();
          pos++;
          if (stack.length === 0) return pos;
          state = afterValueState(stack);
        } else {
          return -1;
        }
        break;
      }

      case JsonState.ExpectArrValueOrEnd: {
        if (b === 0x5d /* ']' */) {
          stack.pop();
          pos++;
          if (stack.length === 0) return pos;
          state = afterValueState(stack);
        } else {
          state = JsonState.ExpectValue;
        }
        break;
      }

      case JsonState.ExpectArrCommaOrEnd: {
        if (b === 0x2c /* ',' */) {
          pos++;
          state = JsonState.ExpectValue;
        } else if (b === 0x5d /* ']' */) {
          stack.pop();
          pos++;
          if (stack.length === 0) return pos;
          state = afterValueState(stack);
        } else {
          return -1;
        }
        break;
      }
    }
  }

  return -1;
}

function afterValueState(stack: readonly JsonContainerKind[]): JsonState {
  const top = stack[stack.length - 1];
  return top === JsonContainerKind.Object
    ? JsonState.ExpectObjCommaOrEnd
    : JsonState.ExpectArrCommaOrEnd;
}

/**
 * Validates that an entire byte slice is any valid RFC 8259 JSON value
 * (object, array, string, number, boolean, or null) with optional surrounding JSON whitespace.
 */
export function isValidJsonValueBytes(bytes: Uint8Array): boolean {
  const end = bytes.length;
  let pos = skipJsonWs(bytes, 0, end);
  if (pos >= end) return false;
  const b = bytes[pos]!;
  if (b === 0x7b || b === 0x5b) {
    pos = scanJsonContainerBytes(bytes, pos, end);
  } else if (b === 0x22) {
    pos = scanJsonStringBytes(bytes, pos, end);
  } else if (b === 0x2d || isAsciiDigit(b)) {
    pos = scanJsonNumberBytes(bytes, pos, end);
  } else if (bytesEqualAt(bytes, pos, TRUE_BYTES)) {
    pos += 4;
  } else if (bytesEqualAt(bytes, pos, FALSE_BYTES)) {
    pos += 5;
  } else if (bytesEqualAt(bytes, pos, NULL_BYTES)) {
    pos += 4;
  } else {
    return false;
  }
  if (pos < 0) return false;
  pos = skipJsonWs(bytes, pos, end);
  return pos === end;
}

/**
 * Scans a `word` hole (non-empty run of non-ASCII-space UTF-8 bytes)
 * within the bounded byte window `[start, end)`.
 */
function scanWordBytes(
  bytes: Uint8Array,
  start: number,
  end: number,
): number {
  let runEnd = start;
  while (runEnd < end && !isAsciiSpace(bytes[runEnd]!)) {
    runEnd++;
  }
  return runEnd > start ? runEnd : -1;
}

function tryRedactionTokenAtBoundary(
  bytes: Uint8Array,
  start: number,
  end: number,
  holeClass: HoleClass,
  ctx: HoleScanContext,
): HoleScanResult | null {
  const scanned = scanRedactionToken(bytes, start, end);
  if (scanned === null) {
    return null;
  }
  const tokEnd = scanned.end;

  // Verify the redaction token terminates cleanly at the next literal or token boundary
  if (ctx.nextLit !== undefined && ctx.nextLit.length > 0) {
    if (!bytesEqualAt(bytes, tokEnd, ctx.nextLit)) {
      return null;
    }
  } else if (ctx.isFinalSegment) {
    if (tokEnd !== end) {
      return null;
    }
  } else if (holeClass === "word") {
    // For adjacent holes without an intervening literal, ensure `<card>foo` isn't split into `<card>` + `foo`
    if (tokEnd < end && !isAsciiSpace(bytes[tokEnd]!)) {
      return null;
    }
  }

  return {
    end: tokEnd,
    raw: scanned.info.raw,
    text: scanned.info.raw,
    redaction: scanned.info,
  };
}

/**
 * Scans a single hole of `holeClass` starting at UTF-8 byte offset `start` in `bytes[start..end)`.
 */
export function scanHole(
  bytes: Uint8Array,
  start: number,
  end: number,
  holeClass: HoleClass,
  ctx: HoleScanContext,
): HoleScanResult | null {
  // 1. Variable-span classes `until` and `rest`
  if (holeClass === "rest") {
    const raw = decodeUtf8(bytes, start, end);
    const redaction = parseRedactionTokenBytes(bytes, start, end);
    return redaction !== null
      ? { end, raw, text: raw, redaction }
      : { end, raw, text: raw };
  }

  if (holeClass === "until") {
    let sliceEnd: number;
    if (ctx.nextLit !== undefined && ctx.nextLit.length > 0) {
      const found = findBytesKmp(bytes, ctx.nextLit, start, end, ctx.nextLitKmp);
      if (found < 0) return null;
      sliceEnd = found;
    } else {
      sliceEnd = end;
    }
    const raw = decodeUtf8(bytes, start, sliceEnd);
    const redaction = parseRedactionTokenBytes(bytes, start, sliceEnd);
    return redaction !== null
      ? { end: sliceEnd, raw, text: raw, redaction }
      : { end: sliceEnd, raw, text: raw };
  }

  // 2. Section 14 redaction token matches any hole class
  const tok = tryRedactionTokenAtBoundary(bytes, start, end, holeClass, ctx);
  if (tok !== null) {
    return tok;
  }

  // 3. Variable-width scalar classes (word, int, float, hex, ip) bound at the
  // leftmost occurrence of an immediately following literal segment with no backtracking.
  const isBoundedScalar =
    holeClass === "word" ||
    holeClass === "int" ||
    holeClass === "float" ||
    holeClass === "hex" ||
    holeClass === "ip";
  const hasFollowingLit = ctx.nextLit !== undefined && ctx.nextLit.length > 0;
  let scanEnd = end;
  if (isBoundedScalar && hasFollowingLit) {
    const litPos = findBytesKmp(bytes, ctx.nextLit!, start, end, ctx.nextLitKmp);
    if (litPos <= start) {
      return null;
    }
    scanEnd = litPos;
  }

  // 4. Class-specific deterministic byte scanner
  let matchEnd = -1;
  switch (holeClass) {
    case "word":
      matchEnd = scanWordBytes(bytes, start, scanEnd);
      break;
    case "int":
      matchEnd = scanIntBytes(bytes, start, scanEnd);
      break;
    case "float":
      matchEnd = scanFloatBytes(bytes, start, scanEnd);
      break;
    case "uuid":
      matchEnd = scanUuidBytes(bytes, start, end);
      break;
    case "hex":
      matchEnd = scanHexBytes(bytes, start, scanEnd);
      break;
    case "ip": {
      const scannedIp = scanIp(bytes, start, scanEnd);
      matchEnd = scannedIp !== null ? scannedIp.end : -1;
      break;
    }
    case "time": {
      const scannedTime = scanTimeHole(bytes, start, end, ctx.referenceYear);
      matchEnd = scannedTime !== null ? scannedTime.end : -1;
      break;
    }
    case "quoted":
      matchEnd = scanQuotedBytes(bytes, start, end);
      break;
    case "json":
      matchEnd = scanJsonContainerBytes(bytes, start, end);
      break;
  }

  if (matchEnd < 0) {
    return null;
  }
  if (isBoundedScalar && hasFollowingLit && matchEnd !== scanEnd) {
    return null;
  }

  const raw = decodeUtf8(bytes, start, matchEnd);
  const text = holeClass === "quoted" ? unescapeQuoted(raw) : raw;
  return { end: matchEnd, raw, text };
}
