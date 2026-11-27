import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkFieldExpectations,
  computeHostedPseudonymTag,
  computeInnerPseudonymBytes,
  jsonTextContainsInnerEdgeToken,
  parseFixturePayload,
  parseRecord,
  runVectorCases,
  toLowerHex,
  toVectorResult,
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
});
