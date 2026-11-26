/**
 * Cross-runtime conformance fixture and vector runner (section 17).
 *
 * Accepts:
 *   1. JSON vector suites (`VectorCase[]`, `{ vectors: VectorCase[] }`, `{ cases: VectorCase[] }`)
 *   2. NDJSON vector streams (one `VectorCase` JSON object per non-empty line)
 *   3. Standalone `ParserSpec` JSON files (expanding each entry in `spec.tests[]`)
 *
 * Pure TypeScript with zero Node built-ins; filesystem I/O lives in `cli.ts`.
 */

import type {
  ByteSpan,
  CanonicalResult,
  HashKeys,
  ParserSpec,
  RecordInput,
  RuntimeOptions,
} from "./types.js";
import {
  checkFieldExpectations,
  compareCanonicalResults,
  toCanonicalResult,
  type ExpectedFieldSpec,
} from "./canonical.js";
import { compileParser, type CompiledParser } from "./evaluate.js";
import { isPlainObject } from "./matchers.js";
import { fromHex } from "./utf8.js";

export interface VectorExpectation {
  readonly matched: boolean;
  readonly spans?: Readonly<Record<string, ByteSpan>>;
  readonly fields?: Readonly<Record<string, ExpectedFieldSpec>>;
  /** Optional full canonical result for direct cross-runtime diffing. */
  readonly canonical?: CanonicalResult;
}

export interface VectorCase {
  readonly id: string;
  readonly description?: string;
  readonly spec: ParserSpec;
  readonly input: RecordInput;
  readonly options?: RuntimeOptions;
  readonly expect?: VectorExpectation;
}

export interface CaseCheckOutcome {
  readonly id: string;
  readonly passed: boolean;
  readonly diffs: readonly string[];
}

export interface RunnerReport {
  readonly runtime: "runtime-ts";
  readonly total: number;
  readonly checked: number;
  readonly passed: number;
  readonly failed: number;
  readonly results: readonly CanonicalResult[];
  readonly checks: readonly CaseCheckOutcome[];
}

function parseKeySpec(raw: unknown): Uint8Array | string | undefined {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Uint8Array) {
    return raw;
  }
  if (isPlainObject(raw) && typeof raw["hex"] === "string") {
    const bytes = fromHex(raw["hex"]);
    if (bytes === null) {
      throw new Error(`Invalid hex key: ${raw["hex"]}`);
    }
    return bytes;
  }
  return undefined;
}

function extractOptionsFromRaw(raw: Readonly<Record<string, unknown>>): RuntimeOptions | undefined {
  const hashRaw =
    raw["hashKeys"] ?? raw["hash_keys"] ?? raw["keys"] ??
    (isPlainObject(raw["options"]) ? (raw["options"]["hashKeys"] ?? raw["options"]["hash_keys"]) : undefined);

  let hashKeys: HashKeys | undefined;
  if (isPlainObject(hashRaw)) {
    const edgeKey = parseKeySpec(
      hashRaw["edgeKey"] ?? hashRaw["edge_key"] ?? hashRaw["k_edge"],
    );
    const serverKey = parseKeySpec(
      hashRaw["serverKey"] ?? hashRaw["server_key"] ?? hashRaw["k_server"],
    );
    const edgeHex = typeof hashRaw["edge_key_hex"] === "string"
      ? fromHex(hashRaw["edge_key_hex"]) ?? undefined
      : typeof hashRaw["k_edge_hex"] === "string"
        ? fromHex(hashRaw["k_edge_hex"]) ?? undefined
        : undefined;
    const serverHex = typeof hashRaw["server_key_hex"] === "string"
      ? fromHex(hashRaw["server_key_hex"]) ?? undefined
      : typeof hashRaw["k_server_hex"] === "string"
        ? fromHex(hashRaw["k_server_hex"]) ?? undefined
        : undefined;

    const resolvedEdge = edgeHex ?? edgeKey;
    const resolvedServer = serverHex ?? serverKey;
    if (resolvedEdge !== undefined || resolvedServer !== undefined) {
      hashKeys = {
        ...(resolvedEdge !== undefined ? { edgeKey: resolvedEdge } : {}),
        ...(resolvedServer !== undefined ? { serverKey: resolvedServer } : {}),
      };
    }
  }

  const refYearRaw =
    raw["referenceYear"] ??
    raw["reference_year"] ??
    (isPlainObject(raw["options"])
      ? raw["options"]["referenceYear"] ?? raw["options"]["reference_year"]
      : undefined);
  const referenceYear =
    typeof refYearRaw === "number" && Number.isInteger(refYearRaw)
      ? refYearRaw
      : undefined;

  if (hashKeys === undefined && referenceYear === undefined) {
    return undefined;
  }
  return {
    ...(hashKeys !== undefined ? { hashKeys } : {}),
    ...(referenceYear !== undefined ? { referenceYear } : {}),
  };
}

