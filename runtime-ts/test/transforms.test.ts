import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeHostedPseudonymTag,
  encodeUtf8,
  evaluateFieldValue,
  float64ToHex,
  hmacSha256,
  maskIpPrefix,
  parseTimeValue,
  sha256,
  toLowerHex,
  type ParserField,
} from "../src/index.js";

function field(overrides: Partial<ParserField> & Pick<ParserField, "type">): ParserField {
  return {
    id: "fld_01TEST01",
    name: "f",
    from: { hole: "h" },
    semantic: "unknown",
    ...overrides,
  };
}

describe("pure-TS SHA-256 and HMAC-SHA256", () => {
  it("agrees bit-for-bit with node:crypto across empty, short, block-boundary, and long inputs", () => {
    const messages = [
      "",
      "abc",
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(64),
      "a".repeat(129),
      "🚀 UTF-8 café\u0301",
    ];
    for (const msg of messages) {
      const ours = toLowerHex(sha256(encodeUtf8(msg)));
      const node = crypto.createHash("sha256").update(msg, "utf8").digest("hex");
      expect(ours).toBe(node);
    }

    const keys = ["short", "k".repeat(64), "k".repeat(100)];
    for (const k of keys) {
      for (const msg of messages) {
        const ours = toLowerHex(hmacSha256(encodeUtf8(k), encodeUtf8(msg)));
        const node = crypto.createHmac("sha256", k).update(msg, "utf8").digest("hex");
        expect(ours).toBe(node);
      }
    }

    // Verify two-key hosted tag against node:crypto directly
    const inner = crypto.createHmac("sha256", "edge").update("alice@example.com", "utf8").digest();
    const outer = crypto.createHmac("sha256", "server").update(inner).digest("hex").slice(0, 16);
    expect(computeHostedPseudonymTag("edge", "server", "alice@example.com")).toBe(outer);
  });
});

