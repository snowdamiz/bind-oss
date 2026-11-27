/**
 * Hand-written UTF-8 byte scanner for Bind replacement tokens:
 *   - Mask tokens:            `<card>`, `<name>`, `<secret:jwt>`, `<secret:field>`
 *   - Pseudonym tokens:       `<email:9f2c41d07a3b55e1>` (16 lowercase hex chars)
 *   - Edge inner tokens:      `<email:~<64 lowercase hex chars>>`
 *
 * Zero RegExp, strictly linear time.
 */

import type { ByteSpan, RedactionTokenInfo } from "./types.js";
import {
  decodeUtf8,
  encodeUtf8,
  hexValue,
  isAsciiLowerAlpha,
  isAsciiLowerHex,
  isAsciiSpace,
  isRedactionIdentChar,
} from "./utf8.js";

/**
 * Closed set of detector and PII redaction token kinds.
 * Restricting token kinds to this catalog prevents arbitrary HTML/XML tags
 * or unknown markers such as `<div>` or `<nil>` from being treated as redaction tokens.
 */
export const KNOWN_MASK_TOKEN_KINDS: ReadonlySet<string> = new Set([
  "secret",
  "private_key",
  "jwt",
  "auth_header",
  "vendor_token",
  "kv_secret",
  "url_credentials",
  "high_entropy",
  "card",
  "us_ssn",
  "email",
  "phone",
  "ip",
  "long_digits",
  "name",
  "address",
  "free_text",
  "pseudonymous_id",
  "hash",
  "redacted",
]);

export interface ScannedRedactionToken {
  readonly end: number;
  readonly info: RedactionTokenInfo;
}

/**
 * Attempts to scan a known replacement token starting at `start` within `bytes[start..end)`.
 * Returns the end byte offset (immediately after `>`) and parsed metadata, or null if none starts at `start`.
 */
export function scanRedactionToken(
  bytes: Uint8Array,
  start: number,
  end: number = bytes.length,
): ScannedRedactionToken | null {
  if (start >= end || bytes[start] !== 0x3c /* '<' */) {
    return null;
  }

  let i = start + 1;
  if (i >= end || !isAsciiLowerAlpha(bytes[i]!)) {
    return null;
  }
  const kindStart = i;
  i++;
  while (i < end && isRedactionIdentChar(bytes[i]!)) {
    i++;
  }
  const kind = decodeUtf8(bytes, kindStart, i);

  if (i >= end) {
    return null;
  }

  // Form 1: `<kind>` (closed catalog only)
  if (bytes[i] === 0x3e /* '>' */) {
    if (!KNOWN_MASK_TOKEN_KINDS.has(kind)) {
      return null;
    }
    const tokenEnd = i + 1;
    return {
      end: tokenEnd,
      info: {
        category: "mask",
        kind,
        raw: decodeUtf8(bytes, start, tokenEnd),
      },
    };
  }

  if (bytes[i] !== 0x3a /* ':' */) {
    return null;
  }
  i++; // skip ':'
  if (i >= end) {
    return null;
  }

  // Form 2: `<kind:~<64 lowercase hex>>` (edge inner pseudonym token across all schema-valid hash.kind labels)
  if (bytes[i] === 0x7e /* '~' */) {
    const hexStart = i + 1;
    const hexEnd = hexStart + 64;
    if (hexEnd < end && bytes[hexEnd] === 0x3e /* '>' */) {
      let validInner = true;
      for (let k = hexStart; k < hexEnd; k++) {
        if (!isAsciiLowerHex(bytes[k]!)) {
          validInner = false;
          break;
        }
      }
      if (validInner) {
        const tokenEnd = hexEnd + 1;
        return {
          end: tokenEnd,
          info: {
            category: "inner_pseudonym",
            kind,
            innerHex: decodeUtf8(bytes, hexStart, hexEnd),
            raw: decodeUtf8(bytes, start, tokenEnd),
          },
        };
      }
    }
  }

  // Closed catalog strictly applies to incoming final pseudonyms and normal mask descriptors
  if (!KNOWN_MASK_TOKEN_KINDS.has(kind)) {
    return null;
  }

  // Form 3: `<kind:tag>` (16 lowercase hex chars -> pseudonym) OR `<kind:descriptor>` (mask)
  const payloadStart = i;
  let allLowerHex = true;
  while (i < end) {
    const b = bytes[i]!;
    if (b === 0x3e /* '>' */) {
      break;
    }
    if (isAsciiSpace(b) || b === 0x3c /* '<' */) {
      return null;
    }
    if (!isAsciiLowerHex(b)) {
      allLowerHex = false;
    }
    i++;
  }
  if (i === payloadStart || i >= end || bytes[i] !== 0x3e /* '>' */) {
    return null;
  }

  const payloadLen = i - payloadStart;
  const payload = decodeUtf8(bytes, payloadStart, i);
  const tokenEnd = i + 1;
  const raw = decodeUtf8(bytes, start, tokenEnd);

  if (payloadLen === 16 && allLowerHex) {
    return {
      end: tokenEnd,
      info: {
        category: "pseudonym",
        kind,
        tag: payload,
        raw,
      },
    };
  }

  return {
    end: tokenEnd,
    info: {
      category: "mask",
      kind,
      subkind: payload,
      raw,
    },
  };
}

