/**
 * High-level ParserSpec compilation and record evaluation across all three match
 * kinds (`text`, `object`, `args`), returning typed fields, UTF-8 byte spans,
 * and structured parse errors.
 */

import type {
  ArgsInput,
  ByteSpan,
  ExtractedField,
  ExtractedFieldError,
  HoleCapture,
  ParserField,
  ParserSpec,
  ParseResult,
  RecordInput,
  RuntimeOptions,
} from "./types.js";
import {
  compileArgsMatch,
  compileObjectMatch,
  compileTextSegments,
  isPlainObject,
  lookupObjectPath,
  matchCompiledArgs,
  matchCompiledObject,
  matchCompiledText,
  type CompiledArgsPattern,
  type CompiledObjectPattern,
  type CompiledTextPattern,
} from "./matchers.js";
import { evaluateFieldValue, type TransformOutcome } from "./transforms.js";
import { hasOwn } from "./utf8.js";

interface CompiledField {
  readonly spec: ParserField;
  readonly pathSegments?: readonly string[];
}

export interface CompiledParser {
  readonly spec: ParserSpec;
  parse(input: RecordInput, options?: RuntimeOptions): ParseResult;
}

type CompiledMatcher =
  | { readonly kind: "text"; readonly pattern: CompiledTextPattern }
  | { readonly kind: "object"; readonly pattern: CompiledObjectPattern }
  | { readonly kind: "args"; readonly pattern: CompiledArgsPattern };

function outcomeToExtractedField(
  field: ParserField,
  outcome: TransformOutcome,
  span?: ByteSpan,
): ExtractedField {
  switch (outcome.status) {
    case "ok": {
      const base = {
        status: "ok" as const,
        id: field.id,
        name: field.name,
        type: field.type,
        value: outcome.value,
      };
      return {
        ...base,
        ...(outcome.int64 !== undefined ? { int64: outcome.int64 } : {}),
        ...(outcome.pseudonymized ? { pseudonymized: true } : {}),
        ...(span !== undefined ? { span } : {}),
      };
    }
    case "redacted":
      return {
        status: "redacted",
        id: field.id,
        name: field.name,
        type: field.type,
        value: null,
        token: outcome.token,
        ...(span !== undefined ? { span } : {}),
      };
    case "dropped":
      return {
        status: "dropped",
        id: field.id,
        name: field.name,
        type: field.type,
        value: null,
        ...(span !== undefined ? { span } : {}),
      };
    case "missing":
      return {
        status: "missing",
        id: field.id,
        name: field.name,
        type: field.type,
        value: null,
      };
    case "error":
      return {
        status: "error",
        id: field.id,
        name: field.name,
        type: field.type,
        value: null,
        code: outcome.code,
        message: outcome.message,
        ...(span !== undefined ? { span } : {}),
      };
  }
}

function extractTextInput(input: RecordInput): string | null {
  if (typeof input === "string") {
    return input;
  }
  if (isPlainObject(input) && "line" in input && typeof input["line"] === "string") {
    return input["line"];
  }
  return null;
}

function extractObjectInput(
  input: RecordInput,
  shapePaths: readonly (readonly string[])[],
): Readonly<Record<string, unknown>> | null {
  if (!isPlainObject(input)) {
    return null;
  }
  if (
    "object" in input &&
    isPlainObject(input["object"]) &&
    Object.keys(input).length === 1
  ) {
    const inner = input["object"];
    const shapeExpectsObjectKey = shapePaths.some((p) => p[0] === "object");
    if (!shapeExpectsObjectKey || "object" in inner) {
      return inner;
    }
  }
  return input;
}

function extractArgsInput(
  input: RecordInput,
): ArgsInput | readonly unknown[] | null {
  if (Array.isArray(input)) {
    return input;
  }
  if (isPlainObject(input) && "args" in input && Array.isArray(input["args"])) {
    return input as ArgsInput;
  }
  return null;
}

/**
 * Compiles a `ParserSpec` once for repeated zero-overhead record parsing.
 */