describe("declarative transforms (all 9 ops) and typed conversion", () => {
  it("scale performs exactly one IEEE 754 binary64 operation (1999 / 100 != 1999 * 0.01)", () => {
    const out = evaluateFieldValue(
      "1999",
      field({ type: "float", transforms: [{ op: "scale", div: 100 }] }),
      {},
    );
    expect(out.status).toBe("ok");
    if (out.status === "ok") {
      expect(out.value).toBe(19.99);
      expect(float64ToHex(out.value as number)).toBe("4033fd70a3d70a3d");
      expect(float64ToHex(1999 * 0.01)).toBe("4033fd70a3d70a3e");
      expect(float64ToHex(out.value as number)).not.toBe(float64ToHex(1999 * 0.01));
    }

    // Rejects fractional, zero, or both mul+div
    expect(
      evaluateFieldValue(
        "10",
        field({ type: "float", transforms: [{ op: "scale", mul: 0.5 }] }),
        {},
      ),
    ).toMatchObject({ status: "error", code: "INVALID_TRANSFORM" });

    expect(
      evaluateFieldValue(
        "10",
        field({ type: "float", transforms: [{ op: "scale", div: 0 }] }),
        {},
      ),
    ).toMatchObject({ status: "error", code: "INVALID_TRANSFORM" });

    expect(
      evaluateFieldValue(
        "10",
        field({ type: "float", transforms: [{ op: "scale", mul: 2, div: 3 }] }),
        {},
      ),
    ).toMatchObject({ status: "error", code: "INVALID_TRANSFORM" });
  });

  it("unit converts time units, SI/IEC byte units, and rejects cross-dimension", () => {
    expect(
      evaluateFieldValue(
        "0.145",
        field({ type: "float", transforms: [{ op: "unit", from: "s", to: "ms" }] }),
        {},
      ),
    ).toEqual({ status: "ok", value: 145 });

    expect(
      evaluateFieldValue(
        "4",
        field({ type: "int", transforms: [{ op: "unit", from: "KiB", to: "B" }] }),
        {},
      ),
    ).toEqual({ status: "ok", value: 4096, int64: 4096n });

    // Single IEEE 754 division for ms -> s
    const sec = evaluateFieldValue(
      "1999",
      field({ type: "float", transforms: [{ op: "unit", from: "ms", to: "s" }] }),
      {},
    );
    expect(sec.status).toBe("ok");
    if (sec.status === "ok") {
      expect(float64ToHex(sec.value as number)).toBe(float64ToHex(1999 / 1000));
    }

    // Cross SI <-> IEC: 1000 KiB -> KB = 1024 KB
    expect(
      evaluateFieldValue(
        "1000",
        field({ type: "float", transforms: [{ op: "unit", from: "KiB", to: "KB" }] }),
        {},
      ),
    ).toEqual({ status: "ok", value: 1024 });

    // Cross-dimension fails cleanly
    expect(
      evaluateFieldValue(
        "10",
        field({ type: "float", transforms: [{ op: "unit", from: "s", to: "B" }] }),
        {},
      ),
    ).toMatchObject({ status: "error", code: "INVALID_UNIT_CONVERSION" });
  });

  it("parse_time handles all 10 formats into exact integer milliseconds", () => {
    expect(parseTimeValue("2026-11-26T14:00:00Z", "iso8601")).toBe(1795701600000n);
    expect(parseTimeValue("2026-11-26T16:00:00+02:00", "rfc3339")).toBe(1795701600000n);
    expect(parseTimeValue("2026-11-26T14:00:00.123999Z", "iso8601")).toBe(1795701600123n);
    expect(parseTimeValue("2026-11-26T14:00:00.5Z", "iso8601")).toBe(1795701600500n);
    expect(parseTimeValue("26/Nov/2026:14:00:00 +0000", "apache")).toBe(1795701600000n);
    expect(parseTimeValue("Thu, 26 Nov 2026 14:00:00 GMT", "rfc2822")).toBe(1795701600000n);
    expect(parseTimeValue("Nov 26 14:00:00", "syslog", 2026)).toBe(1795701600000n);
    expect(parseTimeValue("Nov  5 00:00:00", "syslog", 2026)).toBe(
      BigInt(Date.UTC(2026, 10, 5, 0, 0, 0)),
    );
    expect(parseTimeValue("1795701600", "unix_s")).toBe(1795701600000n);
    expect(parseTimeValue("1795701600.25", "unix_s")).toBe(1795701600250n);
    expect(parseTimeValue("1795701600123", "unix_ms")).toBe(1795701600123n);
    expect(parseTimeValue("1795701600123999", "unix_us")).toBe(1795701600123n);
    expect(parseTimeValue("1795701600123999999", "unix_ns")).toBe(1795701600123n);
    // Strict rfc3339 rejects missing timezone
    expect(parseTimeValue("2026-11-26T14:00:00", "rfc3339")).toBe(null);
  });

  it("cast, lower, enum_map, mask, drop, and fail-closed hash work as specified", () => {
    expect(
      evaluateFieldValue("1", field({ type: "bool", transforms: [{ op: "cast", to: "bool" }] }), {}),
    ).toEqual({ status: "ok", value: true });

    expect(
      evaluateFieldValue("0", field({ type: "bool", transforms: [{ op: "cast", to: "bool" }] }), {}),
    ).toEqual({ status: "ok", value: false });

    expect(
      evaluateFieldValue(
        "V2",
        field({
          type: "enum",
          transforms: [
            { op: "lower" },
            { op: "enum_map", map: { v1: "1", v2: "2" }, default: "unknown" },
          ],
        }),
        {},
      ),
    ).toEqual({ status: "ok", value: "2" });

    // enum_map without default errors on unmapped value
    expect(
      evaluateFieldValue(
        "v9",
        field({
          type: "enum",
          transforms: [{ op: "enum_map", map: { v1: "1" } }],
        }),
        {},
      ),
    ).toMatchObject({ status: "error", code: "ENUM_UNMAPPED" });

    // hash fails closed when keys are missing
    expect(
      evaluateFieldValue(
        "alice@example.com",
        field({ type: "string", transforms: [{ op: "hash", kind: "email" }] }),
        {},
      ),
    ).toMatchObject({ status: "error", code: "MISSING_HASH_KEY" });

    // mask token mode
    expect(
      evaluateFieldValue(
        "Alice Smith",
        field({ type: "string", transforms: [{ op: "mask", mode: "token", kind: "name" }] }),
        {},
      ),
    ).toEqual({ status: "redacted", token: "<name>" });

    // mask ip_prefix mode (/24 IPv4, /48 IPv6 RFC 5952)
    expect(maskIpPrefix("203.0.113.42")).toBe("203.0.113.0/24");
    expect(maskIpPrefix("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe("2001:db8:85a3::/48");
    expect(maskIpPrefix("::1")).toBe("::/48");
    expect(maskIpPrefix("fe80::1")).toBe("fe80::/48");
    expect(maskIpPrefix("not-an-ip")).toBe(null);

    expect(
      evaluateFieldValue(
        "not-an-ip",
        field({ type: "string", transforms: [{ op: "mask", mode: "ip_prefix" }] }),
        {},
      ),
    ).toMatchObject({ status: "error", code: "INVALID_IP" });

    // drop
    expect(
      evaluateFieldValue("secret", field({ type: "string", transforms: [{ op: "drop" }] }), {}),
    ).toEqual({ status: "dropped" });
  });
});
