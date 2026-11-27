/**
 * Cross-runtime conformance fixture and vector runner (section 17).
 *
 * Accepts:
 *   1. Golden vector suites (`spec/vectors/vector.schema.json`: `{ schema_version: 1, suite, context, vectors }`)
 *   2. Generic JSON vector payloads (`VectorCase[]`, `{ vectors: VectorCase[] }`, `{ cases: VectorCase[] }`)
 *   3. NDJSON vector streams (one `VectorCase` JSON object per non-empty line)
 *   4. Standalone `ParserSpec` JSON files (expanding each entry in `spec.tests[]`)
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
  VectorExpectedResult,
  VectorFieldResult,
  VectorSqlExpectation,
} from "./types.js";
import {
  checkFieldExpectations,
  compareCanonicalResults,
  compareVectorResults,
  stringifyVectorJson,
  toCanonicalResult,
  toVectorResult,
  type ExpectedFieldSpec,
} from "./canonical.js";
import { compileParser, type CompiledParser } from "./evaluate.js";
import { isPlainObject } from "./matchers.js";
import { fromHex, toSafeIntOrBigInt } from "./utf8.js";

export interface VectorExpectation {
  readonly matched: boolean;
  readonly spans?: Readonly<Record<string, ByteSpan>>;
  readonly fields?: Readonly<Record<string, ExpectedFieldSpec>>;
  /** Optional full canonical result for direct cross-runtime diffing. */
  readonly canonical?: CanonicalResult;
  /** Exact `spec/vectors/vector.schema.json` `ExpectedResult` envelope. */
  readonly vectorExpected?: VectorExpectedResult;
}

