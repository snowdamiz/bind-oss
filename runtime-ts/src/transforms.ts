/**
 * Declarative field transform pipeline (section 5 & section 14) and strict typed
 * field conversion. Supports all 9 transforms:
 *   cast, scale, unit, parse_time, lower, enum_map, hash, mask, drop.
 *
 * Guarantees single-operation IEEE 754 double arithmetic for `scale` and `unit`,
 * fail-closed behavior for `hash` and `mask`, exact Int64 precision via BigInt,
 * and strict separation between untyped text-hole captures (`from.hole`) and
 * typed structured values (`from.path`, `from.arg`).
 */

import type {
  ByteUnit,
  FieldErrorCode,
  FieldType,
  JsonValue,
  ParserField,
  RedactionTokenInfo,
  RuntimeOptions,
  TimeUnit,
  Transform,
} from "./types.js";
import {
  computeHostedPseudonymTag,
  computeInnerPseudonymBytes,
  computeOuterPseudonymTag,
} from "./hmac.js";
import { maskIpPrefix } from "./ip.js";
import { parseRedactionTokenString } from "./redaction.js";
import { isValidJsonValueBytes, scanFloatBytes, scanIntBytes } from "./scanners.js";
import { parseTimeValue, resolveReferenceYear } from "./time.js";
import {
  encodeUtf8,
  fromHex,
  hasOwn,
  INT64_MAX,
  INT64_MIN,
  toLowerHex,
  toSafeIntOrBigInt,
} from "./utf8.js";

const TIME_UNIT_NS: Readonly<Record<TimeUnit, bigint>> = {
  ns: 1n,
  us: 1_000n,
  ms: 1_000_000n,
  s: 1_000_000_000n,
  m: 60_000_000_000n,
  h: 3_600_000_000_000n,
  d: 86_400_000_000_000n,
};

const BYTE_UNIT_B: Readonly<Record<ByteUnit, bigint>> = {
  B: 1n,
  KB: 1_000n,
  MB: 1_000_000n,
  GB: 1_000_000_000n,
  TB: 1_000_000_000_000n,
  KiB: 1_024n,
  MiB: 1_048_576n,
  GiB: 1_073_741_824n,
  TiB: 1_099_511_627_776n,
};

function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

export type PipelineValue =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "string"; readonly value: string; readonly pseudonymized?: true }
  | { readonly kind: "int"; readonly value: bigint }
  | { readonly kind: "float"; readonly value: number }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "timestamp"; readonly value: bigint }
  | { readonly kind: "json"; readonly value: JsonValue };

export type TransformOutcome =
  | {
      readonly status: "ok";
      readonly value: string | number | bigint | boolean | JsonValue;
      readonly int64?: bigint;
      readonly pseudonymized?: true;
    }
  | { readonly status: "redacted"; readonly token: string }
  | { readonly status: "dropped" }
  | { readonly status: "missing" }
  | { readonly status: "error"; readonly code: FieldErrorCode; readonly message: string };

function err(code: FieldErrorCode, message: string): TransformOutcome {
  return { status: "error", code, message };
}

function isStringLike(
  val: PipelineValue,
): val is
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "string"; readonly value: string; readonly pseudonymized?: true } {
  return val.kind === "text" || val.kind === "string";
}

export function parseStrictInt64(
  str: string,
):
  | { readonly ok: true; readonly value: bigint }
  | { readonly ok: false; readonly code: "INVALID_NUMBER" | "INT64_OVERFLOW" } {
  const bytes = encodeUtf8(str);
  if (bytes.length === 0 || scanIntBytes(bytes, 0, bytes.length) !== bytes.length) {
    return { ok: false, code: "INVALID_NUMBER" };
  }
  const v = BigInt(str);
  if (v < INT64_MIN || v > INT64_MAX) {
    return { ok: false, code: "INT64_OVERFLOW" };
  }
  return { ok: true, value: v };
}

