/**
 * Hand-written UTF-8 byte scanners for IPv4 and IPv6 addresses, RFC 5952 IPv6
 * canonicalization, and section 14 IP prefix masking (/24 IPv4, /48 IPv6).
 * Zero RegExp, strictly linear time.
 */

import { encodeUtf8, hexValue, isAsciiDigit, isAsciiHex } from "./utf8.js";

export interface ScannedIpv4 {
  readonly version: 4;
  readonly end: number;
  readonly octets: readonly [number, number, number, number];
}

export interface ScannedIpv6 {
  readonly version: 6;
  readonly end: number;
  readonly groups: Uint16Array;
}

export type ScannedIp = ScannedIpv4 | ScannedIpv6;

/**
 * Scans a strict IPv4 address (`a.b.c.d`, each octet 0..255 with no leading zeros)
 * starting at `start` within `bytes[start..end)`.
 */
export function scanIpv4(
  bytes: Uint8Array,
  start: number,
  end: number = bytes.length,
): ScannedIpv4 | null {
  let pos = start;
  const octets: [number, number, number, number] = [0, 0, 0, 0];

  for (let part = 0; part < 4; part++) {
    if (part > 0) {
      if (pos >= end || bytes[pos] !== 0x2e /* '.' */) {
        return null;
      }
      pos++;
    }
    if (pos >= end || !isAsciiDigit(bytes[pos]!)) {
      return null;
    }

    const firstDigit = bytes[pos]! - 0x30;
    let value = firstDigit;
    let digits = 1;
    pos++;

    while (pos < end && isAsciiDigit(bytes[pos]!) && digits < 3) {
      // Reject leading zeros such as "01" or "00"
      if (firstDigit === 0) {
        return null;
      }
      value = value * 10 + (bytes[pos]! - 0x30);
      digits++;
      pos++;
    }

    // Reject 4th consecutive digit on the final octet (e.g. 1.2.3.4567)
    if (pos < end && isAsciiDigit(bytes[pos]!)) {
      return null;
    }
    if (value > 255) {
      return null;
    }
    octets[part] = value;
  }

  return { version: 4, end: pos, octets };
}

/**
 * Scans a strict RFC 4291 / RFC 5952 IPv6 address (including `::` compression and
 * IPv4-embedded suffixes such as `::ffff:192.0.2.128`) starting at `start`.
 */
