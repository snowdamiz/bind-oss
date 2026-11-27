import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalizeJson,
  checkFieldExpectations,
  computeHostedPseudonymTag,
  computeInnerPseudonymBytes,
  jsonTextContainsInnerEdgeToken,
  parseFixturePayload,
  parseRecord,
  runVectorCases,
  stringifyVectorJson,
  toLowerHex,
  toVectorResult,
  type JsonValue,
  type ParserSpec,
} from "../src/index.js";

const RUNTIME_DIR = path.resolve(import.meta.dirname, "..");
const CLI_PATH = path.join(RUNTIME_DIR, "dist/cli.js");

function makeTextSpec(
  segments: Extract<ParserSpec["match"], { kind: "text" }>["segments"],
  fields: ParserSpec["fields"],
): ParserSpec {
  return {
    spec_version: 1,
    template: "tpl_01REVIEW01",
    event: "review.regression",
    version: 1,
    status: "active",
    origin: "agent",
    source: { kind: "mined" },
    match: { kind: "text", segments },
    fields,
    tests: [],
  };
}

describe("Node 20 review regressions: lexical JSON no-spill, rest->cast(json), word+literal boundary, standalone ParserSpec timestamps, and int precheck boundaries", () => {
  const edgeKey = "review-edge-key-v1";
  const serverKey = "review-server-key-v1";
  const rawEmail = "alice@example.com";
  const digest = toLowerHex(computeInnerPseudonymBytes(edgeKey, rawEmail));
  const customInner = `<user:~${digest}>`;
  const expectedTag = computeHostedPseudonymTag(edgeKey, serverKey, rawEmail);

  it("lexically detects decoded inner-edge tokens across duplicate JSON members even when raw JSON text could be returned", () => {
    const escapedEmail = `\\u003cemail:\\u007e${digest}\\u003e`;
    const escapedCustom = `\\u003cuser:\\u007e${digest}\\u003e`;
    const escapedColonCustom = `\\u003cuser\\u003a\\u007e${digest}\\u003e`;
    const escapedUpperHex = `\\u003Cuser:\\u007E${digest}\\u003E`;
    const literalBackslash = `\\\\u003cuser:\\\\u007e${digest}\\\\u003e`;
    const tripleBackslash = `\\\\\\u003cuser:\\u007e${digest}\\u003e`;

    // Direct lexical helper checks
    expect(jsonTextContainsInnerEdgeToken(`{"a":"${escapedEmail}","a":"safe"}`)).toBe(true);
    expect(jsonTextContainsInnerEdgeToken(`{"a":"safe","a":"${escapedCustom}"}`)).toBe(true);
    expect(
      jsonTextContainsInnerEdgeToken(`{"x":{"k":"${escapedColonCustom}","k":"ok"},"x":"clean"}`),
    ).toBe(true);
    expect(jsonTextContainsInnerEdgeToken(`{"a":"${escapedUpperHex}","a":"safe"}`)).toBe(true);
    expect(jsonTextContainsInnerEdgeToken(`{"a":"${tripleBackslash}","a":"safe"}`)).toBe(true);
    expect(jsonTextContainsInnerEdgeToken(`{"a":"${literalBackslash}","a":"safe"}`)).toBe(false);
    expect(
      jsonTextContainsInnerEdgeToken('{"a":"\\u003cuser:9f2c41d07a3b55e1\\u003e","a":"safe"}'),
    ).toBe(false);

    // json hole with type: "string" (raw JSON text would otherwise be returned verbatim)
    const jsonRawStringSpec = makeTextSpec(
      [{ lit: "j=" }, { hole: "j", class: "json" }],
      [{ id: "f1", name: "j", from: { hole: "j" }, type: "string", semantic: "text" }],
    );
    for (const rawJson of [
      `{"a":"${escapedEmail}","a":"safe"}`,
      `{"a":"${escapedCustom}","a":"safe"}`,
      `{"x":{"k":"${escapedColonCustom}","k":"ok"},"x":"clean"}`,
    ]) {
      const res = toVectorResult(parseRecord(jsonRawStringSpec, `j=${rawJson}`));
      expect(res).toEqual({
        matched: true,
        fields: { j: { status: "redacted", token: "<redacted>" } },
      });
      expect(JSON.stringify(res)).not.toContain(digest);
    }

    // json hole with type: "json" also redacts duplicate-member escaped inner-edge tokens
    const jsonTypedSpec = makeTextSpec(
      [{ lit: "j=" }, { hole: "j", class: "json" }],
      [{ id: "f1", name: "j", from: { hole: "j" }, type: "json", semantic: "unknown" }],
    );
    const dupTypedRes = toVectorResult(
      parseRecord(jsonTypedSpec, `j={"a":"${escapedCustom}","a":"safe"}`),
    );
    expect(dupTypedRes).toEqual({
      matched: true,
      fields: { j: { status: "redacted", token: "<redacted>" } },
    });
    expect(JSON.stringify(dupTypedRes)).not.toContain(digest);

    // Neutral controls: escaped backslashes and non-inner custom 16-hex stay intact
    const neutralRaw = `{"a":"${literalBackslash}","a":"safe"}`;
    expect(toVectorResult(parseRecord(jsonRawStringSpec, `j=${neutralRaw}`))).toEqual({
      matched: true,
      fields: { j: { status: "ok", type: "string", value: neutralRaw } },
    });
    const nonInnerRaw = '{"a":"\\u003cuser:9f2c41d07a3b55e1\\u003e","a":"safe"}';
    expect(toVectorResult(parseRecord(jsonRawStringSpec, `j=${nonInnerRaw}`))).toEqual({
      matched: true,
      fields: { j: { status: "ok", type: "string", value: nonInnerRaw } },
    });
  });

  it("blocks decoded inner-edge tokens in rest->cast(json), rest->json, and object path->cast(json)", () => {
    const escapedCustom = `\\u003cuser:\\u007e${digest}\\u003e`;

    const restCastJsonSpec = makeTextSpec(
      [{ lit: "r=" }, { hole: "r", class: "rest" }],
      [
        {
          id: "f1",
          name: "r",
          from: { hole: "r" },
          type: "json",
          semantic: "unknown",
          transforms: [{ op: "cast", to: "json" }],
        },
      ],
    );

    const restCastJsonToStrSpec = makeTextSpec(
      [{ lit: "r=" }, { hole: "r", class: "rest" }],
      [
        {
          id: "f1",
          name: "r",
          from: { hole: "r" },
          type: "string",
          semantic: "text",
          transforms: [
            { op: "cast", to: "json" },
            { op: "cast", to: "string" },
          ],
        },
      ],
    );

    const restDirectJsonSpec = makeTextSpec(
      [{ lit: "r=" }, { hole: "r", class: "rest" }],
      [{ id: "f1", name: "r", from: { hole: "r" }, type: "json", semantic: "unknown" }],
    );

    const payloads = [
      `{"a":"${escapedCustom}"}`,
      `{"a":"${escapedCustom}","a":"safe"}`,
      `"${escapedCustom}"`,
      `{"a":"${customInner}","a":"safe"}`,
    ];

    for (const spec of [restCastJsonSpec, restCastJsonToStrSpec, restDirectJsonSpec]) {
      for (const payload of payloads) {
        const res = toVectorResult(parseRecord(spec, `r=${payload}`));
        expect(res, `payload=${payload}`).toEqual({
          matched: true,
          fields: { r: { status: "redacted", token: "<redacted>" } },
        });
        expect(JSON.stringify(res)).not.toContain(digest);
      }
    }

    // Clean and non-inner custom control in rest->cast(json) still succeed
    expect(toVectorResult(parseRecord(restCastJsonSpec, 'r={"a":"safe"}'))).toEqual({
      matched: true,
      fields: { r: { status: "ok", type: "json", value: { a: "safe" } } },
    });
    expect(
      toVectorResult(
        parseRecord(restCastJsonSpec, 'r={"a":"\\u003cuser:9f2c41d07a3b55e1\\u003e"}'),
      ),
    ).toEqual({
      matched: true,
      fields: { r: { status: "ok", type: "json", value: { a: "<user:9f2c41d07a3b55e1>" } } },
    });

    // Structured object string -> cast(json) with duplicate member escape
    const objCastJsonSpec: ParserSpec = {
      spec_version: 1,
      template: "tpl_01OBJCASTJSON",
      event: "obj.cast_json",
      version: 1,
      status: "active",
      origin: "agent",
      source: { kind: "mined" },
      match: { kind: "object", shape: ["raw"] },
      fields: [
        {
          id: "f1",
          name: "raw",
          from: { path: "raw" },
          type: "json",
          semantic: "unknown",
          transforms: [{ op: "cast", to: "json" }],
        },
      ],
      tests: [],
    };
    const objCastRes = toVectorResult(
      parseRecord(objCastJsonSpec, {
        kind: "object",
        object: { raw: `{"a":"${escapedCustom}","a":"safe"}` },
      }),
    );
    expect(objCastRes).toEqual({
      matched: true,
      fields: { raw: { status: "redacted", token: "<redacted>" } },
    });
    expect(JSON.stringify(objCastRes)).not.toContain(digest);
  });

  it("preserves successful word+literal boundaries with custom inner-edge tokens", () => {
    const wordColonIntSpec = makeTextSpec(
      [{ lit: "u=" }, { hole: "u", class: "word" }, { lit: ":" }, { hole: "status", class: "int" }],
      [
        {
          id: "f1",
          name: "u",
          from: { hole: "u" },
          type: "string",
          semantic: "text",
          transforms: [{ op: "hash", kind: "user" }],
        },
        { id: "f2", name: "status", from: { hole: "status" }, type: "int", semantic: "status" },
      ],
    );

    // Hosted mode matches cleanly across ':' boundary, redacts u, and preserves sibling status
    const hostedRes = toVectorResult(
      parseRecord(wordColonIntSpec, `u=${customInner}:200`, {
        hashKeys: { edgeKey, serverKey },
      }),
    );
    expect(hostedRes).toEqual({
      matched: true,
      fields: {
        u: { status: "redacted", token: "<redacted>" },
        status: { status: "ok", type: "int", value: "200" },
      },
    });
    expect(JSON.stringify(hostedRes)).not.toContain(digest);

    // Authorized gateway mode upgrades across ':' boundary cleanly
    expect(
      toVectorResult(
        parseRecord(wordColonIntSpec, `u=${customInner}:200`, {
          hashMode: "gateway",
          hashKeys: { serverKey },
        }),
      ),
    ).toEqual({
      matched: true,
      fields: {
        u: { status: "ok", type: "string", value: `<user:${expectedTag}>` },
        status: { status: "ok", type: "int", value: "200" },
      },
    });

    // Word followed by ':ok' literal
    const wordColonOkSpec = makeTextSpec(
      [{ lit: "u=" }, { hole: "u", class: "word" }, { lit: ":ok" }],
      [{ id: "f1", name: "u", from: { hole: "u" }, type: "string", semantic: "text" }],
    );
    expect(toVectorResult(parseRecord(wordColonOkSpec, `u=${customInner}:ok`))).toEqual({
      matched: true,
      fields: { u: { status: "redacted", token: "<redacted>" } },
    });

    // Non-inner custom angle form before ':' literal keeps ordinary leftmost-literal non-match behavior
    expect(toVectorResult(parseRecord(wordColonIntSpec, "u=<user:9f2c41d07a3b55e1>:200"))).toEqual({
      matched: false,
    });
  });

  it("enforces exact decimal/exponent timestamp comparison and fractional rejection in standalone ParserSpec tests[].expect", () => {
    const makeStandaloneSpecJson = (
      testsRawJson: string,
      testsBeforeFields = false,
    ): string => {
      const fieldsEntry = `"fields":[
        {"id":"f_ts","name":"ts","from":{"hole":"ts"},"type":"timestamp","semantic":"timestamp","transforms":[{"op":"parse_time","format":"unix_ms"}]},
        {"id":"f_lat","name":"lat","from":{"hole":"lat"},"type":"float","semantic":"duration"}
      ]`;
      const testsEntry = `"tests":${testsRawJson}`;
      return `{
        "spec_version":1,
        "template":"tpl_01SPEC_TS",
        "event":"spec.ts",
        "version":1,
        "status":"active",
        "origin":"agent",
        "source":{"kind":"mined"},
        "match":{"kind":"text","segments":[{"lit":"ts="},{"hole":"ts","class":"word"},{"lit":" lat="},{"hole":"lat","class":"float"}]},
        ${testsBeforeFields ? `${testsEntry},${fieldsEntry}` : `${fieldsEntry},${testsEntry}`}
      }`;
    };

    // Passing exact decimal/exponent representations (including tests declared before fields + sibling float 1.5)
    const okTestsRaw = `[
      {"line":"ts=9007199254740993 lat=1.5","expect":{"ts":9007199254740993,"lat":1.5}},
      {"line":"ts=9007199254740993 lat=1.5","expect":{"ts":9007199254740993.0,"lat":1.5}},
      {"line":"ts=9007199254740993 lat=1.5","expect":{"ts":9.007199254740993e15,"lat":1.5}},
      {"line":"ts=9007199254740993 lat=1.5","expect":{"ts":90071992547409930e-1,"lat":1.5}},
      {"line":"ts=9223372036854775807 lat=1.5","expect":{"ts":9.223372036854775807e18,"lat":1.5}},
      {"line":"ts=-9223372036854775808 lat=1.5","expect":{"ts":-9.223372036854775808e18,"lat":1.5}},
      {"line":"ts=0 lat=1.5","expect":{"ts":0e+999999999,"lat":1.5}}
    ]`;

    for (const testsBeforeFields of [false, true]) {
      const cases = parseFixturePayload(
        makeStandaloneSpecJson(okTestsRaw, testsBeforeFields),
        "standalone.json",
      );
      expect(cases).toHaveLength(7);
      const report = runVectorCases(cases);
      expect(report.failed, JSON.stringify(report.checks)).toBe(0);
      expect(report.passed).toBe(7);
    }

    // Failing probes: off-by-1, fractional near-2^53, sub-unit fractional, simple 1.5, and huge int
    const failProbes: readonly { id: string; line: string; tsRaw: string }[] = [
      { id: "off-by-1", line: "ts=9007199254740993 lat=1.5", tsRaw: "9007199254740992" },
      { id: "frac-half-even", line: "ts=9007199254740992 lat=1.5", tsRaw: "9007199254740992.5" },
      { id: "frac-exp-near-2p53", line: "ts=9007199254740992 lat=1.5", tsRaw: "9.0071992547409925e15" },
      { id: "frac-neg-exp", line: "ts=9007199254740992 lat=1.5", tsRaw: "90071992547409925e-1" },
      { id: "frac-sub-unit", line: "ts=0 lat=1.5", tsRaw: "1e-1000" },
      { id: "frac-small", line: "ts=1 lat=1.5", tsRaw: "1.5" },
      { id: "huge-int", line: "ts=9223372036854775807 lat=1.5", tsRaw: "1e+30" },
    ];

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-runtime-ts-standalone-ts-"));
    try {
      const okPath = path.join(tmpDir, "standalone-ok.json");
      fs.writeFileSync(okPath, makeStandaloneSpecJson(okTestsRaw, true), "utf8");
      execFileSync(
        process.execPath,
        [CLI_PATH, "--input", okPath, "--format", "vector-ndjson", "--check"],
        { encoding: "utf8", stdio: "pipe" },
      );

      for (const probe of failProbes) {
        const raw = makeStandaloneSpecJson(
          `[{"line":"${probe.line}","expect":{"ts":${probe.tsRaw},"lat":1.5}}]`,
        );
        const cases = parseFixturePayload(raw, `${probe.id}.json`);
        const report = runVectorCases(cases);
        expect(report.failed, `runner probe ${probe.id} (${probe.tsRaw})`).toBe(1);

        const failPath = path.join(tmpDir, `${probe.id}.json`);
        fs.writeFileSync(failPath, raw, "utf8");
        let exitCode = 0;
        try {
          execFileSync(
            process.execPath,
            [CLI_PATH, "--input", failPath, "--format", "vector-ndjson", "--check"],
            { encoding: "utf8", stdio: "pipe" },
          );
        } catch (err) {
          exitCode = (err as { status?: number }).status ?? -1;
        }
        expect(exitCode, `CLI probe ${probe.id} (${probe.tsRaw})`).toBe(1);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // Direct programmatic checkFieldExpectations supports bigint and rejects fractional numbers
    const tsSpec = makeTextSpec(
      [{ lit: "ts=" }, { hole: "ts", class: "word" }],
      [
        {
          id: "f_ts",
          name: "ts",
          from: { hole: "ts" },
          type: "timestamp",
          semantic: "timestamp",
          transforms: [{ op: "parse_time", format: "unix_ms" }],
        },
      ],
    );
    const parsedBig = parseRecord(tsSpec, "ts=9007199254740993");
    expect(checkFieldExpectations(tsSpec, parsedBig, { ts: 9007199254740993n })).toEqual([]);
    expect(checkFieldExpectations(tsSpec, parsedBig, { ts: 9007199254740992n })).toHaveLength(1);
    const parsedOne = parseRecord(tsSpec, "ts=1");
    expect(checkFieldExpectations(tsSpec, parsedOne, { ts: 1.5 })).toHaveLength(1);
  });

  it("preserves explicit first cast and string targets on overflowing int holes without regressing int->scale overflow", () => {
    const overInt64 = "9223372036854775808";

    const intAsStringSpec = makeTextSpec(
      [{ lit: "n=" }, { hole: "n", class: "int" }],
      [{ id: "f1", name: "n", from: { hole: "n" }, type: "string", semantic: "id" }],
    );
    expect(toVectorResult(parseRecord(intAsStringSpec, `n=${overInt64}`))).toEqual({
      matched: true,
      fields: { n: { status: "ok", type: "string", value: overInt64 } },
    });

    const intCastFloatSpec = makeTextSpec(
      [{ lit: "n=" }, { hole: "n", class: "int" }],
      [
        {
          id: "f1",
          name: "n",
          from: { hole: "n" },
          type: "float",
          semantic: "count",
          transforms: [{ op: "cast", to: "float" }],
        },
      ],
    );
    expect(toVectorResult(parseRecord(intCastFloatSpec, `n=${overInt64}`))).toEqual({
      matched: true,
      fields: { n: { status: "ok", type: "float", value: "43e0000000000000" } },
    });

    const intCastStringSpec = makeTextSpec(
      [{ lit: "n=" }, { hole: "n", class: "int" }],
      [
        {
          id: "f1",
          name: "n",
          from: { hole: "n" },
          type: "string",
          semantic: "id",
          transforms: [{ op: "cast", to: "string" }],
        },
      ],
    );
    expect(toVectorResult(parseRecord(intCastStringSpec, `n=${overInt64}`))).toEqual({
      matched: true,
      fields: { n: { status: "ok", type: "string", value: overInt64 } },
    });

    const intStringDropSpec = makeTextSpec(
      [{ lit: "n=" }, { hole: "n", class: "int" }],
      [
        {
          id: "f1",
          name: "n",
          from: { hole: "n" },
          type: "string",
          semantic: "id",
          transforms: [{ op: "drop" }],
        },
      ],
    );
    expect(toVectorResult(parseRecord(intStringDropSpec, `n=${overInt64}`))).toEqual({
      matched: true,
      fields: { n: { status: "dropped" } },
    });

    const intScaleOverflowSpec = makeTextSpec(
      [{ lit: "n=" }, { hole: "n", class: "int" }],
      [
        {
          id: "f1",
          name: "n",
          from: { hole: "n" },
          type: "float",
          semantic: "amount",
          transforms: [{ op: "scale", div: 100 }],
        },
      ],
    );
    expect(toVectorResult(parseRecord(intScaleOverflowSpec, `n=${overInt64}`))).toEqual({
      matched: true,
      fields: { n: { status: "parse_error", code: "int_overflow" } },
    });
  });

  it("checks exact string output when scaling int holes with or without a leading lower", () => {
    const fixture = path.join(RUNTIME_DIR, "test/fixtures/int-hole-scale-to-string.json");
    execFileSync(
      process.execPath,
      [CLI_PATH, "--input", fixture, "--format", "vector-ndjson", "--check", "--strict-error-codes"],
      { encoding: "utf8", stdio: "pipe" },
    );
  });

  it("enforces scalar-only hash coercion and word+colon+rest split with trailing whitespace", () => {
    const hashObjSpec: ParserSpec = {
      spec_version: 1,
      template: "tpl_01HASHSC01",
      event: "review.hash_scalar_only",
      version: 1,
      status: "active",
      origin: "agent",
      source: { kind: "mined" },
      match: { kind: "object", shape: ["val"] },
      fields: [
        {
          id: "f_val",
          name: "val",
          from: { path: "val" },
          type: "string",
          semantic: "id",
          transforms: [{ op: "hash", kind: "user" }],
        },
      ],
      tests: [],
    };
    const hostedOpts = { hashMode: "hosted" as const, hashKeys: { edgeKey, serverKey } };

    const intHash = toVectorResult(parseRecord(hashObjSpec, { kind: "object", object: { val: 42 } }, hostedOpts));
    expect(intHash).toEqual({
      matched: true,
      fields: {
        val: {
          status: "ok",
          type: "string",
          value: `<user:${computeHostedPseudonymTag(edgeKey, serverKey, "42")}>`,
        },
      },
    });

    const boolHash = toVectorResult(parseRecord(hashObjSpec, { kind: "object", object: { val: true } }, hostedOpts));
    expect(boolHash).toEqual({
      matched: true,
      fields: {
        val: {
          status: "ok",
          type: "string",
          value: `<user:${computeHostedPseudonymTag(edgeKey, serverKey, "true")}>`,
        },
      },
    });

    for (const bad of [{ a: 1 }, [1, 2]]) {
      expect(
        toVectorResult(parseRecord(hashObjSpec, { kind: "object", object: { val: bad } }, hostedOpts)),
      ).toEqual({
        matched: true,
        fields: { val: { status: "parse_error", code: "type_mismatch" } },
      });
    }

    const restCastJsonHashSpec = makeTextSpec(
      [{ lit: "payload=" }, { hole: "p", class: "rest" }],
      [
        {
          id: "f1",
          name: "payload",
          from: { hole: "p" },
          type: "string",
          semantic: "id",
          transforms: [
            { op: "cast", to: "json" },
            { op: "hash", kind: "user" },
          ],
        },
      ],
    );
    for (const rawJson of ['{"a":1}', "[1,2]", "null"]) {
      expect(
        toVectorResult(parseRecord(restCastJsonHashSpec, `payload=${rawJson}`, hostedOpts)),
      ).toEqual({
        matched: true,
        fields: { payload: { status: "parse_error", code: "type_mismatch" } },
      });
    }

    // Trailing whitespace after leading custom inner token must preserve word+":"+rest split
    const wordColonRestSpec = makeTextSpec(
      [{ lit: "user=" }, { hole: "u", class: "word" }, { lit: ":" }, { hole: "r", class: "rest" }],
      [
        { id: "f1", name: "u", from: { hole: "u" }, type: "string", semantic: "id" },
        { id: "f2", name: "r", from: { hole: "r" }, type: "string", semantic: "message" },
      ],
    );
    expect(
      toVectorResult(parseRecord(wordColonRestSpec, `user=${customInner} tail`, hostedOpts)),
    ).toEqual({
      matched: true,
      fields: {
        u: { status: "redacted", token: "<redacted>" },
        r: { status: "redacted", token: "<redacted>" },
      },
    });
  });

  it("handles 20,000-level deeply nested valid JSON iteratively without stack overflow across object, rest->cast(json), json hole, and canonical serializers", () => {
    const depth = 20_000;
    const hostedOpts = { hashMode: "hosted" as const, hashKeys: { edgeKey, serverKey } };
    const customInnerEsc = `\\u003cuser:\\u007e${digest}\\u003e`;

    const nestedObjSpec: ParserSpec = {
      spec_version: 1,
      template: "tpl_01DEEP01",
      event: "review.deep_json_obj",
      version: 1,
      status: "active",
      origin: "agent",
      source: { kind: "mined" },
      match: { kind: "object", shape: ["data"] },
      fields: [{ id: "f1", name: "data", from: { path: "data" }, type: "json", semantic: "payload" }],
      tests: [],
    };
    const restCastJsonSpec = makeTextSpec(
      [{ lit: "payload=" }, { hole: "p", class: "rest" }],
      [
        {
          id: "f1",
          name: "payload",
          from: { hole: "p" },
          type: "json",
          semantic: "payload",
          transforms: [{ op: "cast", to: "json" }],
        },
      ],
    );
    const jsonHoleSpec = makeTextSpec(
      [{ lit: "payload=" }, { hole: "p", class: "json" }],
      [{ id: "f1", name: "payload", from: { hole: "p" }, type: "json", semantic: "payload" }],
    );

    let deepClean: JsonValue = "ok";
    let deepInner: JsonValue = customInner;
    for (let i = 0; i < depth; i++) {
      deepClean = [deepClean];
      deepInner = [deepInner];
    }

    const objClean = toVectorResult(
      parseRecord(nestedObjSpec, { kind: "object", object: { data: deepClean } }, hostedOpts),
    );
    expect(objClean.matched).toBe(true);
    if (objClean.matched) {
      expect(objClean.fields["data"]?.status).toBe("ok");
    }

    expect(
      toVectorResult(
        parseRecord(nestedObjSpec, { kind: "object", object: { data: deepInner } }, hostedOpts),
      ),
    ).toEqual({
      matched: true,
      fields: { data: { status: "redacted", token: "<redacted>" } },
    });

    const open = "[".repeat(depth);
    const close = "]".repeat(depth);
    const deepCleanLine = `payload=${open}"ok"${close}`;
    const deepInnerLine = `payload=${open}"${customInnerEsc}"${close}`;

    const restClean = toVectorResult(parseRecord(restCastJsonSpec, deepCleanLine, hostedOpts));
    expect(restClean.matched).toBe(true);
    if (restClean.matched) {
      expect(restClean.fields["payload"]?.status).toBe("ok");
    }
    expect(toVectorResult(parseRecord(restCastJsonSpec, deepInnerLine, hostedOpts))).toEqual({
      matched: true,
      fields: { payload: { status: "redacted", token: "<redacted>" } },
    });

    const holeClean = toVectorResult(parseRecord(jsonHoleSpec, deepCleanLine, hostedOpts));
    expect(holeClean.matched).toBe(true);
    if (holeClean.matched) {
      expect(holeClean.fields["payload"]?.status).toBe("ok");
    }
    expect(toVectorResult(parseRecord(jsonHoleSpec, deepInnerLine, hostedOpts))).toEqual({
      matched: true,
      fields: { payload: { status: "redacted", token: "<redacted>" } },
    });

    const expectedSerialized = `${open}"ok"${close}`;
    expect(canonicalizeJson(deepClean)).toBe(expectedSerialized);
    expect(stringifyVectorJson(deepClean)).toBe(expectedSerialized);

    // Circular object inputs remain cleanly rejected (never hang or overflow)
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const circRes = parseRecord(nestedObjSpec, { kind: "object", object: { data: circular } }, hostedOpts);
    expect(circRes.matched).toBe(true);
    if (circRes.matched) {
      expect(circRes.fields["data"]?.status).toBe("error");
    }
  });

  it("does not confuse a standalone JSON field named fields with a vector envelope or mutate wide JSON numbers and signed zero", () => {
    const wideFieldsSpec = JSON.stringify({
      spec_version: 1,
      template: "tpl_01JNY8VHGABQ3K7S8PG4N1ZJ2P",
      event: "review.json_expectation",
      version: 1,
      status: "active",
      origin: "agent",
      source: { kind: "mined" },
      match: { kind: "object", shape: ["payload"] },
      fields: [
        {
          id: "fld_01JSONPAYLOAD",
          name: "fields",
          from: { path: "payload" },
          type: "json",
          semantic: "unknown",
        },
      ],
      tests: [
        {
          object: {
            payload: { copy: { status: "ok", type: "timestamp", value: 9007199254740992 } },
          },
          expect: {
            fields: { copy: { status: "ok", type: "timestamp", value: 9007199254740992 } },
          },
        },
      ],
    });

    const signedZeroFieldsSpec =
      `{"spec_version":1,"template":"tpl_01JNY8VHGABQ3K7S8PG4N1ZJ2P","event":"review.json_expectation","version":1,"status":"active","origin":"agent","source":{"kind":"mined"},"match":{"kind":"object","shape":["payload"]},"fields":[{"id":"fld_01JSONPAYLOAD","name":"fields","from":{"path":"payload"},"type":"json","semantic":"unknown"}],"tests":[{"object":{"payload":{"copy":{"status":"ok","type":"timestamp","value":0}}},"expect":{"fields":{"copy":{"status":"ok","type":"timestamp","value":-0}}}}]}`;

    // Standalone spec with BOTH a bool field named "matched" and a json field named "fields"
    // plus a real timestamp field "ts"
    const combinedStandaloneSpec =
      `{"spec_version":1,"template":"tpl_01JNY8VHGABQ3K7S8PG4N1ZJ2P","event":"review.json_expectation_combined","version":1,"status":"active","origin":"agent","source":{"kind":"mined"},"match":{"kind":"object","shape":["matched","payload","ts"]},"fields":[{"id":"f_m","name":"matched","from":{"path":"matched"},"type":"bool","semantic":"unknown"},{"id":"f_f","name":"fields","from":{"path":"payload"},"type":"json","semantic":"unknown"},{"id":"f_t","name":"ts","from":{"path":"ts"},"type":"timestamp","semantic":"timestamp","transforms":[{"op":"parse_time","format":"unix_ms"}]}],"tests":[{"object":{"matched":true,"payload":{"copy":{"status":"ok","type":"timestamp","value":9007199254740992}},"ts":"9007199254740993"},"expect":{"matched":true,"fields":{"copy":{"status":"ok","type":"timestamp","value":9007199254740992}},"ts":9.007199254740993e15}}]}`;

    const combinedSignedZeroFail =
      `{"spec_version":1,"template":"tpl_01JNY8VHGABQ3K7S8PG4N1ZJ2P","event":"review.json_expectation_combined","version":1,"status":"active","origin":"agent","source":{"kind":"mined"},"match":{"kind":"object","shape":["payload","ts"]},"fields":[{"id":"f_f","name":"fields","from":{"path":"payload"},"type":"json","semantic":"unknown"},{"id":"f_t","name":"ts","from":{"path":"ts"},"type":"timestamp","semantic":"timestamp","transforms":[{"op":"parse_time","format":"unix_ms"}]}],"tests":[{"object":{"payload":{"copy":{"status":"ok","type":"timestamp","value":0}},"ts":"9007199254740993"},"expect":{"fields":{"copy":{"status":"ok","type":"timestamp","value":-0}},"ts":9007199254740993}}]}`;

    // Plain VectorCase (no matched) with a json field named "fields"
    const plainVectorCase =
      `{"id":"plain-fields","spec":{"spec_version":1,"template":"tpl_01PLAINFIELDS","event":"review.plain_fields","version":1,"status":"active","origin":"agent","source":{"kind":"mined"},"match":{"kind":"object","shape":["payload"]},"fields":[{"id":"f1","name":"fields","from":{"path":"payload"},"type":"json","semantic":"unknown"}],"tests":[]},"input":{"object":{"payload":{"copy":{"status":"ok","type":"timestamp","value":9007199254740992}}}},"expect":{"fields":{"copy":{"status":"ok","type":"timestamp","value":9007199254740992}}}}`;

    // Vector envelope with both a json field containing a timestamp-shaped object and a real timestamp field
    const vectorEnvelopeCase =
      `{"id":"vec-mixed","spec":{"spec_version":1,"template":"tpl_01VECMIXED","event":"review.vec_mixed","version":1,"status":"active","origin":"agent","source":{"kind":"mined"},"match":{"kind":"object","shape":["payload","ts"]},"fields":[{"id":"f1","name":"data","from":{"path":"payload"},"type":"json","semantic":"unknown"},{"id":"f2","name":"ts","from":{"path":"ts"},"type":"timestamp","semantic":"timestamp","transforms":[{"op":"parse_time","format":"unix_ms"}]}],"tests":[]},"input":{"object":{"payload":{"copy":{"status":"ok","type":"timestamp","value":9007199254740992}},"ts":"9007199254740993"}},"expected":{"matched":true,"fields":{"data":{"status":"ok","type":"json","value":{"copy":{"status":"ok","type":"timestamp","value":9007199254740992}}},"ts":{"status":"ok","type":"timestamp","value":9007199254740993}}}}`;

    for (const [label, raw] of [
      ["wideFieldsSpec", wideFieldsSpec],
      ["combinedStandaloneSpec", combinedStandaloneSpec],
      ["plainVectorCase", plainVectorCase],
      ["vectorEnvelopeCase", vectorEnvelopeCase],
    ] as const) {
      const cases = parseFixturePayload(raw, `${label}.json`);
      const report = runVectorCases(cases);
      expect(report.failed, `${label}: ${JSON.stringify(report.checks)}`).toBe(0);
      expect(report.passed).toBe(1);
    }

    // Signed zero in JSON expectation must NOT be coerced to +0
    for (const [label, raw] of [
      ["signedZeroFieldsSpec", signedZeroFieldsSpec],
      ["combinedSignedZeroFail", combinedSignedZeroFail],
    ] as const) {
      const cases = parseFixturePayload(raw, `${label}.json`);
      const report = runVectorCases(cases);
      expect(report.failed, `${label} should fail on 0 vs -0`).toBe(1);
      expect(report.checks[0]?.diffs[0]).toContain(`"value":-0`);
    }

    // End-to-end CLI verification
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-runtime-ts-fields-json-"));
    try {
      const widePath = path.join(tmpDir, "wide-fields.json");
      fs.writeFileSync(widePath, wideFieldsSpec, "utf8");
      execFileSync(
        process.execPath,
        [CLI_PATH, "--input", widePath, "--format", "ndjson", "--check"],
        { encoding: "utf8", stdio: "pipe" },
      );

      const szPath = path.join(tmpDir, "signed-zero-fields.json");
      fs.writeFileSync(szPath, signedZeroFieldsSpec, "utf8");
      let szExit = 0;
      try {
        execFileSync(
          process.execPath,
          [CLI_PATH, "--input", szPath, "--format", "ndjson", "--check"],
          { encoding: "utf8", stdio: "pipe" },
        );
      } catch (err) {
        szExit = (err as { status?: number }).status ?? -1;
      }
      expect(szExit).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps timestamp lexeme preservation stack-safe for 20,000-level nested fixtures containing timestamp text through the CLI", () => {
    const depth = 20_000;
    const open = "[".repeat(depth);
    const close = "]".repeat(depth);
    const deepPayload = `${open}{"type":"timestamp"}${close}`;

    // 1. Standalone ParserSpec with 20,000 nested arrays containing {"type":"timestamp"} (no timestamp field)
    const deepTsSpec =
      `{"spec_version":1,"template":"tpl_01DEEPTS01","event":"review.deep_ts","version":1,"status":"active","origin":"agent","source":{"kind":"mined"},"match":{"kind":"object","shape":["payload"]},"fields":[{"id":"f1","name":"data","from":{"path":"payload"},"type":"json","semantic":"unknown"}],"tests":[{"object":{"payload":${deepPayload}},"expect":{"data":${deepPayload}}}]}`;

    // 2. Standalone ParserSpec with BOTH 20,000 nested arrays containing "timestamp" AND a real timestamp field
    const deepTsWithRealTimestampOk =
      `{"spec_version":1,"template":"tpl_01DEEPTS02","event":"review.deep_ts_real","version":1,"status":"active","origin":"agent","source":{"kind":"mined"},"match":{"kind":"object","shape":["payload","ts"]},"fields":[{"id":"f1","name":"data","from":{"path":"payload"},"type":"json","semantic":"unknown"},{"id":"f2","name":"ts","from":{"path":"ts"},"type":"timestamp","semantic":"timestamp","transforms":[{"op":"parse_time","format":"unix_ms"}]}],"tests":[{"object":{"payload":${deepPayload},"ts":"9007199254740993"},"expect":{"data":${deepPayload},"ts":9.007199254740993e15}}]}`;

    const deepTsWithRealTimestampFracFail =
      `{"spec_version":1,"template":"tpl_01DEEPTS02","event":"review.deep_ts_real","version":1,"status":"active","origin":"agent","source":{"kind":"mined"},"match":{"kind":"object","shape":["payload","ts"]},"fields":[{"id":"f1","name":"data","from":{"path":"payload"},"type":"json","semantic":"unknown"},{"id":"f2","name":"ts","from":{"path":"ts"},"type":"timestamp","semantic":"timestamp","transforms":[{"op":"parse_time","format":"unix_ms"}]}],"tests":[{"object":{"payload":${deepPayload},"ts":"9007199254740992"},"expect":{"data":${deepPayload},"ts":9007199254740992.5}}]}`;

    // 3. Vector suite with 20,000 nested arrays containing "timestamp" AND a real vector timestamp expectation
    const deepVectorSuite =
      `{"schema_version":1,"suite":"deep-ts-suite","vectors":[{"id":"deep-vec-1","spec":{"spec_version":1,"template":"tpl_01DEEPVEC1","event":"review.deep_vec","version":1,"status":"active","origin":"agent","source":{"kind":"mined"},"match":{"kind":"object","shape":["payload","ts"]},"fields":[{"id":"f1","name":"data","from":{"path":"payload"},"type":"json","semantic":"unknown"},{"id":"f2","name":"ts","from":{"path":"ts"},"type":"timestamp","semantic":"timestamp","transforms":[{"op":"parse_time","format":"unix_ms"}]}],"tests":[]},"input":{"object":{"payload":${deepPayload},"ts":"9007199254740993"}},"expected":{"matched":true,"fields":{"data":{"status":"ok","type":"json","value":${deepPayload}},"ts":{"status":"ok","type":"timestamp","value":9007199254740993}}}}]}`;

    for (const [label, raw] of [
      ["deepTsSpec", deepTsSpec],
      ["deepTsWithRealTimestampOk", deepTsWithRealTimestampOk],
      ["deepVectorSuite", deepVectorSuite],
    ] as const) {
      const cases = parseFixturePayload(raw, `${label}.json`);
      const report = runVectorCases(cases);
      expect(report.failed, `${label}: ${JSON.stringify(report.checks)}`).toBe(0);
      expect(report.passed).toBe(1);
    }

    const fracReport = runVectorCases(
      parseFixturePayload(deepTsWithRealTimestampFracFail, "deep-frac.json"),
    );
    expect(fracReport.failed).toBe(1);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-runtime-ts-deep-ts-"));
    try {
      const deepPath = path.join(tmpDir, "deep-ts.json");
      fs.writeFileSync(deepPath, deepTsSpec, "utf8");
      const ndjsonOut = execFileSync(
        process.execPath,
        [CLI_PATH, "--input", deepPath, "--format", "ndjson", "--check"],
        { encoding: "utf8", stdio: "pipe" },
      );
      expect(ndjsonOut).toContain(`"matched":true`);

      const vecOut = execFileSync(
        process.execPath,
        [CLI_PATH, "--input", deepPath, "--format", "vector-ndjson", "--check"],
        { encoding: "utf8", stdio: "pipe" },
      );
      expect(vecOut).toContain(`"matched":true`);

      const deepRealPath = path.join(tmpDir, "deep-ts-real.json");
      fs.writeFileSync(deepRealPath, deepTsWithRealTimestampOk, "utf8");
      const realOut = execFileSync(
        process.execPath,
        [CLI_PATH, "--input", deepRealPath, "--format", "vector-ndjson", "--check"],
        { encoding: "utf8", stdio: "pipe" },
      );
      expect(realOut).toContain("9007199254740993");

      const deepSuitePath = path.join(tmpDir, "deep-suite.json");
      fs.writeFileSync(deepSuitePath, deepVectorSuite, "utf8");
      const suiteOut = execFileSync(
        process.execPath,
        [CLI_PATH, "--input", deepSuitePath, "--format", "vector-ndjson", "--check"],
        { encoding: "utf8", stdio: "pipe" },
      );
      expect(suiteOut).toContain("9007199254740993");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
