/**
 * Section 17 cross-runtime canonical result encoding and comparison helpers:
 *   - Integers compare as exact decimal strings (Int64)
 *   - Floats compare by their 64-bit IEEE 754 big-endian hex bit pattern
 *   - Timestamps compare as exact integer milliseconds (decimal string)
 *   - Strings & enums compare as exact UTF-8 bytes (UTF-8 string + lowercase hex)
 *   - JSON values compare via deterministic key-sorted serialization
 */

import type {
  ByteSpan,
  CanonicalFieldResult,
  CanonicalResult,
  ExtractedField,
  FieldErrorCode,
  JsonValue,
  ParserSpec,
  ParseResult,
} from "./types.js";
import { encodeUtf8, float64ToHex, hasOwn, toLowerHex } from "./utf8.js";

/**
 * Deterministically serializes a JSON value with lexicographically sorted object keys.
 */
export function canonicalizeJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    return Object.is(value, -0) ? "-0" : JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let i = 0; i < value.length; i++) {
      items.push(canonicalizeJson(value[i]!));
    }
    return "[" + items.join(",") + "]";
  }
  const obj = value as { readonly [key: string]: JsonValue };
  const keys = Object.keys(obj).sort();
  const pairs: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    pairs.push(JSON.stringify(k) + ":" + canonicalizeJson(obj[k]!));
  }
  return "{" + pairs.join(",") + "}";
}

export function toCanonicalFieldResult(field: ExtractedField): CanonicalFieldResult {
  switch (field.status) {
    case "redacted":
      return { status: "redacted", type: field.type, token: field.token };
    case "dropped":
      return { status: "dropped", type: field.type };
    case "missing":
      return { status: "missing", type: field.type };
    case "error":
      return { status: "error", type: field.type, code: field.code };
    case "ok": {
      switch (field.type) {
        case "string":
        case "enum": {
          const str = field.value as string;
          const utf8_hex = toLowerHex(encodeUtf8(str));
          return field.pseudonymized
            ? { status: "ok", type: field.type, value: str, utf8_hex, pseudonymized: true }
            : { status: "ok", type: field.type, value: str, utf8_hex };
        }
        case "int": {
          const big =
            field.int64 !== undefined ? field.int64 : BigInt(field.value as number | bigint);
          return { status: "ok", type: "int", value: big.toString(10) };
        }
        case "timestamp": {
          const big =
            field.int64 !== undefined ? field.int64 : BigInt(field.value as number | bigint);
          return { status: "ok", type: "timestamp", value: big.toString(10) };
        }
        case "float":
          return {
            status: "ok",
            type: "float",
            value_hex: float64ToHex(field.value as number),
          };
        case "bool":
          return {
            status: "ok",
            type: "bool",
            value: field.value as boolean,
          };
        case "json":
          return {
            status: "ok",
            type: "json",
            value: canonicalizeJson(field.value as JsonValue),
          };
      }
    }
  }
}

export function toCanonicalResult(id: string, result: ParseResult): CanonicalResult {
  if (!result.matched) {
    return { id, matched: false };
  }

  const spans: Record<string, ByteSpan> = {};
  for (const key of Object.keys(result.spans).sort()) {
    spans[key] = result.spans[key]!;
  }

  const fields: Record<string, CanonicalFieldResult> = {};
  for (const key of Object.keys(result.fields).sort()) {
    fields[key] = toCanonicalFieldResult(result.fields[key]!);
  }

  return {
    id,
    matched: true,
    spans,
    fields,
  };
}