export interface VectorCase {
  readonly id: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly sql?: VectorSqlExpectation;
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

export interface VectorResultEntry {
  readonly id: string;
  readonly result: VectorExpectedResult;
}

export interface RunnerReport {
  readonly runtime: "runtime-ts";
  readonly total: number;
  readonly checked: number;
  readonly passed: number;
  readonly failed: number;
  readonly results: readonly CanonicalResult[];
  readonly vectorResults: readonly VectorResultEntry[];
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

function extractOptionsFromRaw(
  raw: Readonly<Record<string, unknown>>,
): RuntimeOptions | undefined {
  const ctxObj = isPlainObject(raw["context"]) ? raw["context"] : undefined;
  const optsObj = isPlainObject(raw["options"]) ? raw["options"] : undefined;

  const hashRaw =
    raw["hashKeys"] ??
    raw["hash_keys"] ??
    raw["hmac_keys"] ??
    raw["keys"] ??
    (ctxObj !== undefined
      ? (ctxObj["hmac_keys"] ?? ctxObj["hashKeys"] ?? ctxObj["hash_keys"])
      : undefined) ??
    (optsObj !== undefined
      ? (optsObj["hashKeys"] ?? optsObj["hash_keys"] ?? optsObj["hmac_keys"])
      : undefined);

  let hashKeys: HashKeys | undefined;
  if (isPlainObject(hashRaw)) {
    const edgeKey = parseKeySpec(
      hashRaw["edgeKey"] ?? hashRaw["edge_key"] ?? hashRaw["k_edge"] ?? hashRaw["edge"],
    );
    const serverKey = parseKeySpec(
      hashRaw["serverKey"] ?? hashRaw["server_key"] ?? hashRaw["k_server"] ?? hashRaw["server"],
    );
    const edgeHex =
      typeof hashRaw["edge_key_hex"] === "string"
        ? (fromHex(hashRaw["edge_key_hex"]) ?? undefined)
        : typeof hashRaw["k_edge_hex"] === "string"
          ? (fromHex(hashRaw["k_edge_hex"]) ?? undefined)
          : undefined;
    const serverHex =
      typeof hashRaw["server_key_hex"] === "string"
        ? (fromHex(hashRaw["server_key_hex"]) ?? undefined)
        : typeof hashRaw["k_server_hex"] === "string"
          ? (fromHex(hashRaw["k_server_hex"]) ?? undefined)
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
    (optsObj !== undefined ? (optsObj["referenceYear"] ?? optsObj["reference_year"]) : undefined);
  const referenceYear =
    typeof refYearRaw === "number" && Number.isInteger(refYearRaw)
      ? refYearRaw
      : undefined;

  const refTsRaw =
    raw["referenceTsMs"] ??
    raw["reference_ts_ms"] ??
    (ctxObj !== undefined ? (ctxObj["reference_ts_ms"] ?? ctxObj["referenceTsMs"]) : undefined) ??
    (optsObj !== undefined ? (optsObj["referenceTsMs"] ?? optsObj["reference_ts_ms"]) : undefined);
  const referenceTsMs =
    typeof refTsRaw === "number" && Number.isFinite(refTsRaw)
      ? refTsRaw
      : undefined;

  if (hashKeys === undefined && referenceYear === undefined && referenceTsMs === undefined) {
    return undefined;
  }
  return {
    ...(hashKeys !== undefined ? { hashKeys } : {}),
    ...(referenceYear !== undefined ? { referenceYear } : {}),
    ...(referenceTsMs !== undefined ? { referenceTsMs } : {}),
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

function isVectorFieldResultShape(v: unknown): v is VectorFieldResult {
  if (!isPlainObject(v)) return false;
  const status = v["status"];
  if (status === "ok") {
    const type = v["type"];
    if (typeof type !== "string") return false;
    // CanonicalFieldResult uses `value_hex` for float and `utf8_hex` for string/enum;
    // `spec/vectors/vector.schema.json` uses `{ status: "ok", type, value }` only.
    if ("value_hex" in v || "utf8_hex" in v) return false;
    return "value" in v;
  }
  if (status === "redacted") {
    return typeof v["token"] === "string" && !("type" in v);
  }
  if (status === "dropped" || status === "missing") {
    return !("type" in v);
  }
  if (status === "parse_error") {
    return typeof v["code"] === "string" && !("type" in v);
  }
  return false;
}

function isCanonicalFieldResultShape(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  const status = v["status"];
  const type = v["type"];
  if (typeof status !== "string" || typeof type !== "string") return false;
  if (status === "ok") {
    if (type === "float") return typeof v["value_hex"] === "string";
    if (type === "string" || type === "enum") return typeof v["utf8_hex"] === "string";
    return "value" in v;
  }
  return status === "redacted" || status === "dropped" || status === "missing" || status === "error";
}

function extractExpectation(raw: Readonly<Record<string, unknown>>): VectorExpectation | undefined {
  const hasExpectedKey = "expected" in raw && raw["expected"] !== undefined && raw["expected"] !== null;
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
      return {
        matched: false,
        ...(hasExpectedKey ? { vectorExpected: { matched: false } } : {}),
      };
    }
    const spans = isPlainObject(exp["spans"])
      ? (exp["spans"] as Readonly<Record<string, ByteSpan>>)
      : undefined;
    const fields = isPlainObject(exp["fields"])
      ? (exp["fields"] as Readonly<Record<string, unknown>>)
      : undefined;

    if (fields !== undefined) {
      const vals = Object.values(fields);

      // Exact `spec/vectors/vector.schema.json` ExpectedMatch envelope
      const isVectorEnvelope =
        spans === undefined &&
        ((vals.length > 0 && vals.every((v) => isVectorFieldResultShape(v))) ||
          (vals.length === 0 && hasExpectedKey));

      if (isVectorEnvelope) {
        return {
          matched: true,
          vectorExpected: {
            matched: true,
            fields: fields as Readonly<Record<string, VectorFieldResult>>,
          },
        };
      }

      // Detailed `CanonicalResult` format
      if (vals.length > 0 && vals.every((v) => isCanonicalFieldResultShape(v))) {
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
    }

    return {
      matched: true,
      ...(spans !== undefined ? { spans } : {}),
      ...(fields !== undefined
        ? { fields: fields as Readonly<Record<string, ExpectedFieldSpec>> }
        : {}),
    };
  }

  // Plain field expectation map (as in `ParserSpec.tests[].expect`)
  return {
    matched: true,
    fields: exp as Readonly<Record<string, ExpectedFieldSpec>>,
  };
}

function extractSqlExpectation(raw: Readonly<Record<string, unknown>>): VectorSqlExpectation | undefined {
  const sql = raw["sql"];
  if (!isPlainObject(sql) || typeof sql["supported"] !== "boolean") {
    return undefined;
  }
  if (sql["supported"]) {
    return { supported: true };
  }
  return {
    supported: false,
    refusal_code: typeof sql["refusal_code"] === "string" ? sql["refusal_code"] : "unsupported",
    reason: typeof sql["reason"] === "string" ? sql["reason"] : "",
  };
}

function normalizeVectorCase(raw: unknown, index: number, prefix: string): VectorCase {
  if (!isPlainObject(raw)) {
    throw new Error(`Vector case at index ${index} must be an object`);
  }
  if (!isPlainObject(raw["spec"])) {
    throw new Error(`Vector case at index ${index} is missing a "spec" object`);
  }
  const id =
    typeof raw["id"] === "string" && raw["id"].length > 0 ? raw["id"] : `${prefix}#${index}`;
  const description = typeof raw["description"] === "string" ? raw["description"] : undefined;
  const tags = Array.isArray(raw["tags"])
    ? (raw["tags"].filter((t): t is string => typeof t === "string") as readonly string[])
    : undefined;
  const sql = extractSqlExpectation(raw);
  const spec = raw["spec"] as unknown as ParserSpec;
  const input = extractRecordInput(raw);
  const options = extractOptionsFromRaw(raw);
  const expect = extractExpectation(raw);

  return {
    id,
    ...(description !== undefined ? { description } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(sql !== undefined ? { sql } : {}),
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
 * Parses a JSON or NDJSON fixture/vector payload (including `spec/vectors/vector.schema.json`
 * suites) into normalized `VectorCase[]`.
 */
function isJsonWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isJsonNumberChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2d ||
    code === 0x2b ||
    code === 0x2e ||
    code === 0x65 ||
    code === 0x45
  );
}

function setJsonProp(obj: Record<string, unknown>, key: string, val: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, {
      value: val,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    obj[key] = val;
  }
}

/**
 * Parses a JSON fixture string while preserving exact decimal/exponent semantics
 * (and rejecting fractional values) for expected timestamp numbers across both
 * vector `expected.fields.<name>` envelopes and standalone `ParserSpec.tests[].expect`
 * / plain `expect` maps. Pure ES2022 (Node 20 compatible, no `JSON.parse` `context.source`).
 */
function parseJsonPreservingUnsafeTimestampInts(raw: string): unknown {
  const fast: unknown = JSON.parse(raw);
  if (!raw.includes("timestamp") && !raw.includes("\\u")) {
    return fast;
  }

  const len = raw.length;
  let pos = 0;
  const expectRawNums = new WeakMap<Record<string, unknown>, Map<string, string>>();

  function skipWs(): void {
    while (pos < len && isJsonWhitespace(raw.charCodeAt(pos))) {
      pos++;
    }
  }

  function parseString(): string {
    const start = pos;
    pos++; // opening quote
    while (pos < len) {
      const ch = raw.charCodeAt(pos);
      if (ch === 0x5c) {
        pos += 2;
        continue;
      }
      if (ch === 0x22) {
        pos++;
        return JSON.parse(raw.slice(start, pos)) as string;
      }
      pos++;
    }
    throw new SyntaxError("Unterminated JSON string");
  }

  function parseExactJsonTimestampNumber(
    lexeme: string,
  ):
    | { readonly kind: "int"; readonly value: bigint }
    | { readonly kind: "huge_int"; readonly negative: boolean }
    | { readonly kind: "fractional" } {
    let p = 0;
    let negative = false;
    if (lexeme.charCodeAt(p) === 0x2d) {
      negative = true;
      p++;
    }
    const intStart = p;
    while (p < lexeme.length) {
      const c = lexeme.charCodeAt(p);
      if (c < 0x30 || c > 0x39) break;
      p++;
    }
    const intPart = lexeme.slice(intStart, p);

    let fracPart = "";
    if (p < lexeme.length && lexeme.charCodeAt(p) === 0x2e) {
      p++;
      const fracStart = p;
      while (p < lexeme.length) {
        const c = lexeme.charCodeAt(p);
        if (c < 0x30 || c > 0x39) break;
        p++;
      }
      fracPart = lexeme.slice(fracStart, p);
    }

    let exp = 0;
    let expOverflowSign = 0;
    if (p < lexeme.length && (lexeme.charCodeAt(p) === 0x65 || lexeme.charCodeAt(p) === 0x45)) {
      p++;
      let expSign = 1;
      if (p < lexeme.length) {
        const ec = lexeme.charCodeAt(p);
        if (ec === 0x2d) {
          expSign = -1;
          p++;
        } else if (ec === 0x2b) {
          p++;
        }
      }
      let expNz = p;
      while (expNz < lexeme.length && lexeme.charCodeAt(expNz) === 0x30) {
        expNz++;
      }
      const expDigits = lexeme.slice(expNz);
      if (expDigits.length === 0) {
        exp = 0;
      } else if (expDigits.length > 8) {
        expOverflowSign = expSign;
      } else {
        exp = expSign * Number(expDigits);
      }
    }

    const combined = intPart + fracPart;
    let firstNz = 0;
    while (firstNz < combined.length && combined.charCodeAt(firstNz) === 0x30) {
      firstNz++;
    }
    if (firstNz === combined.length) {
      return { kind: "int", value: 0n };
    }
    let lastNz = combined.length - 1;
    while (lastNz > firstNz && combined.charCodeAt(lastNz) === 0x30) {
      lastNz--;
    }
    const sigDigits = combined.slice(firstNz, lastNz + 1);
    const trailingZeros = combined.length - 1 - lastNz;

    if (expOverflowSign < 0) {
      return { kind: "fractional" };
    }
    if (expOverflowSign > 0) {
      return { kind: "huge_int", negative };
    }
    const lsdExp = exp - fracPart.length + trailingZeros;
    if (lsdExp < 0) {
      return { kind: "fractional" };
    }
    if (sigDigits.length + lsdExp > 25) {
      return { kind: "huge_int", negative };
    }
    return {
      kind: "int",
      value: BigInt((negative ? "-" : "") + sigDigits + "0".repeat(lsdExp)),
    };
  }

  function applyExactTimestampLexeme(
    obj: Record<string, unknown>,
    key: string,
    rawLexeme: string,
  ): void {
    const exact = parseExactJsonTimestampNumber(rawLexeme);
    if (exact.kind === "int") {
      setJsonProp(obj, key, toSafeIntOrBigInt(exact.value));
    } else if (exact.kind === "huge_int") {
      setJsonProp(obj, key, exact.negative ? -(10n ** 30n) : 10n ** 30n);
    } else {
      const num = obj[key];
      setJsonProp(
        obj,
        key,
        typeof num === "number" && Number.isInteger(num) ? Number.NaN : num,
      );
    }
  }

  function parseNumberWithRaw(): { readonly value: number; readonly rawNum?: string } {
    const start = pos;
    if (pos < len && raw.charCodeAt(pos) === 0x2d) {
      pos++;
    }
    while (pos < len && isJsonNumberChar(raw.charCodeAt(pos))) {
      pos++;
    }
    const lexeme = raw.slice(start, pos);
    return { value: Number(lexeme), rawNum: lexeme };
  }

  function parseArray(expectDepth: number): unknown[] {
    pos++; // opening bracket
    skipWs();
    const arr: unknown[] = [];
    if (pos < len && raw.charCodeAt(pos) === 0x5d) {
      pos++;
      return arr;
    }
    const childDepth = expectDepth === 0 ? 0 : -1;
    while (pos < len) {
      arr.push(parseValue(childDepth).value);
      skipWs();
      if (pos < len && raw.charCodeAt(pos) === 0x2c) {
        pos++;
        skipWs();
        continue;
      }
      if (pos < len && raw.charCodeAt(pos) === 0x5d) {
        pos++;
        return arr;
      }
      throw new SyntaxError(`Unexpected token in JSON array at ${pos}`);
    }
    throw new SyntaxError("Unterminated JSON array");
  }

  function parseObject(expectDepth: number): Record<string, unknown> {
    pos++; // opening brace
    skipWs();
    const obj: Record<string, unknown> = {};
    if (pos < len && raw.charCodeAt(pos) === 0x7d) {
      pos++;
      return obj;
    }
    let rawValueNum: string | undefined;
    let plainRawNums: Map<string, string> | undefined;
    while (pos < len) {
      const key = parseString();
      skipWs();
      if (pos >= len || raw.charCodeAt(pos) !== 0x3a) {
        throw new SyntaxError(`Expected colon in JSON object at ${pos}`);
      }
      pos++; // colon
      skipWs();
      let nextDepth = -1;
      if (expectDepth === 0) {
        if (key === "expected" || key === "expect") {
          nextDepth = 1;
        } else if (key === "vectors" || key === "cases" || key === "tests" || key === "spec") {
          nextDepth = 0;
        }
      } else if (expectDepth === 1) {
        nextDepth = key === "fields" ? 2 : -1;
      } else if (expectDepth === 2) {
        nextDepth = 3;
      }
      const valRes = parseValue(nextDepth);
      setJsonProp(obj, key, valRes.value);
      if (expectDepth === 3 && key === "value") {
        rawValueNum = valRes.rawNum;
      } else if (expectDepth === 1 || expectDepth === 2) {
        if (valRes.rawNum !== undefined) {
          if (plainRawNums === undefined) {
            plainRawNums = new Map<string, string>();
          }
          plainRawNums.set(key, valRes.rawNum);
        } else if (plainRawNums !== undefined) {
          plainRawNums.delete(key);
        }
      }
      skipWs();
      if (pos < len && raw.charCodeAt(pos) === 0x2c) {
        pos++;
        skipWs();
        continue;
      }
      if (pos < len && raw.charCodeAt(pos) === 0x7d) {
        pos++;
        if (
          expectDepth === 3 &&
          rawValueNum !== undefined &&
          obj["status"] === "ok" &&
          obj["type"] === "timestamp" &&
          Object.keys(obj).length === 3
        ) {
          applyExactTimestampLexeme(obj, "value", rawValueNum);
        } else if ((expectDepth === 1 || expectDepth === 2) && plainRawNums !== undefined && plainRawNums.size > 0) {
          expectRawNums.set(obj, plainRawNums);
        }
        return obj;
      }
      throw new SyntaxError(`Unexpected token in JSON object at ${pos}`);
    }
    throw new SyntaxError("Unterminated JSON object");
  }

  function parseValue(expectDepth: number): { readonly value: unknown; readonly rawNum?: string } {
    skipWs();
    if (pos >= len) {
      throw new SyntaxError("Unexpected end of JSON input");
    }
    const ch = raw.charCodeAt(pos);
    if (ch === 0x7b) return { value: parseObject(expectDepth) };
    if (ch === 0x5b) return { value: parseArray(expectDepth) };
    if (ch === 0x22) return { value: parseString() };
    if (ch === 0x74) {
      pos += 4;
      return { value: true };
    }
    if (ch === 0x66) {
      pos += 5;
      return { value: false };
    }
    if (ch === 0x6e) {
      pos += 4;
      return { value: null };
    }
    return parseNumberWithRaw();
  }

  function collectTimestampFieldNames(spec: unknown): ReadonlySet<string> | null {
    if (!isPlainObject(spec) || !Array.isArray(spec["fields"])) {
      return null;
    }
    let names: Set<string> | null = null;
    for (let i = 0; i < spec["fields"].length; i++) {
      const f = spec["fields"][i];
      if (isPlainObject(f) && f["type"] === "timestamp" && typeof f["name"] === "string") {
        if (names === null) {
          names = new Set<string>();
        }
        names.add(f["name"]);
      }
    }
    return names;
  }

  function applyPlainExpectTimestampNums(
    expectObj: unknown,
    tsFields: ReadonlySet<string>,
  ): void {
    if (!isPlainObject(expectObj)) return;
    const rawNums = expectRawNums.get(expectObj);
    if (rawNums === undefined) return;
    for (const [fieldName, lexeme] of rawNums) {
      if (tsFields.has(fieldName)) {
        applyExactTimestampLexeme(expectObj, fieldName, lexeme);
      }
    }
  }

  function applyPlainExpectations(root: unknown): void {
    if (Array.isArray(root)) {
      for (let i = 0; i < root.length; i++) {
        applyPlainExpectations(root[i]);
      }
      return;
    }
    if (!isPlainObject(root)) return;

    if (isParserSpecObject(root)) {
      const tsFields = collectTimestampFieldNames(root);
      if (tsFields !== null) {
        for (let i = 0; i < root.tests.length; i++) {
          const t = root.tests[i];
          if (isPlainObject(t)) {
            applyPlainExpectTimestampNums(t["expect"], tsFields);
          }
        }
      }
      return;
    }

    const list = Array.isArray(root["vectors"])
      ? root["vectors"]
      : Array.isArray(root["cases"])
        ? root["cases"]
        : undefined;
    if (list !== undefined) {
      for (let i = 0; i < list.length; i++) {
        applyPlainExpectations(list[i]);
      }
      return;
    }

    if (isParserSpecObject(root["spec"])) {
      applyPlainExpectations(root["spec"]);
    }
    const tsFields = collectTimestampFieldNames(root["spec"]);
    if (tsFields !== null) {
      const exp = root["expect"] ?? root["expected"];
      if (isPlainObject(exp)) {
        if (typeof exp["matched"] === "boolean") {
          if (isPlainObject(exp["fields"])) {
            applyPlainExpectTimestampNums(exp["fields"], tsFields);
          }
        } else {
          applyPlainExpectTimestampNums(exp, tsFields);
        }
      }
    }
  }

  const parsedRoot = parseValue(0).value;
  applyPlainExpectations(parsedRoot);
  return parsedRoot;
}

export function parseFixturePayload(rawText: string, sourceName = "fixture"): VectorCase[] {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return [];
  }

  // Try standard JSON first
  try {
    const parsed: unknown = parseJsonPreservingUnsafeTimestampInts(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map((item, idx) => normalizeVectorCase(item, idx, sourceName));
    }
    if (isParserSpecObject(parsed)) {
      return expandParserSpecToCases(parsed, sourceName);
    }
    if (isPlainObject(parsed)) {
      const list = Array.isArray(parsed["vectors"])
        ? parsed["vectors"]
        : Array.isArray(parsed["cases"])
          ? parsed["cases"]
          : undefined;
      if (list !== undefined) {
        const suiteOpts = extractOptionsFromRaw(parsed);
        const suitePrefix =
          typeof parsed["suite"] === "string" && parsed["suite"].length > 0
            ? parsed["suite"]
            : sourceName;
        return list.map((item, idx) => {
          const c = normalizeVectorCase(item, idx, suitePrefix);
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
      const item: unknown = parseJsonPreservingUnsafeTimestampInts(line);
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
  const hashMode = override.hashMode ?? base.hashMode;
  const referenceYear = override.referenceYear ?? base.referenceYear;
  const referenceTsMs = override.referenceTsMs ?? base.referenceTsMs;
  return {
    ...(edgeKey !== undefined || serverKey !== undefined
      ? {
          hashKeys: {
            ...(edgeKey !== undefined ? { edgeKey } : {}),
            ...(serverKey !== undefined ? { serverKey } : {}),
          },
        }
      : {}),
    ...(hashMode !== undefined ? { hashMode } : {}),
    ...(referenceYear !== undefined ? { referenceYear } : {}),
    ...(referenceTsMs !== undefined ? { referenceTsMs } : {}),
  };
}

export interface RunVectorCasesOptions {
  /** Also enforce diagnostic `parse_error.code` equality when checking golden vectors. */
  readonly checkErrorCode?: boolean;
}

/**
 * Executes a list of `VectorCase` items and returns section 17 canonical results
 * along with expectation verification outcomes.
 */
export function runVectorCases(
  cases: readonly VectorCase[],
  defaultOptions?: RuntimeOptions,
  runOptions: RunVectorCasesOptions = {},
): RunnerReport {
  const compilerCache = new WeakMap<ParserSpec, CompiledParser>();
  const results: CanonicalResult[] = [];
  const vectorResults: VectorResultEntry[] = [];
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
    const vecRes = toVectorResult(parseRes);
    results.push(canonical);
    vectorResults.push({ id: c.id, result: vecRes });

    if (c.expect !== undefined) {
      let diffs: string[] = [];
      if (c.expect.vectorExpected !== undefined) {
        diffs = compareVectorResults(vecRes, c.expect.vectorExpected, {
          ...(runOptions.checkErrorCode !== undefined
            ? { checkErrorCode: runOptions.checkErrorCode }
            : {}),
        });
      } else if (c.expect.canonical !== undefined) {
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
    vectorResults,
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

/**
 * Formats section 17 golden vector results (`spec/vectors/vector.schema.json` `ExpectedResult`)
 * keyed by vector `id`.
 */
export function formatVectorResults(
  entries: readonly VectorResultEntry[],
  format: "json" | "ndjson" = "json",
): string {
  const flat = entries.map((e) => ({ id: e.id, ...e.result }));
  if (format === "ndjson") {
    return (
      flat.map((r) => stringifyVectorJson(r, false)).join("\n") +
      (flat.length > 0 ? "\n" : "")
    );
  }
  return stringifyVectorJson(flat, true) + "\n";
}