export function parseStrictFloat64(
  str: string,
):
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly code: "INVALID_NUMBER" | "FLOAT_OVERFLOW" } {
  const bytes = encodeUtf8(str);
  if (bytes.length === 0 || scanFloatBytes(bytes, 0, bytes.length) !== bytes.length) {
    return { ok: false, code: "INVALID_NUMBER" };
  }
  const v = Number(str);
  if (!Number.isFinite(v)) {
    return { ok: false, code: "FLOAT_OVERFLOW" };
  }
  return { ok: true, value: v };
}

function toDouble(
  val: PipelineValue,
  allowTypedString: boolean,
):
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly code: FieldErrorCode; readonly message: string } {
  switch (val.kind) {
    case "float":
    case "number":
      return Number.isFinite(val.value)
        ? { ok: true, value: val.value }
        : { ok: false, code: "FLOAT_OVERFLOW", message: "Non-finite float value" };
    case "int":
    case "timestamp": {
      const n = Number(val.value);
      return Number.isFinite(n)
        ? { ok: true, value: n }
        : { ok: false, code: "FLOAT_OVERFLOW", message: "Integer overflows IEEE 754 double" };
    }
    case "text":
    case "string": {
      if (val.kind === "string" && !allowTypedString) {
        return {
          ok: false,
          code: "TYPE_MISMATCH_FLOAT",
          message: `Expected numeric value, got typed string "${val.value}" without cast`,
        };
      }
      const parsed = parseStrictFloat64(val.value);
      if (!parsed.ok) {
        return {
          ok: false,
          code: parsed.code,
          message: `Cannot parse "${val.value}" as finite float64`,
        };
      }
      return { ok: true, value: parsed.value };
    }
    default:
      return {
        ok: false,
        code: "TYPE_MISMATCH_FLOAT",
        message: `Expected numeric value, got ${val.kind}`,
      };
  }
}

function parseBoolString(str: string, extended: boolean): boolean | null {
  const lower = str.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (extended) {
    if (lower === "1" || lower === "yes" || lower === "t" || lower === "on") return true;
    if (lower === "0" || lower === "no" || lower === "f" || lower === "off") return false;
  }
  return null;
}

function parseJsonString(
  str: string,
): { readonly ok: true; readonly value: JsonValue } | { readonly ok: false } {
  const bytes = encodeUtf8(str);
  if (!isValidJsonValueBytes(bytes)) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(str) as JsonValue };
  } catch {
    return { ok: false };
  }
}

function isJsonSafeValue(val: unknown): val is JsonValue {
  if (val === null || typeof val === "string" || typeof val === "boolean") {
    return true;
  }
  if (typeof val === "number") {
    return Number.isFinite(val);
  }
  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) {
      if (!isJsonSafeValue(val[i])) return false;
    }
    return true;
  }
  if (typeof val === "object") {
    for (const key of Object.keys(val as Record<string, unknown>)) {
      if (!isJsonSafeValue((val as Record<string, unknown>)[key])) return false;
    }
    return true;
  }
  return false;
}

function handleIncomingRedactionToken(
  token: RedactionTokenInfo,
  field: ParserField,
  options: RuntimeOptions,
): TransformOutcome {
  // Mask token: always produces null with redacted marker
  if (token.category === "mask") {
    return { status: "redacted", token: token.raw };
  }

  // Section 5: "A pseudonym token in a hole whose field is not a string is treated as a mask."
  if (field.type !== "string") {
    return { status: "redacted", token: token.raw };
  }

  // Pre-scrubbed pseudonym tokens on string fields short-circuit declared transforms
  // (including drop, mask, lower, and hash) so already-tokenized values are preserved unchanged.
  // Edge inner pseudonym tokens (<kind:~64hex>) still upgrade to hosted <kind:16hex>
  // when a hash transform and serverKey are present.
  if (token.category === "inner_pseudonym") {
    const transforms = field.transforms ?? [];
    for (let i = 0; i < transforms.length; i++) {
      const tx = transforms[i]!;
      if (tx.op === "hash") {
        const serverKey = options.hashKeys?.serverKey;
        if (serverKey !== undefined && token.innerHex !== undefined) {
          const innerBytes = fromHex(token.innerHex);
          if (innerBytes !== null && innerBytes.length === 32) {
            const tag = computeOuterPseudonymTag(serverKey, innerBytes);
            const kind = tx.kind ?? token.kind;
            return {
              status: "ok",
              value: `<${kind}:${tag}>`,
              pseudonymized: true,
            };
          }
        }
        break;
      }
    }
  }

  return {
    status: "ok",
    value: token.raw,
    pseudonymized: true,
  };
}