/**
 * Checks whether an entire byte range `bytes[start..end)` is a single known replacement token.
 */
export function parseRedactionTokenBytes(
  bytes: Uint8Array,
  start = 0,
  end: number = bytes.length,
): RedactionTokenInfo | null {
  const scanned = scanRedactionToken(bytes, start, end);
  if (scanned === null || scanned.end !== end) {
    return null;
  }
  return scanned.info;
}

/**
 * Checks whether an entire string is a single known replacement token.
 */
export function parseRedactionTokenString(str: string): RedactionTokenInfo | null {
  if (str.length < 3 || str.charCodeAt(0) !== 0x3c || str.charCodeAt(str.length - 1) !== 0x3e) {
    return null;
  }
  const bytes = encodeUtf8(str);
  return parseRedactionTokenBytes(bytes, 0, bytes.length);
}

/**
 * Parses an entire string as a well-formed inner edge pseudonym token
 * `<[a-z][a-z0-9_]*:~[0-9a-f]{64}>` for any schema-valid hash.kind label (including custom kinds).
 */
export function parseInnerEdgeTokenString(str: string): RedactionTokenInfo | null {
  // Minimum: "<a:~" (4) + 64 hex + ">" (1) = 69
  if (str.length < 69 || str.charCodeAt(0) !== 0x3c || str.charCodeAt(str.length - 1) !== 0x3e) {
    return null;
  }
  const colonIdx = str.length - 67;
  if (str.charCodeAt(colonIdx) !== 0x3a || str.charCodeAt(colonIdx + 1) !== 0x7e) {
    return null;
  }
  if (!isAsciiLowerAlpha(str.charCodeAt(1))) {
    return null;
  }
  for (let i = 2; i < colonIdx; i++) {
    if (!isRedactionIdentChar(str.charCodeAt(i))) {
      return null;
    }
  }
  for (let i = colonIdx + 2; i < str.length - 1; i++) {
    if (!isAsciiLowerHex(str.charCodeAt(i))) {
      return null;
    }
  }
  return {
    category: "inner_pseudonym",
    kind: str.slice(1, colonIdx),
    innerHex: str.slice(colonIdx + 2, str.length - 1),
    raw: str,
  };
}

/**
 * Checks whether an entire string matches the edge inner pseudonym shape
 * `<[a-z][a-z0-9_]*:~[0-9a-f]{64}>` for any valid schema kind (including custom kinds).
 */
export function isInnerEdgeTokenString(str: string): boolean {
  return parseInnerEdgeTokenString(str) !== null;
}

/**
 * Finds all disjoint well-formed inner edge token byte spans
 * `<[a-z][a-z0-9_]*:~[0-9a-f]{64}>` in a UTF-8 byte sequence in strictly linear O(n) time.
 */
export function findInnerEdgeTokenSpansBytes(bytes: Uint8Array): readonly ByteSpan[] {
  const len = bytes.length;
  if (len < 69) return [];

  const spans: ByteSpan[] = [];
  let minLtPos = 0;
  let pos = 2;
  const maxColon = len - 67;

  while (pos <= maxColon) {
    if (bytes[pos] !== 0x3a /* ':' */ || bytes[pos + 1] !== 0x7e /* '~' */) {
      pos++;
      continue;
    }
    if (bytes[pos + 66] !== 0x3e /* '>' */) {
      pos += 2;
      continue;
    }
    let hexOk = true;
    for (let k = pos + 2; k < pos + 66; k++) {
      if (!isAsciiLowerHex(bytes[k]!)) {
        hexOk = false;
        break;
      }
    }
    if (!hexOk) {
      pos += 2;
      continue;
    }
    let cur = pos - 1;
    while (cur > minLtPos && isRedactionIdentChar(bytes[cur]!)) {
      cur--;
    }
    const spanEnd = pos + 67;
    if (bytes[cur] === 0x3c /* '<' */) {
      const identStart = cur + 1;
      if (identStart < pos && isAsciiLowerAlpha(bytes[identStart]!)) {
        spans.push({ start: cur, end: spanEnd });
      }
    }
    minLtPos = spanEnd;
    pos = spanEnd + 2;
  }

  return spans;
}

