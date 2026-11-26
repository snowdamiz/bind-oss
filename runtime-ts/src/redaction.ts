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

  if (i >= end || !KNOWN_MASK_TOKEN_KINDS.has(kind)) {
    return null;
  }

  // Form 1: `<kind>`
  if (bytes[i] === 0x3e /* '>' */) {
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

  // Form 2: `<kind:~<64 lowercase hex>>` (edge inner pseudonym token)
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