function extractRecordInput(raw: Readonly<Record<string, unknown>>): RecordInput {
  if ("input" in raw && raw["input"] !== undefined) {
    const inp = raw["input"];
    if (typeof inp === "string" || Array.isArray(inp)) {
      return inp;
    }
    if (isPlainObject(inp)) {
      return inp as RecordInput;
    }
  }
  if (typeof raw["line"] === "string") {
    return { line: raw["line"] };
  }
  if (isPlainObject(raw["object"])) {
    return { object: raw["object"] };
  }
  if (Array.isArray(raw["args"])) {
    const strings = Array.isArray(raw["strings"])
      ? (raw["strings"] as readonly string[])
      : undefined;
    return strings !== undefined ? { strings, args: raw["args"] } : { args: raw["args"] };
  }
  throw new Error("Vector case is missing input (`input`, `line`, `object`, or `args`)");
}

function extractExpectation(raw: Readonly<Record<string, unknown>>): VectorExpectation | undefined {
  const exp = raw["expect"] ?? raw["expected"];
  if (exp === undefined || exp === null) {
    return undefined;
  }
  if (!isPlainObject(exp)) {
    throw new Error("Vector case `expect` must be an object");
  }

  if (typeof exp["matched"] === "boolean") {
    const matched = exp["matched"];
    if (!matched) {
      return { matched: false };
    }
    const spans = isPlainObject(exp["spans"])
      ? (exp["spans"] as Readonly<Record<string, ByteSpan>>)
      : undefined;
    const fields = isPlainObject(exp["fields"])
      ? (exp["fields"] as Readonly<Record<string, ExpectedFieldSpec>>)
      : undefined;

    // Detect if `fields` is already in CanonicalFieldResult shape
    let isCanonical = false;
    if (fields !== undefined) {
      const vals = Object.values(fields);
      if (
        vals.length > 0 &&
        vals.every(
          (v) => {
            if (!isPlainObject(v)) return false;
            const rec = v as Readonly<Record<string, unknown>>;
            return typeof rec["status"] === "string" && typeof rec["type"] === "string";
          },
        )
      ) {
        isCanonical = true;
      }
    }

    if (isCanonical) {
      return {
        matched: true,
        canonical: {
          id: typeof raw["id"] === "string" ? raw["id"] : "case",
          matched: true,
          spans: spans ?? {},
          fields: fields as unknown as Extract<CanonicalResult, { matched: true }>["fields"],
        },
        ...(spans !== undefined ? { spans } : {}),
      };
    }

    return {
      matched: true,
      ...(spans !== undefined ? { spans } : {}),
      ...(fields !== undefined ? { fields } : {}),
    };
  }

  // Plain field expectation map (as in `ParserSpec.tests[].expect`)
  return {
    matched: true,
    fields: exp as Readonly<Record<string, ExpectedFieldSpec>>,
  };
}

function normalizeVectorCase(raw: unknown, index: number, prefix: string): VectorCase {
  if (!isPlainObject(raw)) {
    throw new Error(`Vector case at index ${index} must be an object`);
  }
  if (!isPlainObject(raw["spec"])) {
    throw new Error(`Vector case at index ${index} is missing a "spec" object`);
  }
  const id = typeof raw["id"] === "string" && raw["id"].length > 0
    ? raw["id"]
    : `${prefix}#${index}`;
  const description = typeof raw["description"] === "string" ? raw["description"] : undefined;
  const spec = raw["spec"] as unknown as ParserSpec;
  const input = extractRecordInput(raw);
  const options = extractOptionsFromRaw(raw);
  const expect = extractExpectation(raw);

  return {
    id,
    ...(description !== undefined ? { description } : {}),
    spec,
    input,
    ...(options !== undefined ? { options } : {}),
    ...(expect !== undefined ? { expect } : {}),
  };
}

function expandParserSpecToCases(spec: ParserSpec, prefix: string): VectorCase[] {
  return spec.tests.map((t, idx) => {
    const id = `${spec.template}:v${spec.version}:test#${idx}`;
    let input: RecordInput;
    if ("line" in t) {
      input = { line: t.line };
    } else if ("object" in t) {
      input = { object: t.object };
    } else {
      input = { args: t.args };
    }
    return {
      id: prefix ? `${prefix}:${id}` : id,
      ...(t.description !== undefined ? { description: t.description } : {}),
      spec,
      input,
      expect: {
        matched: true,
        fields: t.expect,
      },
    };
  });
}

function isParserSpecObject(val: unknown): val is ParserSpec {
  return (
    isPlainObject(val) &&
    val["spec_version"] === 1 &&
    typeof val["template"] === "string" &&
    isPlainObject(val["match"]) &&
    Array.isArray(val["fields"]) &&
    Array.isArray(val["tests"])
  );
}

/**
 * Parses a JSON or NDJSON fixture/vector payload into normalized `VectorCase[]`.
 */