function applySingleTransform(
  val: PipelineValue,
  tx: Transform,
  field: ParserField,
  options: RuntimeOptions,
):
  | { readonly next: PipelineValue }
  | { readonly terminal: TransformOutcome } {
  switch (tx.op) {
    case "drop":
      return { terminal: { status: "dropped" } };

    case "mask": {
      const mode = tx.mode ?? "token";
      if (mode === "token") {
        const kind =
          tx.kind ?? (field.pii && field.pii !== "none" ? field.pii : "redacted");
        return { terminal: { status: "redacted", token: `<${kind}>` } };
      }
      if (mode === "ip_prefix") {
        if (!isStringLike(val)) {
          return {
            terminal: err("INVALID_IP", `mask(ip_prefix) requires a string IP, got ${val.kind}`),
          };
        }
        const masked = maskIpPrefix(val.value);
        if (masked === null) {
          return {
            terminal: err("INVALID_IP", `Invalid IP address for ip_prefix mask: "${val.value}"`),
          };
        }
        return { next: { kind: "string", value: masked } };
      }
      return {
        terminal: err("INVALID_TRANSFORM", `Unknown mask mode: ${String(mode)}`),
      };
    }

    case "lower": {
      if (!isStringLike(val)) {
        return {
          terminal: err("EXPECTED_STRING", `lower transform requires a string, got ${val.kind}`),
        };
      }
      return {
        next:
          val.kind === "string" && val.pseudonymized
            ? { kind: "string", value: val.value, pseudonymized: true }
            : { kind: "string", value: val.value.toLowerCase() },
      };
    }

    case "enum_map": {
      if (!isStringLike(val)) {
        return {
          terminal: err("EXPECTED_STRING", `enum_map transform requires a string, got ${val.kind}`),
        };
      }
      if (hasOwn(tx.map, val.value)) {
        return { next: { kind: "string", value: tx.map[val.value]! } };
      }
      if (tx.default !== undefined) {
        return { next: { kind: "string", value: tx.default } };
      }
      return {
        terminal: err(
          "ENUM_UNMAPPED",
          `Value "${val.value}" not present in enum_map and no default specified`,
        ),
      };
    }

    case "hash": {
      if (!isStringLike(val)) {
        return {
          terminal: err("EXPECTED_STRING", `hash transform requires a string, got ${val.kind}`),
        };
      }
      // Do not double-hash an existing replacement token
      const existing = parseRedactionTokenString(val.value);
      if (existing !== null) {
        if (existing.category === "pseudonym") {
          return { next: { kind: "string", value: existing.raw, pseudonymized: true } };
        }
        if (existing.category === "inner_pseudonym") {
          const serverKey = options.hashKeys?.serverKey;
          if (serverKey === undefined || existing.innerHex === undefined) {
            return { next: { kind: "string", value: existing.raw, pseudonymized: true } };
          }
          const innerBytes = fromHex(existing.innerHex);
          if (innerBytes === null || innerBytes.length !== 32) {
            return { terminal: err("INVALID_TRANSFORM", "Malformed inner pseudonym token") };
          }
          const tag = computeOuterPseudonymTag(serverKey, innerBytes);
          const kind = tx.kind ?? existing.kind;
          return { next: { kind: "string", value: `<${kind}:${tag}>`, pseudonymized: true } };
        }
        return { terminal: { status: "redacted", token: existing.raw } };
      }

      const kind =
        tx.kind ?? (field.pii && field.pii !== "none" ? field.pii : "hash");
      const edgeKey = options.hashKeys?.edgeKey;
      const serverKey = options.hashKeys?.serverKey;

      if (edgeKey !== undefined && serverKey !== undefined) {
        const tag = computeHostedPseudonymTag(edgeKey, serverKey, val.value);
        return { next: { kind: "string", value: `<${kind}:${tag}>`, pseudonymized: true } };
      }
      if (edgeKey !== undefined) {
        const inner = computeInnerPseudonymBytes(edgeKey, val.value);
        return {
          next: {
            kind: "string",
            value: `<${kind}:~${toLowerHex(inner)}>`,
            pseudonymized: true,
          },
        };
      }
      // Section 14 fail-closed rule: never pass raw data through when hash keys are absent
      return {
        terminal: err(
          "MISSING_HASH_KEY",
          "hash transform failed closed: edgeKey (and serverKey for hosted mode) must be provided",
        ),
      };
    }

    case "scale": {
      const hasMul = tx.mul !== undefined;
      const hasDiv = tx.div !== undefined;
      if (hasMul === hasDiv) {
        return {
          terminal: err(
            "INVALID_TRANSFORM",
            "scale transform must specify exactly one of integer mul or integer div",
          ),
        };
      }
      const factor = hasMul ? tx.mul! : tx.div!;
      if (!Number.isSafeInteger(factor) || factor === 0) {
        return {
          terminal: err(
            "INVALID_TRANSFORM",
            `scale factor must be a non-zero safe integer, got ${String(factor)}`,
          ),
        };
      }
      const num = toDouble(val, false);
      if (!num.ok) {
        return { terminal: err(num.code, num.message) };
      }
      // Exactly one IEEE 754 binary64 operation (section 5)
      const scaled = hasMul ? num.value * factor : num.value / factor;
      if (!Number.isFinite(scaled)) {
        return {
          terminal: err("FLOAT_OVERFLOW", "scale transform overflowed IEEE 754 double"),
        };
      }
      return { next: { kind: "float", value: scaled } };
    }

    case "unit": {
      const fromTime = (TIME_UNIT_NS as Readonly<Record<string, bigint | undefined>>)[tx.from];
      const toTime = (TIME_UNIT_NS as Readonly<Record<string, bigint | undefined>>)[tx.to];
      const fromByte = (BYTE_UNIT_B as Readonly<Record<string, bigint | undefined>>)[tx.from];
      const toByte = (BYTE_UNIT_B as Readonly<Record<string, bigint | undefined>>)[tx.to];

      let fromFactor: bigint;
      let toFactor: bigint;
      if (fromTime !== undefined && toTime !== undefined) {
        fromFactor = fromTime;
        toFactor = toTime;
      } else if (fromByte !== undefined && toByte !== undefined) {
        fromFactor = fromByte;
        toFactor = toByte;
      } else {
        return {
          terminal: err(
            "INVALID_UNIT_CONVERSION",
            `Incompatible or unknown unit conversion: ${tx.from} -> ${tx.to}`,
          ),
        };
      }

      if (fromFactor === toFactor) {
        const num = toDouble(val, false);
        if (!num.ok) return { terminal: err(num.code, num.message) };
        return { next: { kind: "float", value: num.value } };
      }

      // Preserve exact Int64 arithmetic when multiplying an exact integer by an exact integer ratio
      if (fromFactor % toFactor === 0n) {
        const mul = fromFactor / toFactor;
        if (field.type === "int") {
          let exactInt: bigint | null = null;
          if (val.kind === "int") {
            exactInt = val.value;
          } else if (val.kind === "number" && Number.isInteger(val.value)) {
            exactInt = BigInt(val.value);
          } else if (val.kind === "text") {
            const parsedInt = parseStrictInt64(val.value);
            if (parsedInt.ok) exactInt = parsedInt.value;
          }
          if (exactInt !== null) {
            const prod = exactInt * mul;
            if (prod < INT64_MIN || prod > INT64_MAX) {
              return { terminal: err("INT64_OVERFLOW", "unit conversion overflows Int64") };
            }
            return { next: { kind: "int", value: prod } };
          }
        }
        const num = toDouble(val, false);
        if (!num.ok) return { terminal: err(num.code, num.message) };
        const res = num.value * Number(mul);
        if (!Number.isFinite(res)) {
          return { terminal: err("FLOAT_OVERFLOW", "unit conversion overflowed double") };
        }
        return { next: { kind: "float", value: res } };
      }

      if (toFactor % fromFactor === 0n) {
        const div = toFactor / fromFactor;
        const num = toDouble(val, false);
        if (!num.ok) return { terminal: err(num.code, num.message) };
        // Single IEEE 754 division (never multiply by reciprocal)
        const res = num.value / Number(div);
        if (!Number.isFinite(res)) {
          return { terminal: err("FLOAT_OVERFLOW", "unit conversion overflowed double") };
        }
        return { next: { kind: "float", value: res } };
      }

      // Cross SI <-> IEC byte unit conversion (reduced exact rational)
      const g = gcdBigInt(fromFactor, toFactor);
      const numFactor = Number(fromFactor / g);
      const denFactor = Number(toFactor / g);
      const num = toDouble(val, false);
      if (!num.ok) return { terminal: err(num.code, num.message) };
      const res = (num.value * numFactor) / denFactor;
      if (!Number.isFinite(res)) {
        return { terminal: err("FLOAT_OVERFLOW", "unit conversion overflowed double") };
      }
      return { next: { kind: "float", value: res } };
    }

    case "parse_time": {
      const fmt = tx.format ?? "auto";
      const refYear = resolveReferenceYear(options);
      let input: string | number | bigint;
      if (isStringLike(val)) {
        input = val.value;
      } else if (val.kind === "int" || val.kind === "timestamp") {
        input = val.value;
      } else if (val.kind === "number" || val.kind === "float") {
        input = val.value;
      } else {
        return {
          terminal: err(
            "INVALID_TIMESTAMP",
            `parse_time requires a string or numeric epoch, got ${val.kind}`,
          ),
        };
      }
      const ms = parseTimeValue(input, fmt, refYear);
      if (ms === null) {
        return {
          terminal: err(
            "INVALID_TIMESTAMP",
            `Failed to parse timestamp "${String(input)}" with format "${fmt}"`,
          ),
        };
      }
      return { next: { kind: "timestamp", value: ms } };
    }

    case "cast": {
      switch (tx.to) {
        case "string": {
          switch (val.kind) {
            case "text":
              return { next: { kind: "string", value: val.value } };
            case "string":
              return { next: val };
            case "int":
            case "timestamp":
              return { next: { kind: "string", value: val.value.toString(10) } };
            case "float":
            case "number":
              if (!Number.isFinite(val.value)) {
                return { terminal: err("FLOAT_OVERFLOW", "Cannot cast non-finite number to string") };
              }
              return { next: { kind: "string", value: String(val.value) } };
            case "bool":
              return { next: { kind: "string", value: val.value ? "true" : "false" } };
            case "json":
              return { next: { kind: "string", value: JSON.stringify(val.value) } };
          }
          break;
        }
        case "int": {
          switch (val.kind) {
            case "int":
            case "timestamp":
              if (val.value < INT64_MIN || val.value > INT64_MAX) {
                return { terminal: err("INT64_OVERFLOW", "Integer overflows Int64") };
              }
              return { next: { kind: "int", value: val.value } };
            case "bool":
              return { next: { kind: "int", value: val.value ? 1n : 0n } };
            case "float":
            case "number": {
              if (!Number.isFinite(val.value)) {
                return { terminal: err("INT64_OVERFLOW", "Non-finite number cannot cast to int") };
              }
              const truncated = Math.trunc(val.value);
              const big = BigInt(truncated);
              if (big < INT64_MIN || big > INT64_MAX) {
                return { terminal: err("INT64_OVERFLOW", "Number overflows Int64") };
              }
              return { next: { kind: "int", value: big } };
            }
            case "text":
            case "string": {
              const parsed = parseStrictInt64(val.value);
              if (!parsed.ok) {
                return {
                  terminal: err(
                    parsed.code === "INT64_OVERFLOW" ? "INT64_OVERFLOW" : "CAST_FAILED",
                    `Cannot cast "${val.value}" to int`,
                  ),
                };
              }
              return { next: { kind: "int", value: parsed.value } };
            }
            default:
              return {
                terminal: err("CAST_FAILED", `Cannot cast ${val.kind} to int`),
              };
          }
        }
        case "float": {
          if (val.kind === "bool") {
            return { next: { kind: "float", value: val.value ? 1.0 : 0.0 } };
          }
          const num = toDouble(val, true);
          if (!num.ok) {
            return {
              terminal: err(
                num.code === "FLOAT_OVERFLOW" ? "FLOAT_OVERFLOW" : "CAST_FAILED",
                num.message,
              ),
            };
          }
          return { next: { kind: "float", value: num.value } };
        }
        case "bool": {
          switch (val.kind) {
            case "bool":
              return { next: val };
            case "int":
              if (val.value === 1n) return { next: { kind: "bool", value: true } };
              if (val.value === 0n) return { next: { kind: "bool", value: false } };
              return {
                terminal: err("CAST_FAILED", `Cannot cast integer ${val.value.toString()} to bool`),
              };
            case "number":
            case "float":
              if (val.value === 1) return { next: { kind: "bool", value: true } };
              if (val.value === 0) return { next: { kind: "bool", value: false } };
              return {
                terminal: err("CAST_FAILED", `Cannot cast number ${String(val.value)} to bool`),
              };
            case "text":
            case "string": {
              const parsed = parseBoolString(val.value, true);
              if (parsed === null) {
                return {
                  terminal: err("CAST_FAILED", `Cannot cast "${val.value}" to bool`),
                };
              }
              return { next: { kind: "bool", value: parsed } };
            }
            default:
              return {
                terminal: err("CAST_FAILED", `Cannot cast ${val.kind} to bool`),
              };
          }
        }
        case "json": {
          if (val.kind === "json") return { next: val };
          if (isStringLike(val)) {
            const parsed = parseJsonString(val.value);
            if (!parsed.ok) {
              return {
                terminal: err("INVALID_JSON", `Cannot parse "${val.value}" as JSON`),
              };
            }
            return { next: { kind: "json", value: parsed.value } };
          }
          if (val.kind === "bool") {
            return { next: { kind: "json", value: val.value } };
          }
          if (val.kind === "float" || val.kind === "number") {
            if (!Number.isFinite(val.value)) {
              return { terminal: err("INVALID_JSON", "Non-finite number is not valid JSON") };
            }
            return { next: { kind: "json", value: val.value } };
          }
          if (val.kind === "int" || val.kind === "timestamp") {
            const safe = toSafeIntOrBigInt(val.value);
            if (typeof safe === "bigint") {
              return {
                terminal: err("INVALID_JSON", "Int64 outside JSON safe integer range"),
              };
            }
            return { next: { kind: "json", value: safe } };
          }
          return {
            terminal: err("INVALID_JSON", `Cannot cast ${String((val as PipelineValue).kind)} to json`),
          };
        }
      }
      return {
        terminal: err("INVALID_TRANSFORM", `Unknown cast target: ${String((tx as { to: unknown }).to)}`),
      };
    }
  }
}