export function scanIpv6(
  bytes: Uint8Array,
  start: number,
  end: number = bytes.length,
): ScannedIpv6 | null {
  let pos = start;
  if (pos >= end) return null;

  const head: number[] = [];
  const tail: number[] = [];
  let compressed = false;
  let colonCount = 0;

  // Check for leading `::`
  if (bytes[pos] === 0x3a /* ':' */) {
    if (pos + 1 >= end || bytes[pos + 1] !== 0x3a) {
      return null;
    }
    compressed = true;
    colonCount += 2;
    pos += 2;
  }

  while (pos < end) {
    const totalGroups = head.length + tail.length;
    if (totalGroups >= 8) {
      break;
    }

    // Check if an embedded IPv4 address starts here (requires at least 2 group slots)
    if (totalGroups <= 6 && isAsciiDigit(bytes[pos]!)) {
      const ipv4 = scanIpv4(bytes, pos, end);
      if (ipv4 !== null) {
        const gHi = (ipv4.octets[0] << 8) | ipv4.octets[1];
        const gLo = (ipv4.octets[2] << 8) | ipv4.octets[3];
        const target = compressed ? tail : head;
        target.push(gHi, gLo);
        pos = ipv4.end;
        break;
      }
    }

    // Parse 1..4 hex digits for a 16-bit group
    if (!isAsciiHex(bytes[pos]!)) {
      break;
    }

    const groupStart = pos;
    let groupVal = 0;
    let hexLen = 0;
    while (pos < end && isAsciiHex(bytes[pos]!) && hexLen < 4) {
      groupVal = (groupVal << 4) | hexValue(bytes[pos]!);
      hexLen++;
      pos++;
    }

    // If a 5th hex digit immediately follows, this token is not a valid 16-bit group
    if (pos < end && isAsciiHex(bytes[pos]!)) {
      // Roll back if we hadn't finished anything valid
      pos = groupStart;
      break;
    }

    const target = compressed ? tail : head;
    target.push(groupVal);

    // Check for separator `:` or `::`
    if (pos < end && bytes[pos] === 0x3a /* ':' */) {
      if (pos + 1 < end && bytes[pos + 1] === 0x3a /* ':' */) {
        if (compressed) {
          // Second `::` is invalid in IPv6; do not consume it
          break;
        }
        // Reject `:::`
        if (pos + 2 < end && bytes[pos + 2] === 0x3a) {
          return null;
        }
        compressed = true;
        colonCount += 2;
        pos += 2;
        continue;
      }

      // Single `:` is only consumed if followed by a valid next hex group or IPv4 suffix
      if (head.length + tail.length >= 8) {
        break;
      }
      if (pos + 1 < end && isAsciiHex(bytes[pos + 1]!)) {
        // Peek that the next token isn't >4 hex digits unless it's IPv4
        let peek = pos + 1;
        let peekHex = 0;
        while (peek < end && isAsciiHex(bytes[peek]!) && peekHex < 5) {
          peekHex++;
          peek++;
        }
        if (peekHex <= 4) {
          colonCount++;
          pos++;
          continue;
        }
      }
      // Trailing single `:` does not belong to the IPv6 address (e.g., delimiter before literal)
      break;
    }

    break;
  }

  // Must contain at least two colons (valid IPv6 always has >= 2 colons)
  if (colonCount < 2) {
    return null;
  }

  const total = head.length + tail.length;
  if (compressed) {
    // `::` must elide at least 1 group (total <= 7)
    if (total > 7) {
      return null;
    }
  } else if (total !== 8) {
    return null;
  }

  // Reject immediately trailing colon (e.g. `2001:db8:::` or `2001:db8::1::2`)
  if (
    pos + 1 < end &&
    bytes[pos] === 0x3a &&
    bytes[pos + 1] === 0x3a
  ) {
    return null;
  }

  const groups = new Uint16Array(8);
  for (let i = 0; i < head.length; i++) {
    groups[i] = head[i]!;
  }
  const zeroCount = 8 - total;
  for (let i = 0; i < tail.length; i++) {
    groups[head.length + zeroCount + i] = tail[i]!;
  }

  return { version: 6, end: pos, groups };
}

/**
 * Scans either an IPv4 or IPv6 address starting at `start`.
 * Tries IPv4 first (since IPv4 starts with digits and a dot), then IPv6.
 */
export function scanIp(
  bytes: Uint8Array,
  start: number,
  end: number = bytes.length,
): ScannedIp | null {
  const v4 = scanIpv4(bytes, start, end);
  if (v4 !== null) {
    return v4;
  }
  return scanIpv6(bytes, start, end);
}

/**
 * Formats 8 16-bit IPv6 groups in canonical RFC 5952 compressed lowercase form.
 */
export function formatIpv6Canonical(groups: Uint16Array): string {
  // Find longest run of consecutive 0 groups with length >= 2 (leftmost tie-break)
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;

  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (curStart === -1) {
        curStart = i;
        curLen = 1;
      } else {
        curLen++;
      }
      if (curLen > bestLen) {
        bestStart = curStart;
        bestLen = curLen;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }

  if (bestLen < 2) {
    bestStart = -1;
    bestLen = 0;
  }

  const parts: string[] = [];
  let i = 0;
  while (i < 8) {
    if (i === bestStart) {
      parts.push("");
      if (i === 0) parts.push("");
      i += bestLen;
      if (i === 8) parts.push("");
    } else {
      parts.push(groups[i]!.toString(16));
      i++;
    }
  }
  return parts.join(":");
}

/**
 * Masks an IPv4 address to `/24` (`a.b.c.0/24`) or an IPv6 address to `/48`
 * (canonical RFC 5952 first 3 groups + `::/48`). Returns null on invalid IP.
 */
export function maskIpPrefix(ipStr: string): string | null {
  const bytes = encodeUtf8(ipStr);
  const scanned = scanIp(bytes, 0, bytes.length);
  if (scanned === null || scanned.end !== bytes.length) {
    return null;
  }
  if (scanned.version === 4) {
    return `${scanned.octets[0]}.${scanned.octets[1]}.${scanned.octets[2]}.0/24`;
  }
  const masked = new Uint16Array(8);
  masked[0] = scanned.groups[0]!;
  masked[1] = scanned.groups[1]!;
  masked[2] = scanned.groups[2]!;
  return `${formatIpv6Canonical(masked)}/48`;
}