function compareFieldCanonical(
  name: string,
  actual: CanonicalFieldResult,
  expected: CanonicalFieldResult,
): string | null {
  if (actual.status !== expected.status) {
    return `field "${name}": status mismatch (actual=${actual.status}, expected=${expected.status})`;
  }
  if (actual.type !== expected.type) {
    return `field "${name}": type mismatch (actual=${actual.type}, expected=${expected.type})`;
  }

  switch (actual.status) {
    case "dropped":
    case "missing":
      return null;
    case "redacted": {
      const exp = expected as Extract<CanonicalFieldResult, { status: "redacted" }>;
      if (actual.token !== exp.token) {
        return `field "${name}": redacted token mismatch (actual=${actual.token}, expected=${exp.token})`;
      }
      return null;
    }
    case "error": {
      const exp = expected as Extract<CanonicalFieldResult, { status: "error" }>;
      if (actual.code !== exp.code) {
        return `field "${name}": error code mismatch (actual=${actual.code}, expected=${exp.code})`;
      }
      return null;
    }
    case "ok": {
      switch (actual.type) {
        case "string":
        case "enum": {
          const exp = expected as Extract<CanonicalFieldResult, { status: "ok"; type: "string" | "enum" }>;
          if (actual.utf8_hex !== exp.utf8_hex || actual.value !== exp.value) {
            return `field "${name}": string mismatch (actual=${JSON.stringify(actual.value)} [${actual.utf8_hex}], expected=${JSON.stringify(exp.value)} [${exp.utf8_hex}])`;
          }
          return null;
        }
        case "int":
        case "timestamp": {
          const exp = expected as Extract<CanonicalFieldResult, { status: "ok"; type: "int" | "timestamp" }>;
          if (actual.value !== exp.value) {
            return `field "${name}": ${actual.type} mismatch (actual=${actual.value}, expected=${exp.value})`;
          }
          return null;
        }
        case "float": {
          const exp = expected as Extract<CanonicalFieldResult, { status: "ok"; type: "float" }>;
          if (actual.value_hex !== exp.value_hex) {
            return `field "${name}": float64 hex mismatch (actual=${actual.value_hex}, expected=${exp.value_hex})`;
          }
          return null;
        }
        case "bool": {
          const exp = expected as Extract<CanonicalFieldResult, { status: "ok"; type: "bool" }>;
          if (actual.value !== exp.value) {
            return `field "${name}": bool mismatch (actual=${String(actual.value)}, expected=${String(exp.value)})`;
          }
          return null;
        }
        case "json": {
          const exp = expected as Extract<CanonicalFieldResult, { status: "ok"; type: "json" }>;
          if (actual.value !== exp.value) {
            return `field "${name}": json mismatch (actual=${actual.value}, expected=${exp.value})`;
          }
          return null;
        }
      }
    }
  }
}

/**
 * Compares two `CanonicalResult` records produced by any two Bind runtimes.
 * Returns an array of human-readable diff lines (empty means bit-for-bit agreement).
 */
export function compareCanonicalResults(
  actual: CanonicalResult,
  expected: CanonicalResult,
  checkSpans = true,
): string[] {
  const diffs: string[] = [];
  if (actual.matched !== expected.matched) {
    diffs.push(
      `match mismatch (actual=${String(actual.matched)}, expected=${String(expected.matched)})`,
    );
    return diffs;
  }
  if (!actual.matched || !expected.matched) {
    return diffs;
  }

  if (checkSpans && expected.spans !== undefined) {
    const allSpanKeys = new Set([
      ...Object.keys(actual.spans),
      ...Object.keys(expected.spans),
    ]);
    for (const key of [...allSpanKeys].sort()) {
      const a = actual.spans[key];
      const e = expected.spans[key];
      if (a === undefined || e === undefined || a.start !== e.start || a.end !== e.end) {
        diffs.push(
          `span "${key}": mismatch (actual=${JSON.stringify(a)}, expected=${JSON.stringify(e)})`,
        );
      }
    }
  }

  const allFieldKeys = new Set([
    ...Object.keys(actual.fields),
    ...Object.keys(expected.fields),
  ]);
  for (const key of [...allFieldKeys].sort()) {
    const a = actual.fields[key];
    const e = expected.fields[key];
    if (a === undefined) {
      diffs.push(`field "${key}": missing in actual result`);
      continue;
    }
    if (e === undefined) {
      diffs.push(`field "${key}": unexpected extra field in actual result`);
      continue;
    }
    const diff = compareFieldCanonical(key, a, e);
    if (diff !== null) {
      diffs.push(diff);
    }
  }

  return diffs;
}

export type ExpectedFieldSpec =
  | JsonValue
  | { readonly status: "error"; readonly code?: FieldErrorCode }
  | { readonly status: "redacted"; readonly token?: string }
  | { readonly status: "dropped" }
  | { readonly status: "missing" }
  | { readonly float_hex: string }
  | { readonly int64: string }
  | { readonly timestamp_ms: string };

/**
 * Checks a `ParseResult` against a `ParserSpec` test expectation map (as in `spec.tests[].expect`)
 * or richer conformance field expectations. Returns diff messages (empty array = pass).
 */