function finalizeFieldType(
  val: PipelineValue,
  targetType: FieldType,
  options: RuntimeOptions,
  isHoleNoTransforms: boolean,
): TransformOutcome {
  switch (targetType) {
    case "string": {
      if (!isStringLike(val)) {
        return err(
          "TYPE_MISMATCH_STRING",
          `Field expects string, got ${val.kind}`,
        );
      }
      return val.kind === "string" && val.pseudonymized
        ? { status: "ok", value: val.value, pseudonymized: true }
        : { status: "ok", value: val.value };
    }

    case "enum": {
      if (!isStringLike(val) || val.value.length === 0) {
        return err(
          "TYPE_MISMATCH_ENUM",
          `Field expects non-empty enum string, got ${val.kind}`,
        );
      }
      return { status: "ok", value: val.value };
    }

    case "int": {
      if (val.kind === "int" || val.kind === "timestamp") {
        if (val.value < INT64_MIN || val.value > INT64_MAX) {
          return err("INT64_OVERFLOW", "Integer value overflows Int64");
        }
        return {
          status: "ok",
          value: toSafeIntOrBigInt(val.value),
          int64: val.value,
        };
      }
      if (val.kind === "number" || val.kind === "float") {
        if (!Number.isFinite(val.value) || !Number.isInteger(val.value)) {
          return err(
            "TYPE_MISMATCH_INT",
            `Field expects integer, got non-integer number ${String(val.value)}`,
          );
        }
        const big = BigInt(val.value);
        if (big < INT64_MIN || big > INT64_MAX) {
          return err("INT64_OVERFLOW", "Number overflows Int64");
        }
        return {
          status: "ok",
          value: toSafeIntOrBigInt(big),
          int64: big,
        };
      }
      if (val.kind === "text") {
        const parsed = parseStrictInt64(val.value);
        if (!parsed.ok) {
          return err(
            parsed.code === "INT64_OVERFLOW"
              ? "INT64_OVERFLOW"
              : isHoleNoTransforms
                ? "CAST_FAILED"
                : "TYPE_MISMATCH_INT",
            `Cannot convert "${val.value}" to Int64`,
          );
        }
        return {
          status: "ok",
          value: toSafeIntOrBigInt(parsed.value),
          int64: parsed.value,
        };
      }
      return err("TYPE_MISMATCH_INT", `Field expects int, got ${val.kind}`);
    }

    case "float": {
      const num = toDouble(val, false);
      if (!num.ok) {
        return err(
          num.code === "FLOAT_OVERFLOW"
            ? "FLOAT_OVERFLOW"
            : isHoleNoTransforms && val.kind === "text"
              ? "CAST_FAILED"
              : "TYPE_MISMATCH_FLOAT",
          num.message,
        );
      }
      return { status: "ok", value: num.value };
    }

    case "bool": {
      if (val.kind === "bool") {
        return { status: "ok", value: val.value };
      }
      if (val.kind === "text") {
        const parsed = parseBoolString(val.value, false);
        if (parsed === null) {
          return err(
            isHoleNoTransforms ? "CAST_FAILED" : "TYPE_MISMATCH_BOOL",
            `Cannot convert "${val.value}" to bool`,
          );
        }
        return { status: "ok", value: parsed };
      }
      return err("TYPE_MISMATCH_BOOL", `Field expects bool, got ${val.kind}`);
    }

    case "timestamp": {
      if (val.kind === "timestamp" || val.kind === "int") {
        if (val.value < INT64_MIN || val.value > INT64_MAX) {
          return err("INT64_OVERFLOW", "Timestamp overflows Int64 ms");
        }
        return {
          status: "ok",
          value: toSafeIntOrBigInt(val.value),
          int64: val.value,
        };
      }
      if (val.kind === "number" || val.kind === "float") {
        if (!Number.isFinite(val.value) || !Number.isInteger(val.value)) {
          return err(
            "TYPE_MISMATCH_TIMESTAMP",
            `Timestamp expects integer milliseconds, got ${String(val.value)}`,
          );
        }
        const big = BigInt(val.value);
        if (big < INT64_MIN || big > INT64_MAX) {
          return err("INT64_OVERFLOW", "Timestamp overflows Int64 ms");
        }
        return {
          status: "ok",
          value: toSafeIntOrBigInt(big),
          int64: big,
        };
      }
      if (val.kind === "text") {
        const ms = parseTimeValue(val.value, "auto", resolveReferenceYear(options));
        if (ms === null) {
          return err(
            "INVALID_TIMESTAMP",
            `Cannot parse timestamp "${val.value}"`,
          );
        }
        return {
          status: "ok",
          value: toSafeIntOrBigInt(ms),
          int64: ms,
        };
      }
      return err(
        "TYPE_MISMATCH_TIMESTAMP",
        `Field expects timestamp, got ${val.kind}`,
      );
    }

    case "json": {
      if (val.kind === "json") {
        return { status: "ok", value: val.value };
      }
      if (val.kind === "text") {
        const parsed = parseJsonString(val.value);
        if (!parsed.ok) {
          return err("INVALID_JSON", `Cannot parse "${val.value}" as JSON`);
        }
        return { status: "ok", value: parsed.value };
      }
      if (val.kind === "string") {
        // Typed structured string (from.path / from.arg) is already a valid JSON string value
        return { status: "ok", value: val.value };
      }
      if (val.kind === "bool") {
        return { status: "ok", value: val.value };
      }
      if (val.kind === "float" || val.kind === "number") {
        if (!Number.isFinite(val.value)) {
          return err("TYPE_MISMATCH_JSON", "Non-finite number is not valid JSON");
        }
        return { status: "ok", value: val.value };
      }
      if (val.kind === "int" || val.kind === "timestamp") {
        const safe = toSafeIntOrBigInt(val.value);
        if (typeof safe === "bigint") {
          return err("TYPE_MISMATCH_JSON", "Int64 outside JSON safe integer range");
        }
        return { status: "ok", value: safe };
      }
      return err("TYPE_MISMATCH_JSON", `Field expects json, got ${String((val as PipelineValue).kind)}`);
    }
  }
}

