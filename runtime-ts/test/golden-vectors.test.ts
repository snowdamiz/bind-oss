import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkFieldExpectations,
  compareVectorResults,
  compileParser,
  computeHostedPseudonymTag,
  computeInnerPseudonymBytes,
  formatVectorResults,
  parseFixturePayload,
  parseRecord,
  parseTimeValue,
  runVectorCases,
  toCanonicalResult,
  toLowerHex,
  toVectorResult,
  type FieldType,
  type ParserSpec,
} from "../src/index.js";

const RUNTIME_DIR = path.resolve(import.meta.dirname, "..");
const CLI_PATH = path.join(RUNTIME_DIR, "dist/cli.js");
const VECTORS_DIR = process.env["BIND_VECTORS_DIR"]
  ? path.resolve(process.env["BIND_VECTORS_DIR"])
  : path.resolve(RUNTIME_DIR, "../spec/vectors");
const MANIFEST_PATH = path.join(VECTORS_DIR, "manifest.json");

interface SuiteManifestEntry {
  readonly suite: string;
  readonly file: string;
  readonly count: number;
  readonly sql_supported_count: number;
  readonly sql_refused_count: number;
  readonly sha256: string;
}

interface VectorManifest {
  readonly schema_version: number;
  readonly total_vectors: number;
  readonly sql_supported_count: number;
  readonly sql_refused_count: number;
  readonly suites: readonly SuiteManifestEntry[];
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as VectorManifest;

describe(`PR #5 golden conformance vector suites (${manifest.total_vectors} vectors across 7 suites)`, () => {
  it("loads manifest with exact suite and SQL support counts", () => {
    expect(manifest.schema_version).toBe(1);
    expect(manifest.suites).toHaveLength(7);
    expect(manifest.total_vectors).toBeGreaterThanOrEqual(482);
    expect(manifest.sql_supported_count + manifest.sql_refused_count).toBe(
      manifest.total_vectors,
    );
    expect(manifest.sql_refused_count).toBeGreaterThanOrEqual(27);
    expect(manifest.suites.reduce((sum, s) => sum + s.count, 0)).toBe(manifest.total_vectors);
    expect(manifest.suites.reduce((sum, s) => sum + s.sql_supported_count, 0)).toBe(
      manifest.sql_supported_count,
    );
    expect(manifest.suites.reduce((sum, s) => sum + s.sql_refused_count, 0)).toBe(
      manifest.sql_refused_count,
    );
  });

  for (const entry of manifest.suites) {
    it(`passes suite ${entry.suite} (${entry.count} vectors) via runner API with strict error codes`, () => {
      const suitePath = path.join(VECTORS_DIR, entry.file);
      const raw = fs.readFileSync(suitePath, "utf8");
      const cases = parseFixturePayload(raw, entry.suite);
      expect(cases).toHaveLength(entry.count);

      const sqlSupported = cases.filter((c) => c.sql?.supported === true).length;
      const sqlRefused = cases.filter((c) => c.sql?.supported === false).length;
      expect(sqlSupported).toBe(entry.sql_supported_count);
      expect(sqlRefused).toBe(entry.sql_refused_count);

      const report = runVectorCases(cases, undefined, { checkErrorCode: true });
      const failures = report.checks.filter((c) => !c.passed);
      expect(
        failures,
        failures.map((f) => `${f.id}: ${f.diffs.join("; ")}`).join("\n"),
      ).toEqual([]);
      expect(report.total).toBe(entry.count);
      expect(report.checked).toBe(entry.count);
      expect(report.passed).toBe(entry.count);
      expect(report.failed).toBe(0);
    });
  }

  it(`passes every embedded spec.tests[] case across all ${manifest.total_vectors} golden vectors`, () => {
    let totalSpecTests = 0;
    const failures: string[] = [];

    for (const entry of manifest.suites) {
      const suitePath = path.join(VECTORS_DIR, entry.file);
      const raw = fs.readFileSync(suitePath, "utf8");
      const cases = parseFixturePayload(raw, entry.suite);

      for (const c of cases) {
        const parser = compileParser(c.spec);
        for (let i = 0; i < c.spec.tests.length; i++) {
          totalSpecTests++;
          const t = c.spec.tests[i]!;
          const input =
            "line" in t
              ? { kind: "text" as const, line: t.line }
              : "object" in t
                ? { kind: "object" as const, object: t.object }
                : { args: t.args };
          const res = parser.parse(input, c.options);
          const diffs = checkFieldExpectations(c.spec, res, t.expect);
          if (diffs.length > 0) {
            failures.push(`${entry.suite}/${c.id}#${i}: ${diffs.join("; ")}`);
          }
        }
      }
    }

    expect(totalSpecTests).toBe(manifest.total_vectors);
    expect(failures).toEqual([]);
  });

  it("executes compiled CLI end-to-end against all 7 golden vector suites", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-runtime-ts-goldens-"));
    try {
      const suitePaths = manifest.suites.map((s) => path.join(VECTORS_DIR, s.file));

      // Verify each suite individually via CLI
      for (const entry of manifest.suites) {
        const suitePath = path.join(VECTORS_DIR, entry.file);
        const outPath = path.join(tmpDir, `${entry.suite}.ndjson`);
        execFileSync(
          process.execPath,
          [
            CLI_PATH,
            "--input",
            suitePath,
            "--output",
            outPath,
            "--format",
            "vector-ndjson",
            "--check",
            "--strict-error-codes",
          ],
          { encoding: "utf8", stdio: "pipe" },
        );
        const lines = fs
          .readFileSync(outPath, "utf8")
          .trim()
          .split("\n")
          .filter((l) => l.length > 0);
        expect(lines).toHaveLength(entry.count);
      }

      // Verify all 7 suites together in a single CLI invocation
      const allOut = path.join(tmpDir, `all-${manifest.total_vectors}.ndjson`);
      execFileSync(
        process.execPath,
        [
          CLI_PATH,
          ...suitePaths.flatMap((p) => ["--input", p]),
          "--output",
          allOut,
          "--format",
          "vector-ndjson",
          "--check",
          "--strict-error-codes",
        ],
        { encoding: "utf8", stdio: "pipe" },
      );
      const allLines = fs
        .readFileSync(allOut, "utf8")
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);
      expect(allLines).toHaveLength(manifest.total_vectors);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Golden vector integration regressions", () => {
  it("parses both RFC 5424 ISO and RFC 3164 yearless timestamps under format:syslog and rejects offsetless ISO", () => {
    const expectedMs = 1795701600000n; // 2026-11-26T14:00:00.000Z
    expect(parseTimeValue("2026-11-26T14:00:00Z", "syslog", 1970)).toBe(expectedMs);
    expect(parseTimeValue("2026-11-26T09:00:00.250-05:00", "syslog", 1970)).toBe(
      expectedMs + 250n,
    );
    expect(parseTimeValue("Nov 26 14:00:00", "syslog", 2026)).toBe(expectedMs);
    expect(parseTimeValue("2026-11-26T14:00:00", "iso8601")).toBeNull();
    expect(parseTimeValue("2026-11-26T14:00:00", "rfc3339")).toBeNull();
    expect(parseTimeValue("2026-11-26T14:00:00", "auto")).toBeNull();
  });

  it("preserves exact decimal lexeme through float hole to unix_s and normalizes leading-zero padded exponents", () => {
    expect(parseTimeValue("1.001", "unix_s")).toBe(1001n);
    expect(parseTimeValue("-1.0019", "unix_s")).toBe(-1001n);
    expect(parseTimeValue(0.29, "unix_s")).toBe(290n);
    expect(parseTimeValue("1.5e2", "unix_s")).toBe(150000n);
    expect(parseTimeValue("-0.0009", "unix_s")).toBe(0n);
    expect(parseTimeValue("9223372036854775.807", "unix_s")).toBe(9223372036854775807n);
    expect(parseTimeValue("9223372036854775.808", "unix_s")).toBeNull();

    // Leading-zero padded exponents normalize before exponent magnitude checks
    expect(parseTimeValue("1e000000000", "unix_s")).toBe(1000n);
    expect(parseTimeValue("1.001e+000000000", "unix_s")).toBe(1001n);
    expect(parseTimeValue("1e-000000001", "unix_s")).toBe(100n);
    expect(parseTimeValue("1e+000000003", "unix_s")).toBe(1000000n);
    expect(parseTimeValue("1e-100000000", "unix_s")).toBe(0n);
    expect(parseTimeValue("1e+100000000", "unix_s")).toBeNull();

    // Exact decimal lexeme flows through a float hole into unix_s without binary64 rounding
    const floatUnixSpec: ParserSpec = {
      spec_version: 1,
      template: "tpl_01FUNIX01",
      event: "float.unix_s",
      version: 1,
      status: "active",
      origin: "agent",
      source: { kind: "mined" },
      match: { kind: "text", segments: [{ lit: "ts=" }, { hole: "ts", class: "float" }] },
      fields: [
        {
          id: "fld_01",
          name: "ts",
          from: { hole: "ts" },
          type: "timestamp",
          semantic: "unknown",
          transforms: [{ op: "parse_time", format: "unix_s" }],
        },
      ],
      tests: [],
    };

    // Binary64 Number("1.00099999999999999") rounds to 1.001 (1001 ms); exact decimal truncates to 1000 ms
    for (const [line, expectedMs] of [
      ["ts=1.00099999999999999", 1000],
      ["ts=1.001", 1001],
      ["ts=1e000000000", 1000],
      ["ts=1.001e+000000000", 1001],
      ["ts=1e-000000001", 100],
      ["ts=1e+000000003", 1000000],
    ] as const) {
      const res = parseRecord(floatUnixSpec, line);
      expect(res.matched, line).toBe(true);
      expect(toVectorResult(res)).toEqual({
        matched: true,
        fields: { ts: { status: "ok", type: "timestamp", value: expectedMs } },
      });
    }
  });

  it("bounds variable-width scalar holes at the earliest following literal with no backtracking", () => {
    const wordEndLitSpec: ParserSpec = {
      spec_version: 1,
      template: "tpl_01NOBT01",
      event: "nobt.word",
      version: 1,
      status: "active",
      origin: "agent",
      source: { kind: "mined" },
      match: {
        kind: "text",
        segments: [{ lit: "tok=" }, { hole: "w", class: "word" }, { lit: ",id=" }],
      },
      fields: [{ id: "fld_01", name: "w", from: { hole: "w" }, type: "string", semantic: "text" }],
      tests: [],
    };
    const okWord = parseRecord(wordEndLitSpec, "tok=ord_8f2a,id=");
    expect(okWord.matched).toBe(true);
    if (okWord.matched) {
      expect(okWord.fields["w"]).toMatchObject({ status: "ok", value: "ord_8f2a" });
    }
    // Must stop at leftmost ",id=" and not backtrack to the trailing ",id="
    expect(parseRecord(wordEndLitSpec, "tok=a,id=b,id=").matched).toBe(false);
  });

  it("redacts unexpected 64-hex inner edge tokens as <redacted> in default hosted mode without leaking digest", () => {
    const digest = "a".repeat(64);
    const innerToken = `<email:~${digest}>`;
    const hashKeys = { edgeKey: "edge-secret-v1", serverKey: "server-secret-v1" };

    const textSpec = (
      type: FieldType,
      transforms?: ParserSpec["fields"][number]["transforms"],
    ): ParserSpec => ({
      spec_version: 1,
      template: "tpl_01INNER01",
      event: "inner.hosted",
      version: 1,
      status: "active",
      origin: "agent",
      source: { kind: "mined" },
      match: { kind: "text", segments: [{ lit: "v=" }, { hole: "v", class: "word" }] },
      fields: [
        {
          id: "fld_01",
          name: "v",
          from: { hole: "v" },
          type,
          semantic: "email",
          pii: "email",
          ...(transforms !== undefined ? { transforms } : {}),
        },
      ],
      tests: [],
    });

    const cases = [
      parseRecord(textSpec("string"), `v=${innerToken}`, { hashKeys }),
      parseRecord(textSpec("string", [{ op: "hash", kind: "email" }]), `v=${innerToken}`, {
        hashKeys,
      }),
      parseRecord(textSpec("string", [{ op: "drop" }]), `v=${innerToken}`, { hashKeys }),
      parseRecord(textSpec("int"), `v=${innerToken}`, { hashKeys }),
      parseRecord(
        {
          ...textSpec("string"),
          match: { kind: "object", shape: ["v"] },
          fields: [{ id: "fld_01", name: "v", from: { path: "v" }, type: "string", semantic: "email" }],
        },
        { kind: "object", object: { v: innerToken } },
        { hashKeys },
      ),
      parseRecord(
        {
          ...textSpec("string"),
          match: { kind: "args", strings: ["v=", ""] },
          fields: [{ id: "fld_01", name: "v", from: { arg: 0 }, type: "string", semantic: "email" }],
        },
        { kind: "args", strings: ["v=", ""], args: [innerToken] },
        { hashKeys },
      ),
    ];

    for (const res of cases) {
      expect(res.matched).toBe(true);
      const vec = toVectorResult(res);
      expect(vec).toEqual({
        matched: true,
        fields: { v: { status: "redacted", token: "<redacted>" } },
      });
      expect(JSON.stringify(vec)).not.toContain(digest);
      expect(JSON.stringify(toCanonicalResult("inner", res))).not.toContain(digest);
    }

    // Explicit gateway authority on non-string target or without serverKey still fails closed to <redacted>
    const gwNoKey = parseRecord(
      textSpec("string", [{ op: "hash", kind: "email" }]),
      `v=${innerToken}`,
      { hashMode: "gateway" },
    );
    expect(toVectorResult(gwNoKey)).toEqual({
      matched: true,
      fields: { v: { status: "redacted", token: "<redacted>" } },
    });

    const gwNonString = parseRecord(
      textSpec("int", [{ op: "hash", kind: "email" }]),
      `v=${innerToken}`,
      { hashMode: "gateway", hashKeys: { serverKey: hashKeys.serverKey } },
    );
    expect(toVectorResult(gwNonString)).toEqual({
      matched: true,
      fields: { v: { status: "redacted", token: "<redacted>" } },
    });
  });

  it("recognizes quoted unescaped complete scrub tokens identically to structured strings", () => {
    const digest = "b".repeat(64);
    const makeQuotedSpec = (
      type: FieldType,
      transforms?: ParserSpec["fields"][number]["transforms"],
    ): ParserSpec => ({
      spec_version: 1,
      template: "tpl_01QSCRUB01",
      event: "quoted.scrub",
      version: 1,
      status: "active",
      origin: "agent",
      source: { kind: "mined" },
      match: { kind: "text", segments: [{ lit: "v=" }, { hole: "v", class: "quoted" }] },
      fields: [
        {
          id: "fld_01",
          name: "v",
          from: { hole: "v" },
          type,
          semantic: "text",
          ...(transforms !== undefined ? { transforms } : {}),
        },
      ],
      tests: [],
    });

    // Double-quoted and single-quoted complete mask tokens
    expect(toVectorResult(parseRecord(makeQuotedSpec("string"), 'v="<card>"'))).toEqual({
      matched: true,
      fields: { v: { status: "redacted", token: "<card>" } },
    });
    expect(toVectorResult(parseRecord(makeQuotedSpec("int"), "v='<secret:jwt>'"))).toEqual({
      matched: true,
      fields: { v: { status: "redacted", token: "<secret:jwt>" } },
    });

    // Quoted complete final pseudonym token: preserved on string (short-circuiting drop), redacted on int
    expect(
      toVectorResult(
        parseRecord(makeQuotedSpec("string", [{ op: "drop" }]), 'v="<email:9f2c41d07a3b55e1>"'),
      ),
    ).toEqual({
      matched: true,
      fields: { v: { status: "ok", type: "string", value: "<email:9f2c41d07a3b55e1>" } },
    });
    expect(
      toVectorResult(parseRecord(makeQuotedSpec("int"), 'v="<email:9f2c41d07a3b55e1>"')),
    ).toEqual({
      matched: true,
      fields: { v: { status: "redacted", token: "<email:9f2c41d07a3b55e1>" } },
    });

    // Quoted escaped sequence unescaping to a complete scrub token
    expect(
      toVectorResult(parseRecord(makeQuotedSpec("string"), 'v="<\\u0063ard>"')),
    ).toEqual({
      matched: true,
      fields: { v: { status: "redacted", token: "<card>" } },
    });

    // Quoted unexpected inner edge token redacts without leaking digest
    const quotedInner = toVectorResult(
      parseRecord(makeQuotedSpec("string"), `v="<email:~${digest}>"`),
    );
    expect(quotedInner).toEqual({
      matched: true,
      fields: { v: { status: "redacted", token: "<redacted>" } },
    });
    expect(JSON.stringify(quotedInner)).not.toContain(digest);

    // Partial, nested-quoted, or unknown-kind strings stay ordinary literal text
    expect(toVectorResult(parseRecord(makeQuotedSpec("string"), 'v="<card> extra"'))).toEqual({
      matched: true,
      fields: { v: { status: "ok", type: "string", value: "<card> extra" } },
    });
    expect(toVectorResult(parseRecord(makeQuotedSpec("string"), 'v="\\"<card>\\""'))).toEqual({
      matched: true,
      fields: { v: { status: "ok", type: "string", value: '"<card>"' } },
    });
    expect(toVectorResult(parseRecord(makeQuotedSpec("string"), 'v="<nil>"'))).toEqual({
      matched: true,
      fields: { v: { status: "ok", type: "string", value: "<nil>" } },
    });
  });

  it("keeps generated pseudonym tag identity through repeat hash and non-string targets, and aligns omitted mask.kind", () => {
    const hashKeys = { edgeKey: "edge-secret-v1", serverKey: "server-secret-v1" };
    const expectedTag = computeHostedPseudonymTag(
      hashKeys.edgeKey,
      hashKeys.serverKey,
      "alice@example.com",
    );
    const customToken = `<user:${expectedTag}>`;

    const makeSpec = (
      type: FieldType,
      transforms: ParserSpec["fields"][number]["transforms"],
    ): ParserSpec => ({
      spec_version: 1,
      template: "tpl_01PIPE01",
      event: "pipe.order",
      version: 1,
      status: "active",
      origin: "agent",
      source: { kind: "mined" },
      match: { kind: "text", segments: [{ lit: "v=" }, { hole: "v", class: "word" }] },
      fields: [
        {
          id: "fld_01",
          name: "v",
          from: { hole: "v" },
          type,
          semantic: "email",
          pii: "email",
          ...(transforms !== undefined ? { transforms } : {}),
        },
      ],
      tests: [],
    });

    // 1. Pre-scrubbed pseudonym token short-circuits drop and mask
    const prescrubDrop = parseRecord(
      makeSpec("string", [{ op: "drop" }]),
      "v=<email:9f2c41d07a3b55e1>",
      { hashKeys },
    );
    expect(toVectorResult(prescrubDrop)).toEqual({
      matched: true,
      fields: { v: { status: "ok", type: "string", value: "<email:9f2c41d07a3b55e1>" } },
    });

    const prescrubMask = parseRecord(
      makeSpec("string", [{ op: "mask", mode: "token", kind: "email" }]),
      "v=<hash:9f2c41d07a3b55e1>",
      { hashKeys },
    );
    expect(toVectorResult(prescrubMask)).toEqual({
      matched: true,
      fields: { v: { status: "ok", type: "string", value: "<hash:9f2c41d07a3b55e1>" } },
    });

    // 2. Unknown kind angle-bracket token is NOT treated as pre-scrubbed
    const unknownKind = parseRecord(
      makeSpec("string", [{ op: "drop" }]),
      "v=<unknown:9f2c41d07a3b55e1>",
      { hashKeys },
    );
    expect(toVectorResult(unknownKind)).toEqual({
      matched: true,
      fields: { v: { status: "dropped" } },
    });

    // 3. Explicit drop/mask after an in-pipeline hash on raw input MUST execute
    expect(
      toVectorResult(
        parseRecord(
          makeSpec("string", [{ op: "hash", kind: "user" }, { op: "drop" }]),
          "v=alice@example.com",
          { hashKeys },
        ),
      ),
    ).toEqual({
      matched: true,
      fields: { v: { status: "dropped" } },
    });

    expect(
      toVectorResult(
        parseRecord(
          makeSpec("string", [
            { op: "hash", kind: "user" },
            { op: "mask", mode: "token", kind: "email" },
          ]),
          "v=alice@example.com",
          { hashKeys },
        ),
      ),
    ).toEqual({
      matched: true,
      fields: { v: { status: "redacted", token: "<email>" } },
    });

    // 4. Omitted mask.kind defaults to <redacted> even when field.pii is set
    expect(
      toVectorResult(
        parseRecord(makeSpec("string", [{ op: "mask" }]), "v=alice@example.com", { hashKeys }),
      ),
    ).toEqual({
      matched: true,
      fields: { v: { status: "redacted", token: "<redacted>" } },
    });

    // 5. Custom generated tag keeps its exact identity through repeat hash (no double-hashing)
    expect(
      toVectorResult(
        parseRecord(
          makeSpec("string", [{ op: "hash", kind: "user" }, { op: "hash" }]),
          "v=alice@example.com",
          { hashKeys },
        ),
      ),
    ).toEqual({
      matched: true,
      fields: { v: { status: "ok", type: "string", value: customToken } },
    });

    expect(
      toVectorResult(
        parseRecord(
          makeSpec("string", [
            { op: "hash", kind: "user" },
            { op: "hash", kind: "email" },
          ]),
          "v=alice@example.com",
          { hashKeys },
        ),
      ),
    ).toEqual({
      matched: true,
      fields: { v: { status: "ok", type: "string", value: customToken } },
    });

    // 6. Generated pseudonym tag targeting any non-string field emits redacted with the tag identity
    for (const nonStringType of ["int", "float", "bool", "timestamp", "json", "enum"] as const) {
      const res = parseRecord(
        makeSpec(nonStringType, [{ op: "hash", kind: "user" }]),
        "v=alice@example.com",
        { hashKeys },
      );
      expect(toVectorResult(res), `non-string target ${nonStringType}`).toEqual({
        matched: true,
        fields: { v: { status: "redacted", token: customToken } },
      });
    }
  });

  it("enforces strict typing on structured object/args inputs without cast and treats null as missing", () => {
    const spec: ParserSpec = {
      spec_version: 1,
      template: "tpl_01STRICT01",
      event: "strict.types",
      version: 1,
      status: "active",
      origin: "agent",
      source: { kind: "mined" },
      match: { kind: "object", shape: ["i", "f", "b", "ts", "j"] },
      fields: [
        { id: "fld_01", name: "i", from: { path: "i" }, type: "int", semantic: "count" },
        { id: "fld_02", name: "f", from: { path: "f" }, type: "float", semantic: "ratio" },
        { id: "fld_03", name: "b", from: { path: "b" }, type: "bool", semantic: "flag" },
        { id: "fld_04", name: "ts", from: { path: "ts" }, type: "timestamp", semantic: "unknown" },
        { id: "fld_05", name: "j", from: { path: "j" }, type: "json", semantic: "unknown" },
      ],
      tests: [],
    };

    const mismatch = parseRecord(spec, {
      kind: "object",
      object: { i: "200", f: "1.5", b: "true", ts: "2026-11-26T14:00:00Z", j: "raw-json-string" },
    });
    expect(mismatch.matched).toBe(true);
    if (mismatch.matched) {
      expect(mismatch.fields["i"]).toMatchObject({ status: "error", code: "TYPE_MISMATCH_INT" });
      expect(mismatch.fields["f"]).toMatchObject({ status: "error", code: "TYPE_MISMATCH_FLOAT" });
      expect(mismatch.fields["b"]).toMatchObject({ status: "error", code: "TYPE_MISMATCH_BOOL" });
      expect(mismatch.fields["ts"]).toMatchObject({
        status: "error",
        code: "TYPE_MISMATCH_TIMESTAMP",
      });
      // Structured string value for type:json without cast stays a JSON string
      expect(mismatch.fields["j"]).toMatchObject({ status: "ok", value: "raw-json-string" });
    }

    // Null structured values yield missing across all field types including json
    const nulls = parseRecord(spec, {
      kind: "object",
      object: { i: null, f: null, b: null, ts: null, j: null },
    });
    expect(nulls.matched).toBe(true);
    if (nulls.matched) {
      for (const name of ["i", "f", "b", "ts", "j"]) {
        expect(nulls.fields[name]).toMatchObject({ status: "missing" });
      }
    }

    // Cross-kind discriminated VectorInput must not match
    expect(parseRecord(spec, { kind: "text", line: "i=1" }).matched).toBe(false);
    expect(parseRecord(spec, { kind: "args", strings: [""], args: [] }).matched).toBe(false);
  });

  it("preserves non-safe Int64 timestamps losslessly in vector-ndjson output and comparison", () => {
    const tsSpec: ParserSpec = {
      spec_version: 1,
      template: "tpl_01TSI64A",
      event: "ts.int64",
      version: 1,
      status: "active",
      origin: "agent",
      source: { kind: "mined" },
      match: { kind: "text", segments: [{ lit: "ts=" }, { hole: "ts", class: "int" }] },
      fields: [
        {
          id: "fld_01",
          name: "ts",
          from: { hole: "ts" },
          type: "timestamp",
          semantic: "unknown",
          transforms: [{ op: "parse_time", format: "unix_ms" }],
        },
      ],
      tests: [],
    };

    // Safe integer timestamp remains JS number; non-safe Int64 preserves exact bigint
    const safeVec = toVectorResult(parseRecord(tsSpec, "ts=1795701600000"));
    expect(safeVec).toEqual({
      matched: true,
      fields: { ts: { status: "ok", type: "timestamp", value: 1795701600000 } },
    });
    if (safeVec.matched && safeVec.fields["ts"]?.status === "ok") {
      expect(typeof safeVec.fields["ts"].value).toBe("number");
    }

    const plusOneVec = toVectorResult(parseRecord(tsSpec, "ts=9007199254740993"));
    expect(plusOneVec).toEqual({
      matched: true,
      fields: { ts: { status: "ok", type: "timestamp", value: 9007199254740993n } },
    });
    expect(
      compareVectorResults(plusOneVec, {
        matched: true,
        fields: { ts: { status: "ok", type: "timestamp", value: 9007199254740993n } },
      }),
    ).toEqual([]);
    expect(
      compareVectorResults(plusOneVec, {
        matched: true,
        fields: { ts: { status: "ok", type: "timestamp", value: 9007199254740992 } },
      }),
    ).toHaveLength(1);

    // Direct formatter emits exact unquoted JSON integers
    const formatted = formatVectorResults([{ id: "probe-1", result: plusOneVec }], "ndjson");
    expect(formatted.trim()).toBe(
      '{"id":"probe-1","matched":true,"fields":{"ts":{"status":"ok","type":"timestamp","value":9007199254740993}}}',
    );

    // End-to-end CLI vector-ndjson lossless output and exact --check comparison
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-runtime-ts-int64-ts-"));
    try {
      const specJson = JSON.stringify(tsSpec);
      const okFixturePath = path.join(tmpDir, "ok.json");
      const okOutPath = path.join(tmpDir, "ok.ndjson");
      const rawOkFixture = [
        "[",
        `  {"id":"ts-unsafe-plus1","spec":${specJson},"input":{"kind":"text","line":"ts=9007199254740993"},"expected":{"matched":true,"fields":{"ts":{"status":"ok","type":"timestamp","value":9007199254740993}}}},`,
        `  {"id":"ts-int64-max","spec":${specJson},"input":{"kind":"text","line":"ts=9223372036854775807"},"expected":{"matched":true,"fields":{"ts":{"status":"ok","type":"timestamp","value":9223372036854775807}}}},`,
        `  {"id":"ts-int64-min","spec":${specJson},"input":{"kind":"text","line":"ts=-9223372036854775808"},"expected":{"matched":true,"fields":{"ts":{"status":"ok","type":"timestamp","value":-9223372036854775808}}}}`,
        "]",
      ].join("\n");
      fs.writeFileSync(okFixturePath, rawOkFixture, "utf8");

      execFileSync(
        process.execPath,
        [
          CLI_PATH,
          "--input",
          okFixturePath,
          "--output",
          okOutPath,
          "--format",
          "vector-ndjson",
          "--check",
          "--strict-error-codes",
        ],
        { encoding: "utf8", stdio: "pipe" },
      );

      const outLines = fs.readFileSync(okOutPath, "utf8").trim().split("\n");
      expect(outLines).toEqual([
        '{"id":"ts-unsafe-plus1","matched":true,"fields":{"ts":{"status":"ok","type":"timestamp","value":9007199254740993}}}',
        '{"id":"ts-int64-max","matched":true,"fields":{"ts":{"status":"ok","type":"timestamp","value":9223372036854775807}}}',
        '{"id":"ts-int64-min","matched":true,"fields":{"ts":{"status":"ok","type":"timestamp","value":-9223372036854775808}}}',
      ]);

      // Off-by-1 ms above Number.MAX_SAFE_INTEGER must fail --check (never collapse to equal)
      const mismatchFixturePath = path.join(tmpDir, "mismatch.json");
      const rawMismatchFixture = `{"id":"ts-off-by-1","spec":${specJson},"input":{"kind":"text","line":"ts=9007199254740993"},"expected":{"matched":true,"fields":{"ts":{"status":"ok","type":"timestamp","value":9007199254740992}}}}`;
      fs.writeFileSync(mismatchFixturePath, rawMismatchFixture, "utf8");

      let failedExit = 0;
      let stderrText = "";
      try {
        execFileSync(
          process.execPath,
          [
            CLI_PATH,
            "--input",
            mismatchFixturePath,
            "--format",
            "vector-ndjson",
            "--check",
            "--strict-error-codes",
          ],
          { encoding: "utf8", stdio: "pipe" },
        );
      } catch (err) {
        const e = err as { status?: number; stderr?: string };
        failedExit = e.status ?? -1;
        stderrText = String(e.stderr ?? "");
      }
      expect(failedExit).toBe(1);
      expect(stderrText).toContain("9007199254740993");
      expect(stderrText).toContain("9007199254740992");

      // Near-2^53 equivalent decimal & exponent timestamp representations pass --check losslessly
      const equivFixturePath = path.join(tmpDir, "equiv-ts.json");
      const rawEquivFixture = [
        "[",
        `  {"id":"ts-dec-zero","spec":${specJson},"input":{"kind":"text","line":"ts=9007199254740993"},"expected":{"matched":true,"fields":{"ts":{"status":"ok","type":"timestamp","value":9007199254740993.0}}}},`,
        `  {"id":"ts-exp-pos","spec":${specJson},"input":{"kind":"text","line":"ts=9007199254740993"},"expected":{"matched":true,"fields":{"ts":{"status":"ok","type":"timestamp","value":9.007199254740993e15}}}},`,
        `  {"id":"ts-exp-neg","spec":${specJson},"input":{"kind":"text","line":"ts=9007199254740993"},"expected":{"matched":true,"fields":{"ts":{"status":"ok","type":"timestamp","value":90071992547409930e-1}}}},`,
        `  {"id":"ts-max-exp","spec":${specJson},"input":{"kind":"text","line":"ts=9223372036854775807"},"expected":{"matched":true,"fields":{"ts":{"status":"ok","type":"timestamp","value":9.223372036854775807e18}}}},`,
        `  {"id":"ts-zero-huge-exp","spec":${specJson},"input":{"kind":"text","line":"ts=0"},"expected":{"matched":true,"fields":{"ts":{"status":"ok","type":"timestamp","value":0e+999999999}}}}`,
        "]",
      ].join("\n");
      fs.writeFileSync(equivFixturePath, rawEquivFixture, "utf8");
      execFileSync(
        process.execPath,
        [
          CLI_PATH,
          "--input",
          equivFixturePath,
          "--format",
          "vector-ndjson",
          "--check",
          "--strict-error-codes",
        ],
        { encoding: "utf8", stdio: "pipe" },
      );

      // Fractional expected timestamps near 2^53 or sub-unit MUST fail --check instead of rounding
      const fracProbes: readonly { id: string; line: string; expectedRaw: string }[] = [
        { id: "frac-half-even", line: "ts=9007199254740992", expectedRaw: "9007199254740992.5" },
        { id: "frac-exp-near-2p53", line: "ts=9007199254740992", expectedRaw: "9.0071992547409925e15" },
        { id: "frac-neg-exp", line: "ts=9007199254740992", expectedRaw: "90071992547409925e-1" },
        { id: "frac-sub-unit-zero", line: "ts=0", expectedRaw: "1e-1000" },
        { id: "frac-small", line: "ts=1", expectedRaw: "1.5" },
      ];
      for (const probe of fracProbes) {
        const fracPath = path.join(tmpDir, `${probe.id}.json`);
        fs.writeFileSync(
          fracPath,
          `{"id":"${probe.id}","spec":${specJson},"input":{"kind":"text","line":"${probe.line}"},"expected":{"matched":true,"fields":{"ts":{"status":"ok","type":"timestamp","value":${probe.expectedRaw}}}}}`,
          "utf8",
        );
        let code = 0;
        try {
          execFileSync(
            process.execPath,
            [CLI_PATH, "--input", fracPath, "--format", "vector-ndjson", "--check"],
            { encoding: "utf8", stdio: "pipe" },
          );
        } catch (err) {
          code = (err as { status?: number }).status ?? -1;
        }
        expect(code, `fractional probe ${probe.id} (${probe.expectedRaw})`).toBe(1);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("enforces whole-input inner-edge no-spill for custom kinds and strict gateway authorization", () => {
    const edgeKey = "edge-secret-v1";
    const serverKey = "server-secret-v1";
    const rawEmail = "alice@example.com";
    const digest = toLowerHex(computeInnerPseudonymBytes(edgeKey, rawEmail));
    const customInner = `<user:~${digest}>`;
    const expectedTag = computeHostedPseudonymTag(edgeKey, serverKey, rawEmail);

    const makeTextSpec = (
      segments: Extract<ParserSpec["match"], { kind: "text" }>["segments"],
      fields: ParserSpec["fields"],
    ): ParserSpec => ({
      spec_version: 1,
      template: "tpl_01NOSPILL",
      event: "nospill.check",
      version: 1,
      status: "active",
      origin: "agent",
      source: { kind: "mined" },
      match: { kind: "text", segments },
      fields,
      tests: [],
    });

    // 1. Hosted mode masks custom <user:~64hex> across overlap, split, decoded quoted/JSON, object, args
    const untilGt = makeTextSpec(
      [{ lit: "u=" }, { hole: "u", class: "until" }, { lit: "> s=" }, { hole: "s", class: "int" }],
      [
        { id: "f1", name: "u", from: { hole: "u" }, type: "string", semantic: "text" },
        { id: "f2", name: "s", from: { hole: "s" }, type: "int", semantic: "count" },
      ],
    );
    const overlapRes = toVectorResult(parseRecord(untilGt, `u=${customInner} s=200`));
    expect(overlapRes).toEqual({
      matched: true,
      fields: {
        u: { status: "redacted", token: "<redacted>" },
        s: { status: "ok", type: "int", value: "200" },
      },
    });
    expect(JSON.stringify(overlapRes)).not.toContain(digest);

    // Normal literal boundary preserved for non-inner 16-hex final pseudonym and plain text
    expect(toVectorResult(parseRecord(untilGt, "u=alice> s=200"))).toEqual({
      matched: true,
      fields: {
        u: { status: "ok", type: "string", value: "alice" },
        s: { status: "ok", type: "int", value: "200" },
      },
    });
    expect(toVectorResult(parseRecord(untilGt, "u=<email:9f2c41d07a3b55e1> s=200"))).toEqual({
      matched: true,
      fields: {
        u: { status: "ok", type: "string", value: "<email:9f2c41d07a3b55e1" },
        s: { status: "ok", type: "int", value: "200" },
      },
    });

    // Escaped custom inner-edge token in JSON hole value and JSON hole key
    const jsonHoleSpec = makeTextSpec(
      [{ lit: "j=" }, { hole: "j", class: "json" }],
      [{ id: "f1", name: "j", from: { hole: "j" }, type: "json", semantic: "unknown" }],
    );
    const escapedCustom = `\\u003cuser:\\u007e${digest}\\u003e`;
    const jsonValRes = toVectorResult(parseRecord(jsonHoleSpec, `j={"a":"${escapedCustom}"}`));
    expect(jsonValRes).toEqual({
      matched: true,
      fields: { j: { status: "redacted", token: "<redacted>" } },
    });
    expect(JSON.stringify(jsonValRes)).not.toContain(digest);

    const jsonKeyRes = toVectorResult(parseRecord(jsonHoleSpec, `j={"${escapedCustom}":1}`));
    expect(jsonKeyRes).toEqual({
      matched: true,
      fields: { j: { status: "redacted", token: "<redacted>" } },
    });

    // Structured object nested subtree and args containing custom inner-edge token
    const objSpec: ParserSpec = {
      spec_version: 1,
      template: "tpl_01OBJNS1",
      event: "obj.nospill",
      version: 1,
      status: "active",
      origin: "agent",
      source: { kind: "mined" },
      match: { kind: "object", shape: ["payload"] },
      fields: [{ id: "f1", name: "payload", from: { path: "payload" }, type: "json", semantic: "unknown" }],
      tests: [],
    };
    const objRes = toVectorResult(
      parseRecord(objSpec, { kind: "object", object: { payload: { nested: [`prefix ${customInner} suffix`] } } }),
    );
    expect(objRes).toEqual({
      matched: true,
      fields: { payload: { status: "redacted", token: "<redacted>" } },
    });

    // Non-inner custom angle forms stay ordinary text under closed-catalog mask/final rules
    const dropWord = makeTextSpec(
      [{ lit: "u=" }, { hole: "u", class: "word" }],
      [{ id: "f1", name: "u", from: { hole: "u" }, type: "string", semantic: "text", transforms: [{ op: "drop" }] }],
    );
    expect(toVectorResult(parseRecord(dropWord, "u=<user:9f2c41d07a3b55e1>"))).toEqual({
      matched: true,
      fields: { u: { status: "dropped" } },
    });

    // 2. Explicit gateway mode upgrades custom <user:~64hex> ONLY when authorized by declared hash.kind
    const gwUserSpec = makeTextSpec(
      [{ lit: "u=" }, { hole: "u", class: "word" }],
      [{
        id: "f1",
        name: "u",
        from: { hole: "u" },
        type: "string",
        semantic: "text",
        transforms: [{ op: "hash", kind: "user" }],
      }],
    );
    const gwEmailSpec = makeTextSpec(
      [{ lit: "u=" }, { hole: "u", class: "word" }],
      [{
        id: "f1",
        name: "u",
        from: { hole: "u" },
        type: "string",
        semantic: "email",
        pii: "email",
        transforms: [{ op: "hash", kind: "email" }],
      }],
    );

    // Authorized custom kind in gateway mode upgrades cleanly
    expect(
      toVectorResult(
        parseRecord(gwUserSpec, `u=${customInner}`, {
          hashMode: "gateway",
          hashKeys: { serverKey },
        }),
      ),
    ).toEqual({
      matched: true,
      fields: { u: { status: "ok", type: "string", value: `<user:${expectedTag}>` } },
    });

    // Unauthorized custom kind in gateway mode safely redacts to <redacted>
    const gwUnauth = toVectorResult(
      parseRecord(gwEmailSpec, `u=${customInner}`, {
        hashMode: "gateway",
        hashKeys: { serverKey },
      }),
    );
    expect(gwUnauth).toEqual({
      matched: true,
      fields: { u: { status: "redacted", token: "<redacted>" } },
    });
    expect(JSON.stringify(gwUnauth)).not.toContain(digest);

    // Partial overlap in gateway mode still safely redacts
    expect(
      toVectorResult(
        parseRecord(untilGt, `u=${customInner} s=200`, {
          hashMode: "gateway",
          hashKeys: { serverKey },
        }),
      ),
    ).toEqual({
      matched: true,
      fields: {
        u: { status: "redacted", token: "<redacted>" },
        s: { status: "ok", type: "int", value: "200" },
      },
    });

    // Explicit edge mode still emits custom <user:~64hex> from raw input
    expect(
      toVectorResult(
        parseRecord(gwUserSpec, `u=${rawEmail}`, {
          hashMode: "edge",
          hashKeys: { edgeKey },
        }),
      ),
    ).toEqual({
      matched: true,
      fields: { u: { status: "ok", type: "string", value: customInner } },
    });
  });

  it("validates entire unix_s exponent before magnitude shortcuts and preserves huge all-zero values", () => {
    expect(parseTimeValue("1e-999999999abc", "unix_s")).toBeNull();
    expect(parseTimeValue("1e+999999999abc", "unix_s")).toBeNull();
    expect(parseTimeValue("0e+999999999", "unix_s")).toBe(0n);
    expect(parseTimeValue("0.000e+999999999999", "unix_s")).toBe(0n);
    expect(parseTimeValue("-0.0e+999999999", "unix_s")).toBe(0n);
    expect(parseTimeValue("1e-999999999", "unix_s")).toBe(0n);
    expect(parseTimeValue("1e+999999999", "unix_s")).toBeNull();
  });
});