/**
 * Returns true when `str` contains any well-formed inner edge token
 * `<[a-z][a-z0-9_]*:~[0-9a-f]{64}>` (strictly linear O(n), zero RegExp, zero allocations).
 */
export function containsInnerEdgeTokenString(str: string): boolean {
  const len = str.length;
  if (len < 69 || !str.includes(":~")) {
    return false;
  }

  let minLtPos = 0;
  let pos = 2;
  const maxColon = len - 67;

  while (pos <= maxColon) {
    if (str.charCodeAt(pos) !== 0x3a || str.charCodeAt(pos + 1) !== 0x7e) {
      pos++;
      continue;
    }
    if (str.charCodeAt(pos + 66) !== 0x3e) {
      pos += 2;
      continue;
    }
    let hexOk = true;
    for (let k = pos + 2; k < pos + 66; k++) {
      if (!isAsciiLowerHex(str.charCodeAt(k))) {
        hexOk = false;
        break;
      }
    }
    if (!hexOk) {
      pos += 2;
      continue;
    }
    let cur = pos - 1;
    while (cur > minLtPos && isRedactionIdentChar(str.charCodeAt(cur))) {
      cur--;
    }
    if (str.charCodeAt(cur) === 0x3c) {
      const identStart = cur + 1;
      if (identStart < pos && isAsciiLowerAlpha(str.charCodeAt(identStart))) {
        return true;
      }
    }
    minLtPos = pos + 67;
    pos = pos + 69;
  }

  return false;
}

/**
 * Checks whether non-empty `span` overlaps any span in sorted disjoint `spans` in O(log k) time.
 */
export function spanOverlapsAny(span: ByteSpan, spans: readonly ByteSpan[]): boolean {
  if (span.start >= span.end || spans.length === 0) return false;
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (spans[mid]!.end <= span.start) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo < spans.length && spans[lo]!.start < span.end;
}

function decodeJsonStringContent(raw: string, start: number, end: number): string | null {
  const parts: string[] = [];
  let chunkStart = start;
  for (let i = start; i < end; i++) {
    if (raw.charCodeAt(i) !== 0x5c /* '\\' */) {
      continue;
    }
    if (i > chunkStart) {
      parts.push(raw.slice(chunkStart, i));
    }
    i++;
    if (i >= end) {
      return null;
    }
    const esc = raw.charCodeAt(i);
    switch (esc) {
      case 0x22: // '"'
        parts.push('"');
        break;
      case 0x5c: // '\\'
        parts.push("\\");
        break;
      case 0x2f: // '/'
        parts.push("/");
        break;
      case 0x62: // 'b'
        parts.push("\b");
        break;
      case 0x66: // 'f'
        parts.push("\f");
        break;
      case 0x6e: // 'n'
        parts.push("\n");
        break;
      case 0x72: // 'r'
        parts.push("\r");
        break;
      case 0x74: // 't'
        parts.push("\t");
        break;
      case 0x75: {
        // 'u' -> \uXXXX
        if (i + 4 >= end) {
          return null;
        }
        const h0 = hexValue(raw.charCodeAt(i + 1));
        const h1 = hexValue(raw.charCodeAt(i + 2));
        const h2 = hexValue(raw.charCodeAt(i + 3));
        const h3 = hexValue(raw.charCodeAt(i + 4));
        if (h0 < 0 || h1 < 0 || h2 < 0 || h3 < 0) {
          return null;
        }
        parts.push(String.fromCharCode((h0 << 12) | (h1 << 8) | (h2 << 4) | h3));
        i += 4;
        break;
      }
      default:
        return null;
    }
    chunkStart = i + 1;
  }
  if (chunkStart < end) {
    parts.push(raw.slice(chunkStart, end));
  }
  return parts.join("");
}

/**
 * Lexically scans every RFC 8259 JSON string token (object keys and values,
 * including duplicate object members before deduplication by `JSON.parse`)
 * and returns true when any decoded string contains a well-formed inner edge
 * token `<[a-z][a-z0-9_]*:~[0-9a-f]{64}>`. Strictly linear O(n), zero RegExp.
 */
