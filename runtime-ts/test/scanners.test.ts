import { describe, expect, it } from "vitest";
import {
  decodeUtf8,
  encodeUtf8,
  matchText,
  parseRecord,
  toCanonicalResult,
  type ParserSpec,
  type TextSegment,
} from "../src/index.js";

function makeTextSpec(
  segments: readonly TextSegment[],
  fields: ParserSpec["fields"] = [],
): ParserSpec {
  return {
    spec_version: 1,
    template: "tpl_01TESTSCAN01",
    event: "test.scan",
    version: 1,
    status: "active",
    origin: "user",
    source: { kind: "mined" },
    match: { kind: "text", segments },
    fields,
    tests: [{ line: "", expect: {} }],
  };
}

describe("hand-written UTF-8 byte hole scanners", () => {
  describe("word & UTF-8 whitespace semantics", () => {
    it("matches non-space runs and records exact UTF-8 byte bounds with emoji and combining marks", () => {
      // U+00A0 (NBSP) and U+3000 (ideographic space) are NOT ASCII spaces per §17/RE2
      const line = "prefix 🚀 user=café\u0301\u00a0name\u3000ok end";
      const m = matchText(
        {
          kind: "text",
          segments: [
            { lit: "prefix 🚀 user=" },
            { hole: "u", class: "word" },
            { lit: " end" },
          ],
        },
        line,
      );
      expect(m.matched).toBe(true);
      if (!m.matched) return;
      const cap = m.holes["u"]!;
      expect(cap.text).toBe("café\u0301\u00a0name\u3000ok");

      // Verify byte bounds against raw UTF-8 buffer
      const utf8 = encodeUtf8(line);
      expect(decodeUtf8(utf8, cap.span.start, cap.span.end)).toBe(cap.raw);
      expect(cap.span.start).toBe(encodeUtf8("prefix 🚀 user=").length);
      expect(cap.span.end).toBe(utf8.length - encodeUtf8(" end").length);
    });

    it("stops word on all ASCII whitespace chars (space, tab, LF, FF, CR)", () => {
      for (const ws of [" ", "\t", "\n", "\f", "\r"]) {
        const m = matchText(
          {
            kind: "text",
            segments: [
              { hole: "a", class: "word" },
              { lit: ws },
              { hole: "b", class: "word" },
            ],
          },
          `hello${ws}world`,
        );
        expect(m.matched).toBe(true);
        if (m.matched) {
          expect(m.holes["a"]!.text).toBe("hello");
          expect(m.holes["b"]!.text).toBe("world");
        }
      }
    });

    it("handles word followed by non-space-prefixed literal (including space inside literal)", () => {
      const m = matchText(
        {
          kind: "text",
          segments: [
            { lit: "user=" },
            { hole: "u", class: "word" },
            { lit: ", status=" },
            { hole: "s", class: "int" },
          ],
        },
        "user=alice, status=200",
      );
      expect(m.matched).toBe(true);
      if (m.matched) {
        expect(m.holes["u"]!.text).toBe("alice");
        expect(m.holes["s"]!.text).toBe("200");
      }

      // Word before final non-space literal containing itself
      const m2 = matchText(
        {
          kind: "text",
          segments: [
            { lit: "[" },
            { hole: "tag", class: "word" },
            { lit: "]" },
          ],
        },
        "[a]b]",
      );
      expect(m2.matched).toBe(true);
      if (m2.matched) {
        expect(m2.holes["tag"]!.text).toBe("a]b");
      }

      // Word before final literal containing an embedded space
      const m3 = matchText(
        {
          kind: "text",
          segments: [{ hole: "name", class: "word" }, { lit: ", done" }],
        },
        "alice, done",
      );
      expect(m3.matched).toBe(true);
      if (m3.matched) {
        expect(m3.holes["name"]!.text).toBe("alice");
      }
      expect(
        matchText(
          {
            kind: "text",
            segments: [{ hole: "name", class: "word" }, { lit: ", done" }],
          },
          "alice smith, done",
        ).matched,
      ).toBe(false);

      // Empty word is rejected
      const empty = matchText(
        {
          kind: "text",
          segments: [
            { lit: "user=" },
            { hole: "u", class: "word" },
            { lit: " end" },
          ],
        },
        "user= end",
      );
      expect(empty.matched).toBe(false);
    });
  });

  describe("int & Int64 bounds", () => {
    it("matches signed integers including Int64 min/max and flags overflow at field conversion", () => {
      const spec = makeTextSpec(
        [{ lit: "n=" }, { hole: "n", class: "int" }],
        [{ id: "fld_0001", name: "n", from: { hole: "n" }, type: "int", semantic: "count" }],
      );

      for (const raw of ["0", "-0", "+42", "-9223372036854775808", "9223372036854775807"]) {
        const res = parseRecord(spec, `n=${raw}`);
        expect(res.matched).toBe(true);
        if (!res.matched) continue;
        expect(res.fields["n"]!.status).toBe("ok");
        const canon = toCanonicalResult("c", res);
        expect(canon.matched).toBe(true);
        if (canon.matched) {
          expect(canon.fields["n"]).toEqual({
            status: "ok",
            type: "int",
            value: BigInt(raw).toString(10),
          });
        }
      }

      // Overflow beyond Int64: lexer matches digits, typed field reports INT64_OVERFLOW
      const over = parseRecord(spec, "n=9223372036854775808");
      expect(over.matched).toBe(true);
      if (over.matched) {
        expect(over.fields["n"]!.status).toBe("error");
        if (over.fields["n"]!.status === "error") {
          expect(over.fields["n"]!.code).toBe("INT64_OVERFLOW");
        }
      }

      // Decimal is rejected by full-line int match
      expect(parseRecord(spec, "n=12.34").matched).toBe(false);
      expect(parseRecord(spec, "n=+").matched).toBe(false);
    });
  });

  describe("float", () => {
    it("matches signed decimals, leading-dot floats, exponents, and stops before non-exponent e", () => {
      const spec = makeTextSpec(
        [
          { lit: "a=" },
          { hole: "a", class: "float" },
          { lit: " b=" },
          { hole: "b", class: "float" },
          { lit: "error" },
        ],
        [
          { id: "fld_0001", name: "a", from: { hole: "a" }, type: "float", semantic: "ratio" },
          { id: "fld_0002", name: "b", from: { hole: "b" }, type: "float", semantic: "ratio" },
        ],
      );

      const res = parseRecord(spec, "a=-.25e+2 b=10error");
      expect(res.matched).toBe(true);
      if (res.matched) {
        expect(res.fields["a"]!.value).toBe(-25);
        expect(res.fields["b"]!.value).toBe(10);
      }

      // Does not eat trailing sentence period
      const dot = matchText(
        { kind: "text", segments: [{ hole: "x", class: "float" }, { lit: "." }] },
        "12.",
      );
      expect(dot.matched).toBe(true);
      if (dot.matched) expect(dot.holes["x"]!.text).toBe("12");

      // Preserves IEEE 754 -0.0 bit pattern
      const negZero = parseRecord(
        makeTextSpec(
          [{ hole: "z", class: "float" }],
          [{ id: "fld_0001", name: "z", from: { hole: "z" }, type: "float", semantic: "ratio" }],
        ),
        "-0.0",
      );
      const canon = toCanonicalResult("nz", negZero);
      expect(canon.matched).toBe(true);
      if (canon.matched) {
        expect(canon.fields["z"]).toEqual({
          status: "ok",
          type: "float",
          value_hex: "8000000000000000",
        });
      }
    });
  });

  describe("uuid & hex", () => {
    it("matches standard 36-byte UUID and rejects malformed ones", () => {
      const m = matchText(
        { kind: "text", segments: [{ lit: "id=" }, { hole: "u", class: "uuid" }] },
        "id=550E8400-e29b-41d4-a716-446655440000",
      );
      expect(m.matched).toBe(true);
      if (m.matched) expect(m.holes["u"]!.span).toEqual({ start: 3, end: 39 });

      expect(
        matchText(
          { kind: "text", segments: [{ hole: "u", class: "uuid" }] },
          "550e8400-e29b-41d4-a716-44665544000g",
        ).matched,
      ).toBe(false);
    });

    it("matches hex with or without 0x prefix without swallowing non-hex x", () => {
      const m1 = matchText(
        {
          kind: "text",
          segments: [
            { hole: "h1", class: "hex" },
            { lit: " " },
            { hole: "h2", class: "hex" },
            { lit: "xyz" },
          ],
        },
        "0xDeadBeef 0xyz",
      );
      expect(m1.matched).toBe(true);
      if (m1.matched) {
        expect(m1.holes["h1"]!.text).toBe("0xDeadBeef");
        expect(m1.holes["h2"]!.text).toBe("0");
      }
    });
  });

  describe("ip", () => {
    it("matches strict IPv4 and IPv6 forms and rejects invalid addresses", () => {
      const validIps = [
        "0.0.0.0",
        "203.0.113.42",
        "255.255.255.255",
        "::",
        "::1",
        "fe80::",
        "2001:db8::1",
        "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
        "::ffff:192.0.2.128",
        "2001:db8::192.0.2.1",
      ];
      for (const ip of validIps) {
        const m = matchText({ kind: "text", segments: [{ hole: "ip", class: "ip" }] }, ip);
        expect(m.matched, `expected IP "${ip}" to match`).toBe(true);
      }

      const invalidIps = [
        "256.0.0.1",
        "01.2.3.4",
        "1.2.3",
        "1.2.3.4567",
        "12:34",
        "2001:db8::1::2",
        "2001:db8:::1",
        "2001:db8:1:2:3:4:5:6:7",
      ];
      for (const ip of invalidIps) {
        const m = matchText({ kind: "text", segments: [{ hole: "ip", class: "ip" }] }, ip);
        expect(m.matched, `expected invalid IP "${ip}" not to match`).toBe(false);
      }

      // IPv4 followed immediately by :port
      const withPort = matchText(
        {
          kind: "text",
          segments: [
            { hole: "ip", class: "ip" },
            { lit: ":" },
            { hole: "port", class: "int" },
          ],
        },
        "203.0.113.42:8080",
      );
      expect(withPort.matched).toBe(true);
      if (withPort.matched) {
        expect(withPort.holes["ip"]!.text).toBe("203.0.113.42");
        expect(withPort.holes["port"]!.text).toBe("8080");
      }
    });
  });

  describe("time", () => {
    it("matches ISO 8601, Apache CLF, RFC 3164 Syslog, and RFC 2822 timestamps", () => {
      const samples = [
        "2026-11-26T14:00:00Z",
        "2026-11-26T14:00:00.123456+02:00",
        "2026-11-26 14:00:00-0500",
        "26/Nov/2026:14:00:00 +0000",
        "Nov  5 14:00:00",
        "Nov 26 14:00:00.500",
        "Thu, 26 Nov 2026 14:00:00 GMT",
      ];
      for (const ts of samples) {
        const m = matchText(
          { kind: "text", segments: [{ lit: "[" }, { hole: "t", class: "time" }, { lit: "]" }] },
          `[${ts}]`,
        );
        expect(m.matched, `expected time "${ts}" to match`).toBe(true);
        if (m.matched) expect(m.holes["t"]!.text).toBe(ts);
      }

      // Non-leap year Feb 29 rejected, leap year accepted
      expect(
        matchText({ kind: "text", segments: [{ hole: "t", class: "time" }] }, "2026-02-29T00:00:00Z")
          .matched,
      ).toBe(false);
      expect(
        matchText({ kind: "text", segments: [{ hole: "t", class: "time" }] }, "2024-02-29T00:00:00Z")
          .matched,
      ).toBe(true);
    });
  });

  describe("quoted & json", () => {
    it("matches single and double quoted strings, unescapes text, and preserves quote byte bounds", () => {
      const line = 'msg="hello \\"world\\" \\n\\uD83D\\uDE80" alt=\'\'';
      const m = matchText(
        {
          kind: "text",
          segments: [
            { lit: "msg=" },
            { hole: "a", class: "quoted" },
            { lit: " alt=" },
            { hole: "b", class: "quoted" },
          ],
        },
        line,
      );
      expect(m.matched).toBe(true);
      if (!m.matched) return;
      expect(m.holes["a"]!.text).toBe('hello "world" \n🚀');
      expect(m.holes["a"]!.raw).toBe('"hello \\"world\\" \\n\\uD83D\\uDE80"');
      expect(m.holes["b"]!.text).toBe("");
      expect(m.holes["b"]!.raw).toBe("''");

      // Unterminated quote fails
      expect(
        matchText({ kind: "text", segments: [{ hole: "q", class: "quoted" }] }, '"unterminated')
          .matched,
      ).toBe(false);
    });

    it("matches balanced nested JSON objects/arrays and rejects invalid JSON", () => {
      const line = 'body={"a":[1,{"b":"\\"} }","ok":true,"n":null}]} tail';
      const m = matchText(
        {
          kind: "text",
          segments: [{ lit: "body=" }, { hole: "j", class: "json" }, { lit: " tail" }],
        },
        line,
      );
      expect(m.matched).toBe(true);
      if (m.matched) {
        expect(m.holes["j"]!.text).toBe('{"a":[1,{"b":"\\"} }","ok":true,"n":null}]}');
      }

      const invalid = [
        "{a:1}",
        '{"a":1,}',
        '{"a":01}',
        '{"a":1',
        "123",
        '"just a string"',
        '{"bad":"\u0001"}',
      ];
      for (const bad of invalid) {
        expect(
          matchText({ kind: "text", segments: [{ hole: "j", class: "json" }] }, bad).matched,
          `expected invalid json "${bad}" to fail`,
        ).toBe(false);
      }
    });
  });

  describe("until, rest & adjacent holes", () => {
    it("matches empty and multi-word until/rest and adjacent holes deterministically", () => {
      const m = matchText(
        {
          kind: "text",
          segments: [
            { lit: "a=" },
            { hole: "u1", class: "until" },
            { lit: " b=" },
            { hole: "u2", class: "until" },
            { lit: " c=" },
            { hole: "r", class: "rest" },
          ],
        },
        "a= b=hello world c=",
      );
      expect(m.matched).toBe(true);
      if (m.matched) {
        expect(m.holes["u1"]!.text).toBe("");
        expect(m.holes["u2"]!.text).toBe("hello world");
        expect(m.holes["r"]!.text).toBe("");
      }

      // Adjacent holes: int + word, quoted + json
      const adj = matchText(
        {
          kind: "text",
          segments: [
            { hole: "n", class: "int" },
            { hole: "unit", class: "word" },
            { lit: " " },
            { hole: "q", class: "quoted" },
            { hole: "j", class: "json" },
          ],
        },
        '212ms "hi"{"k":1}',
      );
      expect(adj.matched).toBe(true);
      if (adj.matched) {
        expect(adj.holes["n"]!.text).toBe("212");
        expect(adj.holes["unit"]!.text).toBe("ms");
        expect(adj.holes["q"]!.text).toBe("hi");
        expect(adj.holes["j"]!.text).toBe('{"k":1}');
      }
    });
  });
});
