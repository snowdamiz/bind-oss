import { describe, expect, it } from "vitest";
import {
  computeHostedPseudonymTag,
  computeInnerPseudonymBytes,
  parseRecord,
  rewriteBodySpans,
  toLowerHex,
  type HoleClass,
  type ParserSpec,
} from "../src/index.js";

describe("section 5 & 14 redaction tokens and span rewriting", () => {
  const allHoleClasses: readonly HoleClass[] = [
    "word",
    "int",
    "float",
    "uuid",
    "hex",
    "ip",
    "time",
    "quoted",
    "json",
    "until",
    "rest",
  ];

  it("matches mask tokens (<card>, <secret:jwt>) across every hole class and emits redacted null", () => {
    for (const holeClass of allHoleClasses) {
      const spec: ParserSpec = {
        spec_version: 1,
        template: "tpl_01REDACT01",
        event: "redact.mask",
        version: 1,
        status: "active",
        origin: "agent",
        source: { kind: "mined" },
        match: {
          kind: "text",
          segments:
            holeClass === "rest"
              ? [{ lit: "val=" }, { hole: "v", class: holeClass }]
              : [{ lit: "val=" }, { hole: "v", class: holeClass }, { lit: " ok" }],
        },
        fields: [
          {
            id: "fld_0001",
            name: "v",
            from: { hole: "v" },
            type: holeClass === "int" ? "int" : "string",
            semantic: "unknown",
          },
        ],
        tests: [{ line: "", expect: {} }],
      };

      for (const token of ["<card>", "<secret:jwt>", "<name>"]) {
        const line = holeClass === "rest" ? `val=${token}` : `val=${token} ok`;
        const res = parseRecord(spec, line);
        expect(res.matched, `token ${token} should match hole class ${holeClass}`).toBe(true);
        if (!res.matched) continue;
        expect(res.fields["v"]).toMatchObject({
          status: "redacted",
          value: null,
          token,
        });
        expect(res.spans["v"]).toEqual({ start: 4, end: 4 + token.length });
      }
    }
  });

  it("keeps pseudonym tokens in string fields and treats them as masks in non-string fields", () => {
    const spec: ParserSpec = {
      spec_version: 1,
      template: "tpl_01REDACT02",
      event: "redact.pseudo",
      version: 1,
      status: "active",
      origin: "agent",
      source: { kind: "mined" },
      match: {
        kind: "text",
        segments: [
          { lit: "email=" },
          { hole: "email", class: "word" },
          { lit: " amount=" },
          { hole: "amount", class: "int" },
        ],
      },
      fields: [
        {
          id: "fld_0001",
          name: "email",
          from: { hole: "email" },
          type: "string",
          semantic: "email",
          pii: "email",
          transforms: [{ op: "lower" }, { op: "hash", kind: "email" }],
        },
        {
          id: "fld_0002",
          name: "amount",
          from: { hole: "amount" },
          type: "int",
          semantic: "count",
        },
      ],
      tests: [{ line: "", expect: {} }],
    };

    const res = parseRecord(
      spec,
      "email=<email:9f2c41d07a3b55e1> amount=<email:9f2c41d07a3b55e1>",
      { hashKeys: { edgeKey: "edge-secret", serverKey: "server-secret" } },
    );
    expect(res.matched).toBe(true);
    if (!res.matched) return;

    // String field keeps existing pseudonym token without double-hashing
    expect(res.fields["email"]).toMatchObject({
      status: "ok",
      value: "<email:9f2c41d07a3b55e1>",
      pseudonymized: true,
    });

    // Non-string field treats pseudonym token as a mask
    expect(res.fields["amount"]).toMatchObject({
      status: "redacted",
      value: null,
      token: "<email:9f2c41d07a3b55e1>",
    });
  });

  it("upgrades edge inner pseudonym tokens (<email:~64hex>) identically to hosted two-key hash", () => {
    const edgeKey = "project-edge-key-01";
    const serverKey = "project-server-key-01";
    const rawEmail = "alice@example.com";

    const innerHex = toLowerHex(computeInnerPseudonymBytes(edgeKey, rawEmail));
    const expectedTag = computeHostedPseudonymTag(edgeKey, serverKey, rawEmail);

    const spec: ParserSpec = {
      spec_version: 1,
      template: "tpl_01REDACT03",
      event: "redact.upgrade",
      version: 1,
      status: "active",
      origin: "agent",
      source: { kind: "mined" },
      match: {
        kind: "text",
        segments: [{ lit: "u=" }, { hole: "u", class: "word" }],
      },
      fields: [
        {
          id: "fld_0001",
          name: "u",
          from: { hole: "u" },
          type: "string",
          semantic: "email",
          transforms: [{ op: "hash", kind: "email" }],
        },
      ],
      tests: [{ line: "", expect: {} }],
    };

    // Edge mode (k_edge only) emits inner token
    const edgeRes = parseRecord(spec, `u=${rawEmail}`, { hashKeys: { edgeKey } });
    expect(edgeRes.matched).toBe(true);
    if (!edgeRes.matched) return;
    expect(edgeRes.fields["u"]!.value).toBe(`<email:~${innerHex}>`);

    // Gateway upgrade (inner token + k_server) yields exact hosted tag
    const upgraded = parseRecord(spec, `u=<email:~${innerHex}>`, {
      hashKeys: { serverKey },
    });
    expect(upgraded.matched).toBe(true);
    if (!upgraded.matched) return;
    expect(upgraded.fields["u"]!.value).toBe(`<email:${expectedTag}>`);

    // Hosted path (raw + k_edge + k_server) yields identical tag
    const hosted = parseRecord(spec, `u=${rawEmail}`, {
      hashKeys: { edgeKey, serverKey },
    });
    expect(hosted.matched).toBe(true);
    if (!hosted.matched) return;
    expect(hosted.fields["u"]!.value).toBe(`<email:${expectedTag}>`);
  });

  it("does not misclassify arbitrary HTML tags like <div> as redaction tokens", () => {
    const intSpec: ParserSpec = {
      spec_version: 1,
      template: "tpl_01HTML01",
      event: "html.test",
      version: 1,
      status: "active",
      origin: "user",
      source: { kind: "mined" },
      match: { kind: "text", segments: [{ hole: "n", class: "int" }] },
      fields: [{ id: "fld_0001", name: "n", from: { hole: "n" }, type: "int", semantic: "count" }],
      tests: [{ line: "", expect: {} }],
    };
    expect(parseRecord(intSpec, "<div>").matched).toBe(false);

    const wordSpec: ParserSpec = {
      ...intSpec,
      match: { kind: "text", segments: [{ hole: "w", class: "word" }] },
      fields: [{ id: "fld_0001", name: "w", from: { hole: "w" }, type: "string", semantic: "text" }],
    };
    const res = parseRecord(wordSpec, "<div>");
    expect(res.matched).toBe(true);
    if (res.matched) {
      expect(res.fields["w"]).toMatchObject({ status: "ok", value: "<div>" });
    }
  });

  it("rewrites log body UTF-8 byte spans cleanly with multi-byte Unicode prefixes", () => {
    const line = '🚀 user=Alice@Example.COM name="Alice Smith" ok';
    const spec: ParserSpec = {
      spec_version: 1,
      template: "tpl_01REWRITE01",
      event: "body.rewrite",
      version: 1,
      status: "active",
      origin: "agent",
      source: { kind: "mined" },
      match: {
        kind: "text",
        segments: [
          { lit: "🚀 user=" },
          { hole: "email", class: "word" },
          { lit: " name=" },
          { hole: "name", class: "quoted" },
          { lit: " ok" },
        ],
      },
      fields: [],
      tests: [{ line: "", expect: {} }],
    };

    const res = parseRecord(spec, line);
    expect(res.matched).toBe(true);
    if (!res.matched) return;

    const rewritten = rewriteBodySpans(line, [
      { span: res.spans["email"]!, replacement: "<email:0123456789abcdef>" },
      { span: res.spans["name"]!, replacement: "<name>" },
    ]);
    expect(rewritten).toBe("🚀 user=<email:0123456789abcdef> name=<name> ok");
  });
});