export function checkFieldExpectations(
  spec: ParserSpec,
  result: ParseResult,
  expectedFields: Readonly<Record<string, ExpectedFieldSpec>>,
): string[] {
  if (!result.matched) {
    return ["expected record to match, but got matched=false"];
  }

  const diffs: string[] = [];
  const canonical = toCanonicalResult("check", result);
  if (!canonical.matched) {
    return ["expected record to match, but got matched=false"];
  }

  const fieldTypes = new Map(spec.fields.map((f) => [f.name, f.type]));

  for (const [name, exp] of Object.entries(expectedFields)) {
    if (!hasOwn(canonical.fields, name)) {
      diffs.push(`field "${name}": missing from parse result`);
      continue;
    }
    const actual = canonical.fields[name]!;
    const fType = fieldTypes.get(name);

    // Rich expectation descriptors
    if (typeof exp === "object" && exp !== null && !Array.isArray(exp)) {
      const obj = exp as Record<string, unknown>;
      if (obj["status"] === "error") {
        if (actual.status !== "error") {
          diffs.push(`field "${name}": expected status=error, got ${actual.status}`);
        } else if (
          typeof obj["code"] === "string" &&
          actual.code !== obj["code"]
        ) {
          diffs.push(`field "${name}": expected error code ${obj["code"]}, got ${actual.code}`);
        }
        continue;
      }
      if (obj["status"] === "redacted") {
        if (actual.status !== "redacted") {
          diffs.push(`field "${name}": expected status=redacted, got ${actual.status}`);
        } else if (
          typeof obj["token"] === "string" &&
          actual.token !== obj["token"]
        ) {
          diffs.push(`field "${name}": expected redacted token ${obj["token"]}, got ${actual.token}`);
        }
        continue;
      }
      if (obj["status"] === "dropped") {
        if (actual.status !== "dropped") {
          diffs.push(`field "${name}": expected status=dropped, got ${actual.status}`);
        }
        continue;
      }
      if (obj["status"] === "missing") {
        if (actual.status !== "missing") {
          diffs.push(`field "${name}": expected status=missing, got ${actual.status}`);
        }
        continue;
      }
      if (typeof obj["float_hex"] === "string") {
        if (actual.status !== "ok" || actual.type !== "float") {
          diffs.push(`field "${name}": expected ok float, got ${actual.status}/${actual.type}`);
        } else if (actual.value_hex !== obj["float_hex"].toLowerCase()) {
          diffs.push(
            `field "${name}": float64 hex mismatch (actual=${actual.value_hex}, expected=${obj["float_hex"].toLowerCase()})`,
          );
        }
        continue;
      }
      if (typeof obj["int64"] === "string") {
        if (actual.status !== "ok" || actual.type !== "int") {
          diffs.push(`field "${name}": expected ok int, got ${actual.status}/${actual.type}`);
        } else if (actual.value !== obj["int64"]) {
          diffs.push(`field "${name}": int64 mismatch (actual=${actual.value}, expected=${obj["int64"]})`);
        }
        continue;
      }
      if (typeof obj["timestamp_ms"] === "string") {
        if (actual.status !== "ok" || actual.type !== "timestamp") {
          diffs.push(`field "${name}": expected ok timestamp, got ${actual.status}/${actual.type}`);
        } else if (actual.value !== obj["timestamp_ms"]) {
          diffs.push(
            `field "${name}": timestamp_ms mismatch (actual=${actual.value}, expected=${obj["timestamp_ms"]})`,
          );
        }
        continue;
      }
    }

    // Plain JSON expectation (as in `ParserSpec.tests[].expect`)
    if (exp === null) {
      if (
        actual.status === "redacted" ||
        actual.status === "dropped" ||
        actual.status === "missing" ||
        (actual.status === "ok" && actual.type === "json" && actual.value === "null")
      ) {
        continue;
      }
      diffs.push(
        `field "${name}": expected null (missing/dropped/redacted), got ${JSON.stringify(actual)}`,
      );
      continue;
    }

    if (actual.status !== "ok") {
      diffs.push(`field "${name}": expected value ${JSON.stringify(exp)}, got status=${actual.status}`);
      continue;
    }

    switch (actual.type) {
      case "string":
      case "enum": {
        if (typeof exp !== "string" || actual.value !== exp) {
          diffs.push(
            `field "${name}": expected ${JSON.stringify(exp)}, got ${JSON.stringify(actual.value)}`,
          );
        }
        break;
      }
      case "int":
      case "timestamp": {
        const expStr =
          typeof exp === "number"
            ? Math.trunc(exp).toString(10)
            : typeof exp === "string"
              ? exp
              : null;
        if (expStr === null || actual.value !== expStr) {
          diffs.push(
            `field "${name}": expected ${fType} ${JSON.stringify(exp)}, got ${actual.value}`,
          );
        }
        break;
      }
      case "float": {
        if (typeof exp !== "number" || actual.value_hex !== float64ToHex(exp)) {
          diffs.push(
            `field "${name}": float64 mismatch (actual=${actual.value_hex}, expected=${typeof exp === "number" ? float64ToHex(exp) : JSON.stringify(exp)})`,
          );
        }
        break;
      }
      case "bool": {
        if (typeof exp !== "boolean" || actual.value !== exp) {
          diffs.push(
            `field "${name}": expected bool ${JSON.stringify(exp)}, got ${String(actual.value)}`,
          );
        }
        break;
      }
      case "json": {
        const expJson = canonicalizeJson(exp as JsonValue);
        if (actual.value !== expJson) {
          diffs.push(
            `field "${name}": expected json ${expJson}, got ${actual.value}`,
          );
        }
        break;
      }
    }
  }

  return diffs;
}
