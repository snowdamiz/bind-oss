import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareCanonicalResults,
  compileParser,
  formatCanonicalResults,
  parseFixturePayload,
  runVectorCases,
  type CanonicalResult,
  type ParserSpec,
  type TextSegment,
} from "../src/index.js";

const RUNTIME_DIR = path.resolve(import.meta.dirname, "..");
const CLI_PATH = path.join(RUNTIME_DIR, "dist/cli.js");
const SECTION5_JSON = path.resolve(
  RUNTIME_DIR,
  "../spec/fixtures/valid/parser-spec-section5-text.json",
);

describe("cross-runtime conformance runner & CLI", () => {
  const sampleSpec: ParserSpec = {
    spec_version: 1,
    template: "tpl_01RUNNER01",
    event: "order.paid",
    version: 1,
    status: "active",
    origin: "agent",
    source: { kind: "mined" },
    match: {
      kind: "text",
      segments: [
        { lit: "order " },
        { hole: "id", class: "word" },
        { lit: " paid " },
        { hole: "cents", class: "int" },
      ],
    },
    fields: [
      { id: "fld_0001", name: "order_id", from: { hole: "id" }, type: "string", semantic: "id.order" },
      {
        id: "fld_0002",
        name: "amount_usd",
        from: { hole: "cents" },
        type: "float",
        semantic: "money",
        transforms: [{ op: "scale", div: 100 }],
      },
    ],
    tests: [],
  };

  it("supports JSON array, wrapped { vectors }, and NDJSON vector files", () => {
    const vec1 = {
      id: "vec-match",
      spec: sampleSpec,
      input: { line: "order ord_1 paid 1999" },
      expect: {
        matched: true,
        spans: { id: { start: 6, end: 11 }, cents: { start: 17, end: 21 } },
        fields: {
          order_id: "ord_1",
          amount_usd: { float_hex: "4033fd70a3d70a3d" },
        },
      },
    };
    const vec2 = {
      id: "vec-nomatch",
      spec: sampleSpec,
      input: { line: "unrelated line" },
      expect: { matched: false },
    };

    const ndjson = `${JSON.stringify(vec1)}\n${JSON.stringify(vec2)}\n`;
    const cases = parseFixturePayload(ndjson, "suite.jsonl");
    const report = runVectorCases(cases);
    expect(report.total).toBe(2);
    expect(report.checked).toBe(2);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(0);

    const formatted = formatCanonicalResults(report.results, "ndjson");
    const parsedLines = formatted
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as CanonicalResult);
    expect(parsedLines).toHaveLength(2);
    expect(compareCanonicalResults(parsedLines[0]!, report.results[0]!)).toEqual([]);
    expect(compareCanonicalResults(parsedLines[1]!, { id: "vec-nomatch", matched: false })).toEqual([]);
  });

  it("executes the compiled CLI runner with --input, --output, --format, and --check", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-runtime-ts-"));
    const outPath = path.join(tmpDir, "results.jsonl");
    try {
      execFileSync(
        process.execPath,
        [CLI_PATH, "--input", SECTION5_JSON, "--output", outPath, "--format", "ndjson", "--check"],
        { encoding: "utf8" },
      );

      const outText = fs.readFileSync(outPath, "utf8").trim();
      const rec = JSON.parse(outText) as CanonicalResult;
      expect(rec.matched).toBe(true);
      if (rec.matched) {
        expect(rec.fields["amount_usd"]).toEqual({
          status: "ok",
          type: "float",
          value_hex: "4033fd70a3d70a3d",
        });
      }

      // Deliberately failing expectation exits with status 1
      const badFile = path.join(tmpDir, "bad.json");
      fs.writeFileSync(
        badFile,
        JSON.stringify([
          {
            id: "should-fail",
            spec: sampleSpec,
            input: { line: "order ord_1 paid 1999" },
            expect: { matched: true, fields: { amount_usd: 20.0 } },
          },
        ]),
      );
      let exitStatus = 0;
      try {
        execFileSync(process.execPath, [CLI_PATH, "--input", badFile, "--check"], {
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch (err) {
        exitStatus = (err as { status?: number }).status ?? -1;
      }
      expect(exitStatus).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("linear-time 64 KiB bound & runtime invariants", () => {
  it("parses a 64 KiB adversarial record with 200 until holes in strictly linear time", () => {
    const holeCount = 200;
    const segments: TextSegment[] = [];
    for (let i = 0; i < holeCount; i++) {
      segments.push({ hole: `h${i}`, class: "until" });
      segments.push({ lit: `|k${i}=` });
    }
    segments.push({ hole: "tail", class: "rest" });

    const spec: ParserSpec = {
      spec_version: 1,
      template: "tpl_01PERF64K",
      event: "perf.linear",
      version: 1,
      status: "active",
      origin: "user",
      source: { kind: "mined" },
      match: { kind: "text", segments },
      fields: [
        { id: "fld_0001", name: "first", from: { hole: "h0" }, type: "string", semantic: "text" },
        { id: "fld_0002", name: "tail", from: { hole: "tail" }, type: "string", semantic: "text" },
      ],
      tests: [],
    };

    const compiled = compileParser(spec);

    // 1. Matching 64 KiB line
    const padChunk = "a".repeat(330);
    let matchLine = "";
    for (let i = 0; i < holeCount; i++) {
      matchLine += `${padChunk}|k${i}=`;
    }
    matchLine += "done";
    expect(Buffer.byteLength(matchLine, "utf8")).toBeGreaterThan(64 * 1024);

    const t0 = performance.now();
    const res = compiled.parse(matchLine);
    const matchMs = performance.now() - t0;
    expect(res.matched).toBe(true);
    expect(matchMs).toBeLessThan(100);

    // 2. Adversarial non-matching 64 KiB line (missing final delimiter after 199 matches)
    const noMatchLine = "a".repeat(65536);
    const t1 = performance.now();
    const res2 = compiled.parse(noMatchLine);
    const noMatchMs = performance.now() - t1;
    expect(res2.matched).toBe(false);
    expect(noMatchMs).toBeLessThan(100);
  });

  it("keeps runtime dependency-free and free of RegExp in src/", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(RUNTIME_DIR, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies).toBeUndefined();

    const srcDir = path.join(RUNTIME_DIR, "src");
    for (const file of fs.readdirSync(srcDir)) {
      if (!file.endsWith(".ts")) continue;
      const content = fs.readFileSync(path.join(srcDir, file), "utf8");
      expect(content, `${file} must not instantiate RegExp`).not.toContain("new RegExp");
      expect(content, `${file} must not use RegExp.prototype`).not.toContain("RegExp(");
      if (file !== "cli.ts") {
        expect(content, `core runtime ${file} must not import node: built-ins`).not.toContain(
          '"node:',
        );
      }
    }
  });
});
