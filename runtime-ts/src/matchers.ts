/**
 * Matchers for Bind's three match kinds: `text`, `object` (with optional `message`
 * text sub-pattern), and `args`.
 *
 * Precompiles UTF-8 literal bytes and KMP search tables once per spec so repeated
 * matching runs in guaranteed linear time with zero per-record regex or table work.
 */

import type {
  ArgsInput,
  ArgsMatch,
  ArgsMatchResult,
  HoleCapture,
  HoleClass,
  HoleSegment,
  LiteralSegment,
  NoMatchResult,
  ObjectMatch,
  ObjectMatchResult,
  TextMatch,
  TextMatchResult,
  TextSegment,
} from "./types.js";
import { scanHole, type HoleScanContext } from "./scanners.js";
import { buildKmpTable, bytesEqualAt, encodeUtf8, hasOwn } from "./utf8.js";

export type CompiledSegment =
  | {
      readonly kind: "lit";
      readonly lit: string;
      readonly bytes: Uint8Array;
      readonly kmp: Int32Array;
    }
  | {
      readonly kind: "hole";
      readonly name: string;
      readonly holeClass: HoleClass;
    };

export interface CompiledTextPattern {
  readonly segments: readonly CompiledSegment[];
}

export interface CompiledObjectPattern {
  readonly shapePaths: readonly (readonly string[])[];
  readonly messagePath?: readonly string[];
  readonly messagePathRaw?: string;
  readonly messagePattern?: CompiledTextPattern;
}

export interface CompiledArgsPattern {
  readonly strings: readonly string[];
  readonly expectedArity: number;
}

function isLiteralSegment(seg: TextSegment): seg is LiteralSegment {
  return "lit" in seg;
}

function isHoleSegment(seg: TextSegment): seg is HoleSegment {
  return "hole" in seg;
}

/**
 * Compiles `TextSegment[]` into pre-encoded UTF-8 literals and KMP tables.
 * Coalesces consecutive literal segments if any exist so lookahead is exact.
 */
export function compileTextSegments(segments: readonly TextSegment[]): CompiledTextPattern {
  const compiled: CompiledSegment[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (isLiteralSegment(seg)) {
      const prev = compiled[compiled.length - 1];
      if (prev !== undefined && prev.kind === "lit") {
        const merged = prev.lit + seg.lit;
        const bytes = encodeUtf8(merged);
        compiled[compiled.length - 1] = {
          kind: "lit",
          lit: merged,
          bytes,
          kmp: buildKmpTable(bytes),
        };
      } else {
        const bytes = encodeUtf8(seg.lit);
        compiled.push({
          kind: "lit",
          lit: seg.lit,
          bytes,
          kmp: buildKmpTable(bytes),
        });
      }
    } else if (isHoleSegment(seg)) {
      compiled.push({
        kind: "hole",
        name: seg.hole,
        holeClass: seg.class ?? "word",
      });
    } else {
      throw new Error(`Invalid text segment at index ${i}`);
    }
  }
  return { segments: compiled };
}

export function compileObjectMatch(match: ObjectMatch): CompiledObjectPattern {
  const shapePaths = match.shape.map((p) => p.split("."));
  if (match.message !== undefined) {
    return {
      shapePaths,
      messagePath: match.message.path.split("."),
      messagePathRaw: match.message.path,
      messagePattern: compileTextSegments(match.message.segments),
    };
  }
  return { shapePaths };
}

export function compileArgsMatch(match: ArgsMatch): CompiledArgsPattern {
  return {
    strings: match.strings,
    expectedArity: Math.max(0, match.strings.length - 1),
  };
}

/**
 * Runs a compiled text pattern against a UTF-8 string, returning exact UTF-8 byte spans
 * for every matched hole. Anchored to the entire byte range `[0, bytes.length)`.
 */