export function jsonTextContainsInnerEdgeToken(rawJson: string): boolean {
  const len = rawJson.length;
  // Minimum JSON string token containing an inner edge token: '"' + 69 + '"' = 71
  if (len < 71 || (!rawJson.includes(":~") && !rawJson.includes("\\u"))) {
    return false;
  }

  let pos = 0;
  while (pos < len) {
    if (rawJson.charCodeAt(pos) !== 0x22 /* '"' */) {
      pos++;
      continue;
    }
    const contentStart = pos + 1;
    pos = contentStart;
    let hasEscape = false;
    let hasUnicodeEscape = false;
    let closed = false;
    while (pos < len) {
      const ch = rawJson.charCodeAt(pos);
      if (ch === 0x5c /* '\\' */) {
        hasEscape = true;
        if (pos + 1 >= len) {
          return false;
        }
        if (rawJson.charCodeAt(pos + 1) === 0x75 /* 'u' */) {
          hasUnicodeEscape = true;
        }
        pos += 2;
        continue;
      }
      if (ch === 0x22 /* '"' */) {
        closed = true;
        break;
      }
      pos++;
    }
    if (!closed) {
      return false;
    }
    const contentEnd = pos;
    pos++; // advance past closing '"'

    // RFC 8259 escapes never lengthen a string (\uXXXX -> 1 char, \X -> 1 char).
    if (contentEnd - contentStart < 69) {
      continue;
    }

    if (!hasEscape) {
      if (containsInnerEdgeTokenString(rawJson.slice(contentStart, contentEnd))) {
        return true;
      }
      continue;
    }

    if (!hasUnicodeEscape) {
      const colonTildeIdx = rawJson.indexOf(":~", contentStart);
      if (colonTildeIdx === -1 || colonTildeIdx >= contentEnd) {
        continue;
      }
    }

    const decoded = decodeJsonStringContent(rawJson, contentStart, contentEnd);
    if (decoded !== null && containsInnerEdgeTokenString(decoded)) {
      return true;
    }
  }

  return false;
}

/**
 * Iteratively checks whether a structured/JSON value (including object keys and nested
 * arrays/objects) contains any well-formed inner edge token. Cycle-safe and non-recursive.
 */
export function valueContainsInnerEdgeToken(val: unknown): boolean {
  if (typeof val === "string") {
    return containsInnerEdgeTokenString(val);
  }
  if (val === null || typeof val !== "object") {
    return false;
  }

  const seen = new WeakSet<object>();
  const stack: unknown[] = [val];

  while (stack.length > 0) {
    const cur = stack.pop();
    if (typeof cur === "string") {
      if (containsInnerEdgeTokenString(cur)) return true;
      continue;
    }
    if (cur === null || typeof cur !== "object") {
      continue;
    }
    if (seen.has(cur)) {
      continue;
    }
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (let i = cur.length - 1; i >= 0; i--) {
        stack.push(cur[i]);
      }
    } else {
      const record = cur as Record<string, unknown>;
      const keys = Object.keys(record);
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i]!;
        if (containsInnerEdgeTokenString(k)) return true;
        stack.push(record[k]);
      }
    }
  }

  return false;
}

/**
 * Rewrites non-overlapping UTF-8 byte spans in a log body string (for stage 3 body rewriting).
 */
export function rewriteBodySpans(
  body: string,
  replacements: readonly { readonly span: ByteSpan; readonly replacement: string }[],
): string {
  if (replacements.length === 0) return body;
  const bodyBytes = encodeUtf8(body);
  const sorted = [...replacements].sort((a, b) => a.span.start - b.span.start);

  const chunks: Uint8Array[] = [];
  let cursor = 0;
  let totalLen = 0;

  for (const item of sorted) {
    if (item.span.start < cursor || item.span.end < item.span.start || item.span.end > bodyBytes.length) {
      throw new RangeError(
        `Invalid or overlapping byte span [${item.span.start}, ${item.span.end}) for body of length ${bodyBytes.length}`,
      );
    }
    if (item.span.start > cursor) {
      const slice = bodyBytes.subarray(cursor, item.span.start);
      chunks.push(slice);
      totalLen += slice.length;
    }
    const repBytes = encodeUtf8(item.replacement);
    chunks.push(repBytes);
    totalLen += repBytes.length;
    cursor = item.span.end;
  }

  if (cursor < bodyBytes.length) {
    const tail = bodyBytes.subarray(cursor);
    chunks.push(tail);
    totalLen += tail.length;
  }

  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return decodeUtf8(out);
}