export function compileParser(spec: ParserSpec): CompiledParser {
  let matcher: CompiledMatcher;
  switch (spec.match.kind) {
    case "text":
      matcher = { kind: "text", pattern: compileTextSegments(spec.match.segments) };
      break;
    case "object":
      matcher = { kind: "object", pattern: compileObjectMatch(spec.match) };
      break;
    case "args":
      matcher = { kind: "args", pattern: compileArgsMatch(spec.match) };
      break;
  }

  const compiledFields: CompiledField[] = spec.fields.map((f) => {
    if ("path" in f.from) {
      return { spec: f, pathSegments: f.from.path.split(".") };
    }
    return { spec: f };
  });

  function evaluateFields(
    holes: Readonly<Record<string, HoleCapture>>,
    obj: Readonly<Record<string, unknown>> | null,
    args: readonly unknown[] | null,
    options: RuntimeOptions,
  ): {
    readonly spans: Readonly<Record<string, ByteSpan>>;
    readonly fields: Readonly<Record<string, ExtractedField>>;
    readonly errors: readonly ExtractedFieldError[];
  } {
    const spans: Record<string, ByteSpan> = Object.create(null);
    for (const holeName of Object.keys(holes)) {
      spans[holeName] = holes[holeName]!.span;
    }

    const fields: Record<string, ExtractedField> = Object.create(null);
    const errors: ExtractedFieldError[] = [];

    for (let i = 0; i < compiledFields.length; i++) {
      const cf = compiledFields[i]!;
      const f = cf.spec;
      let extracted: ExtractedField;

      if ("hole" in f.from) {
        const holeName = f.from.hole;
        if (!hasOwn(holes, holeName)) {
          extracted = outcomeToExtractedField(f, {
            status: "error",
            code: "MISSING_HOLE",
            message: `Hole "${holeName}" was not captured by match`,
          });
        } else {
          const cap = holes[holeName]!;
          const outcome = evaluateFieldValue(cap.text, f, options, cap.redaction);
          extracted = outcomeToExtractedField(f, outcome, cap.span);
        }
      } else if ("path" in f.from) {
        if (obj === null || cf.pathSegments === undefined) {
          extracted = outcomeToExtractedField(f, { status: "missing" });
        } else {
          const lookup = lookupObjectPath(obj, cf.pathSegments);
          if (!lookup.found) {
            extracted = outcomeToExtractedField(f, { status: "missing" });
          } else {
            const outcome = evaluateFieldValue(lookup.value, f, options);
            extracted = outcomeToExtractedField(f, outcome);
          }
        }
      } else if ("arg" in f.from) {
        const idx = f.from.arg;
        if (args === null || idx < 0 || idx >= args.length) {
          extracted = outcomeToExtractedField(f, {
            status: "error",
            code: "MISSING_ARG",
            message: `Argument index ${idx} out of bounds`,
          });
        } else {
          const outcome = evaluateFieldValue(args[idx], f, options);
          extracted = outcomeToExtractedField(f, outcome);
        }
      } else {
        extracted = outcomeToExtractedField(f, {
          status: "error",
          code: "INVALID_SPEC",
          message: `Unsupported field binding on "${f.name}"`,
        });
      }

      fields[f.name] = extracted;
      if (extracted.status === "error") {
        errors.push(extracted);
      }
    }

    return { spans, fields, errors };
  }

  return {
    spec,
    parse(input: RecordInput, options: RuntimeOptions = {}): ParseResult {
      const refYear = options.referenceYear ?? 1970;

      if (matcher.kind === "text") {
        const line = extractTextInput(input);
        if (line === null) {
          return {
            matched: false,
            template: spec.template,
            event: spec.event,
            version: spec.version,
          };
        }
        const m = matchCompiledText(matcher.pattern, line, refYear);
        if (!m.matched) {
          return {
            matched: false,
            template: spec.template,
            event: spec.event,
            version: spec.version,
          };
        }
        const { spans, fields, errors } = evaluateFields(m.holes, null, null, options);
        return {
          matched: true,
          template: spec.template,
          event: spec.event,
          version: spec.version,
          spans,
          fields,
          errors,
        };
      }

      if (matcher.kind === "object") {
        const obj = extractObjectInput(input, matcher.pattern.shapePaths);
        if (obj === null) {
          return {
            matched: false,
            template: spec.template,
            event: spec.event,
            version: spec.version,
          };
        }
        const m = matchCompiledObject(matcher.pattern, obj, refYear);
        if (!m.matched) {
          return {
            matched: false,
            template: spec.template,
            event: spec.event,
            version: spec.version,
          };
        }
        const { spans, fields, errors } = evaluateFields(m.holes, m.object, null, options);
        return {
          matched: true,
          template: spec.template,
          event: spec.event,
          version: spec.version,
          spans,
          fields,
          errors,
        };
      }

      const argsInput = extractArgsInput(input);
      if (argsInput === null) {
        return {
          matched: false,
          template: spec.template,
          event: spec.event,
          version: spec.version,
        };
      }
      const m = matchCompiledArgs(matcher.pattern, argsInput);
      if (!m.matched) {
        return {
          matched: false,
          template: spec.template,
          event: spec.event,
          version: spec.version,
        };
      }
      const { spans, fields, errors } = evaluateFields(
        Object.create(null),
        null,
        m.args,
        options,
      );
      return {
        matched: true,
        template: spec.template,
        event: spec.event,
        version: spec.version,
        spans,
        fields,
        errors,
      };
    },
  };
}

/**
 * Convenience single-shot evaluation of a `ParserSpec` against one record.
 */
export function parseRecord(
  spec: ParserSpec,
  input: RecordInput,
  options?: RuntimeOptions,
): ParseResult {
  return compileParser(spec).parse(input, options);
}