export function matchCompiledText(
  pattern: CompiledTextPattern,
  line: string,
  referenceYear = 1970,
): TextMatchResult | NoMatchResult {
  const bytes = encodeUtf8(line);
  const len = bytes.length;
  const segs = pattern.segments;
  const holes: Record<string, HoleCapture> = Object.create(null);

  let pos = 0;

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (seg.kind === "lit") {
      if (!bytesEqualAt(bytes, pos, seg.bytes)) {
        return { matched: false };
      }
      pos += seg.bytes.length;
      continue;
    }

    const nextSeg = segs[i + 1];
    const ctx: HoleScanContext =
      nextSeg !== undefined && nextSeg.kind === "lit"
        ? {
            nextLit: nextSeg.bytes,
            nextLitKmp: nextSeg.kmp,
            isNextLitFinal: i + 1 === segs.length - 1,
            isFinalSegment: false,
            referenceYear,
          }
        : {
            isFinalSegment: i === segs.length - 1,
            referenceYear,
          };

    const scanned = scanHole(bytes, pos, len, seg.holeClass, ctx);
    if (scanned === null) {
      return { matched: false };
    }

    const capture: HoleCapture =
      scanned.redaction !== undefined
        ? {
            name: seg.name,
            holeClass: seg.holeClass,
            span: { start: pos, end: scanned.end },
            raw: scanned.raw,
            text: scanned.text,
            redaction: scanned.redaction,
          }
        : {
            name: seg.name,
            holeClass: seg.holeClass,
            span: { start: pos, end: scanned.end },
            raw: scanned.raw,
            text: scanned.text,
          };

    holes[seg.name] = capture;
    pos = scanned.end;
  }

  if (pos !== len) {
    return { matched: false };
  }

  return {
    matched: true,
    byteLength: len,
    holes,
  };
}

export function matchText(
  match: TextMatch,
  line: string,
  referenceYear = 1970,
): TextMatchResult | NoMatchResult {
  return matchCompiledText(compileTextSegments(match.segments), line, referenceYear);
}

/**
 * Prototype-safe dot-path lookup on a plain JSON object.
 */
export function lookupObjectPath(
  obj: Readonly<Record<string, unknown>>,
  pathSegments: readonly string[],
): { readonly found: true; readonly value: unknown } | { readonly found: false } {
  let cur: unknown = obj;
  for (let i = 0; i < pathSegments.length; i++) {
    if (typeof cur !== "object" || cur === null || Array.isArray(cur)) {
      return { found: false };
    }
    const key = pathSegments[i]!;
    if (!hasOwn(cur, key)) {
      return { found: false };
    }
    const next = (cur as Record<string, unknown>)[key];
    if (next === undefined) {
      return { found: false };
    }
    cur = next;
  }
  return { found: true, value: cur };
}

export function isPlainObject(val: unknown): val is Readonly<Record<string, unknown>> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

export function matchCompiledObject(
  pattern: CompiledObjectPattern,
  input: unknown,
  referenceYear = 1970,
): ObjectMatchResult | NoMatchResult {
  if (!isPlainObject(input)) {
    return { matched: false };
  }

  // Verify every required shape path is present
  for (let i = 0; i < pattern.shapePaths.length; i++) {
    const res = lookupObjectPath(input, pattern.shapePaths[i]!);
    if (!res.found) {
      return { matched: false };
    }
  }

  if (
    pattern.messagePattern !== undefined &&
    pattern.messagePath !== undefined &&
    pattern.messagePathRaw !== undefined
  ) {
    const msgRes = lookupObjectPath(input, pattern.messagePath);
    if (!msgRes.found || typeof msgRes.value !== "string") {
      return { matched: false };
    }
    const textMatch = matchCompiledText(
      pattern.messagePattern,
      msgRes.value,
      referenceYear,
    );
    if (!textMatch.matched) {
      return { matched: false };
    }
    return {
      matched: true,
      object: input,
      messagePath: pattern.messagePathRaw,
      messageByteLength: textMatch.byteLength,
      holes: textMatch.holes,
    };
  }

  return {
    matched: true,
    object: input,
    holes: Object.create(null),
  };
}

export function matchObject(
  match: ObjectMatch,
  input: unknown,
  referenceYear = 1970,
): ObjectMatchResult | NoMatchResult {
  return matchCompiledObject(compileObjectMatch(match), input, referenceYear);
}

export function matchCompiledArgs(
  pattern: CompiledArgsPattern,
  input: ArgsInput | readonly unknown[],
): ArgsMatchResult | NoMatchResult {
  let args: readonly unknown[];
  let strings: readonly string[] | undefined;

  if (Array.isArray(input)) {
    args = input;
  } else if (isPlainObject(input) && Array.isArray((input as ArgsInput).args)) {
    args = (input as ArgsInput).args;
    strings = (input as ArgsInput).strings;
  } else {
    return { matched: false };
  }

  if (strings !== undefined) {
    if (strings.length !== pattern.strings.length) {
      return { matched: false };
    }
    for (let i = 0; i < strings.length; i++) {
      if (strings[i] !== pattern.strings[i]) {
        return { matched: false };
      }
    }
  }

  if (args.length !== pattern.expectedArity) {
    return { matched: false };
  }

  return {
    matched: true,
    args,
  };
}

export function matchArgs(
  match: ArgsMatch,
  input: ArgsInput | readonly unknown[],
): ArgsMatchResult | NoMatchResult {
  return matchCompiledArgs(compileArgsMatch(match), input);
}