export function parseFixturePayload(rawText: string, sourceName = "fixture"): VectorCase[] {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return [];
  }

  // Try standard JSON first
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map((item, idx) => normalizeVectorCase(item, idx, sourceName));
    }
    if (isParserSpecObject(parsed)) {
      return expandParserSpecToCases(parsed, sourceName);
    }
    if (isPlainObject(parsed)) {
      if (Array.isArray(parsed["vectors"])) {
        const suiteOpts = extractOptionsFromRaw(parsed);
        return parsed["vectors"].map((item, idx) => {
          const c = normalizeVectorCase(item, idx, sourceName);
          if (suiteOpts === undefined) return c;
          return {
            ...c,
            options: mergeOptions(suiteOpts, c.options),
          };
        });
      }
      if (Array.isArray(parsed["cases"])) {
        const suiteOpts = extractOptionsFromRaw(parsed);
        return parsed["cases"].map((item, idx) => {
          const c = normalizeVectorCase(item, idx, sourceName);
          if (suiteOpts === undefined) return c;
          return {
            ...c,
            options: mergeOptions(suiteOpts, c.options),
          };
        });
      }
      return [normalizeVectorCase(parsed, 0, sourceName)];
    }
    throw new Error(`Unsupported JSON fixture root in ${sourceName}`);
  } catch (jsonErr) {
    // Fall back to NDJSON (one JSON case per non-empty line)
    const lines = trimmed.split("\n");
    if (lines.length <= 1) {
      throw jsonErr;
    }
    const cases: VectorCase[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line.length === 0) continue;
      const item: unknown = JSON.parse(line);
      if (isParserSpecObject(item)) {
        cases.push(...expandParserSpecToCases(item, `${sourceName}:L${i + 1}`));
      } else {
        cases.push(normalizeVectorCase(item, cases.length, sourceName));
      }
    }
    return cases;
  }
}

function mergeOptions(
  base?: RuntimeOptions,
  override?: RuntimeOptions,
): RuntimeOptions {
  if (base === undefined) return override ?? {};
  if (override === undefined) return base;
  const edgeKey = override.hashKeys?.edgeKey ?? base.hashKeys?.edgeKey;
  const serverKey = override.hashKeys?.serverKey ?? base.hashKeys?.serverKey;
  const referenceYear = override.referenceYear ?? base.referenceYear;
  return {
    ...(edgeKey !== undefined || serverKey !== undefined
      ? {
          hashKeys: {
            ...(edgeKey !== undefined ? { edgeKey } : {}),
            ...(serverKey !== undefined ? { serverKey } : {}),
          },
        }
      : {}),
    ...(referenceYear !== undefined ? { referenceYear } : {}),
  };
}

/**
 * Executes a list of `VectorCase` items and returns section 17 canonical results
 * along with expectation verification outcomes.
 */
export function runVectorCases(
  cases: readonly VectorCase[],
  defaultOptions?: RuntimeOptions,
): RunnerReport {
  const compilerCache = new WeakMap<ParserSpec, CompiledParser>();
  const results: CanonicalResult[] = [];
  const checks: CaseCheckOutcome[] = [];
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    let parser = compilerCache.get(c.spec);
    if (parser === undefined) {
      parser = compileParser(c.spec);
      compilerCache.set(c.spec, parser);
    }

    const opts = mergeOptions(defaultOptions, c.options);
    const parseRes = parser.parse(c.input, opts);
    const canonical = toCanonicalResult(c.id, parseRes);
    results.push(canonical);

    if (c.expect !== undefined) {
      let diffs: string[] = [];
      if (c.expect.canonical !== undefined) {
        diffs = compareCanonicalResults(
          canonical,
          c.expect.canonical,
          c.expect.spans !== undefined,
        );
      } else if (!c.expect.matched) {
        if (canonical.matched) {
          diffs = ["expected matched=false, but record matched"];
        }
      } else {
        if (!canonical.matched) {
          diffs = ["expected matched=true, but got matched=false"];
        } else {
          if (c.expect.spans !== undefined) {
            for (const [k, expSpan] of Object.entries(c.expect.spans)) {
              const actSpan = canonical.spans[k];
              if (
                actSpan === undefined ||
                actSpan.start !== expSpan.start ||
                actSpan.end !== expSpan.end
              ) {
                diffs.push(
                  `span "${k}": mismatch (actual=${JSON.stringify(actSpan)}, expected=${JSON.stringify(expSpan)})`,
                );
              }
            }
          }
          if (c.expect.fields !== undefined) {
            diffs.push(...checkFieldExpectations(c.spec, parseRes, c.expect.fields));
          }
        }
      }

      if (diffs.length === 0) {
        passed++;
        checks.push({ id: c.id, passed: true, diffs: [] });
      } else {
        failed++;
        checks.push({ id: c.id, passed: false, diffs });
      }
    }
  }

  return {
    runtime: "runtime-ts",
    total: cases.length,
    checked: checks.length,
    passed,
    failed,
    results,
    checks,
  };
}

/**
 * Formats canonical results as either pretty JSON or NDJSON for cross-runtime diffing.
 */
export function formatCanonicalResults(
  results: readonly CanonicalResult[],
  format: "json" | "ndjson" = "json",
): string {
  if (format === "ndjson") {
    return results.map((r) => JSON.stringify(r)).join("\n") + (results.length > 0 ? "\n" : "");
  }
  return JSON.stringify(results, null, 2) + "\n";
}