/**
 * Evaluates a field's transform pipeline and final typed conversion from an extracted raw value.
 */
export function evaluateFieldValue(
  rawValue: unknown,
  field: ParserField,
  options: RuntimeOptions,
  incomingRedaction?: RedactionTokenInfo,
): TransformOutcome {
  if (incomingRedaction !== undefined) {
    return handleIncomingRedactionToken(incomingRedaction, field, options);
  }

  if (rawValue === undefined || rawValue === null) {
    return { status: "missing" };
  }

  const fromTextHole = "hole" in field.from;

  let current: PipelineValue;
  if (typeof rawValue === "string") {
    const token = parseRedactionTokenString(rawValue);
    if (token !== null) {
      return handleIncomingRedactionToken(token, field, options);
    }
    current = fromTextHole
      ? { kind: "text", value: rawValue }
      : { kind: "string", value: rawValue };
  } else if (typeof rawValue === "boolean") {
    current = { kind: "bool", value: rawValue };
  } else if (typeof rawValue === "bigint") {
    current = { kind: "int", value: rawValue };
  } else if (typeof rawValue === "number") {
    if (!Number.isFinite(rawValue)) {
      return err("FLOAT_OVERFLOW", "Input number is not finite");
    }
    current = { kind: "number", value: rawValue };
  } else if (isJsonSafeValue(rawValue)) {
    current = { kind: "json", value: rawValue };
  } else {
    return err("INVALID_SPEC", `Unsupported input value type: ${typeof rawValue}`);
  }

  const transforms = field.transforms ?? [];
  for (let i = 0; i < transforms.length; i++) {
    const res = applySingleTransform(current, transforms[i]!, field, options);
    if ("terminal" in res) {
      return res.terminal;
    }
    current = res.next;
  }

  return finalizeFieldType(current, field.type, options, fromTextHole && transforms.length === 0);
}
