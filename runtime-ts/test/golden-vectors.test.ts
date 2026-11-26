import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkFieldExpectations,
  compileParser,
  parseFixturePayload,
  parseRecord,
  parseTimeValue,
  runVectorCases,
  type ParserSpec,
} from "../src/index.js";

const RUNTIME_DIR = path.resolve(import.meta.dirname, "..");
const CLI_PATH = path.join(RUNTIME_DIR, "dist/cli.js");
const VECTORS_DIR = path.resolve(RUNTIME_DIR, "../spec/vectors");
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

describe("PR #5 golden conformance vector suites (456 vectors across 7 suites)", () => {
  it("loads manifest with exact suite and SQL support counts", () => {
    expect(manifest.schema_version).toBe(1);
    expect(manifest.suites).toHaveLength(7);
    expect(manifest.total_vectors).toBe(456);
    expect(manifest.sql_supported_count).toBe(429);
    expect(manifest.sql_refused_count).toBe(27);
    expect(manifest.suites.reduce((sum, s) => sum + s.count, 0)).toBe(456);
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

  it("passes every embedded spec.tests[] case across all 456 golden vectors", () => {
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

    expect(totalSpecTests).toBe(456);
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
      const allOut = path.join(tmpDir, "all-456.ndjson");
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
      expect(allLines).toHaveLength(456);
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

  it("converts unix_s using exact base-10 decimal arithmetic without binary64 drift", () => {
    expect(parseTimeValue("1.001", "unix_s")).toBe(1001n);
    expect(parseTimeValue("-1.0019", "unix_s")).toBe(-1001n);
    expect(parseTimeValue(0.29, "unix_s")).toBe(290n);
    expect(parseTimeValue("1.5e2", "unix_s")).toBe(150000n);
    expect(parseTimeValue("-0.0009", "unix_s")).toBe(0n);
    expect(parseTimeValue("9223372036854775.807", "unix_s")).toBe(9223372036854775807n);
    expect(parseTimeValue("9223372036854775.808", "unix_s")).toBeNull();
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

  it("preserves already-scrubbed tokens while still executing explicit drop/mask after an in-pipeline hash", () => {
    const hashKeys = { edgeKey: "edge-secret-v1", serverKey: "server-secret-v1" };
    const makeSpec = (
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
          type: "string",
          semantic: "email",
          pii: "email",
          ...(transforms !== undefined ? { transforms } : {}),
        },
      ],
      tests: [],
    });

    // 1. Pre-scrubbed pseudonym token short-circuits drop and mask
    const prescrubDrop = parseRecord(
      makeSpec([{ op: "drop" }]),
      "v=<email:9f2c41d07a3b55e1>",
      { hashKeys },
    );
    expect(prescrubDrop.matched).toBe(true);
    if (prescrubDrop.matched) {
      expect(prescrubDrop.fields["v"]).toMatchObject({
        status: "ok",
        value: "<email:9f2c41d07a3b55e1>",
      });
    }

    const prescrubMask = parseRecord(
      makeSpec([{ op: "mask", mode: "token", kind: "email" }]),
      "v=<hash:9f2c41d07a3b55e1>",
      { hashKeys },
    );
    expect(prescrubMask.matched).toBe(true);
    if (prescrubMask.matched) {
      expect(prescrubMask.fields["v"]).toMatchObject({
        status: "ok",
        value: "<hash:9f2c41d07a3b55e1>",
      });
    }

    // 2. Unknown kind angle-bracket token is NOT treated as pre-scrubbed
    const unknownKind = parseRecord(
      makeSpec([{ op: "drop" }]),
      "v=<unknown:9f2c41d07a3b55e1>",
      { hashKeys },
    );
    expect(unknownKind.matched).toBe(true);
    if (unknownKind.matched) {
      expect(unknownKind.fields["v"]).toMatchObject({ status: "dropped" });
    }

    // 3. Explicit drop/mask after an in-pipeline hash on raw input MUST execute
    const hashThenDrop = parseRecord(
      makeSpec([{ op: "hash", kind: "email" }, { op: "drop" }]),
      "v=alice@example.com",
      { hashKeys },
    );
    expect(hashThenDrop.matched).toBe(true);
    if (hashThenDrop.matched) {
      expect(hashThenDrop.fields["v"]).toMatchObject({ status: "dropped" });
    }

    const hashThenMask = parseRecord(
      makeSpec([
        { op: "hash", kind: "email" },
        { op: "mask", mode: "token", kind: "email" },
      ]),
      "v=alice@example.com",
      { hashKeys },
    );
    expect(hashThenMask.matched).toBe(true);
    if (hashThenMask.matched) {
      expect(hashThenMask.fields["v"]).toMatchObject({
        status: "redacted",
        token: "<email>",
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
});
