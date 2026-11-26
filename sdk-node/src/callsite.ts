import * as fs from "node:fs";
import * as moduleApi from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  CallSite,
  CallSiteCacheStats,
  CallSiteResolverOptions,
  RawStackFrame,
  SourceMapLookupResult,
  TransportError,
} from "./types.js";

export const DEFAULT_CALLSITE_SAMPLE_LIMIT = 3;
export const DEFAULT_MAX_SHAPE_CACHE_ENTRIES = 2048;
export const DEFAULT_MAX_SOURCEMAP_CACHE_ENTRIES = 256;

const MAX_SOURCE_FILE_BYTES = 32 * 1024 * 1024;
const SOURCE_MAPPING_URL_RE =
  /^[ \t]*(?:\/\/[#@][ \t]*sourceMappingURL=([^\s'"]+)[ \t]*|\/\*[#@][ \t]*sourceMappingURL=([^\s'"]+)[ \t]*\*\/[ \t]*)$/;
const COMMENT_OR_BLANK_LINE_RE = /^[ \t]*(?:$|\/\/|\/\*[#@])/;
const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

interface CachedDiskSourceMap {
  readonly map: moduleApi.SourceMap;
  readonly mapDir: string;
  readonly sourceRoot?: string;
}

interface TemplateCacheEntry {
  readonly callsite: CallSite | undefined;
}

interface ShapeCacheEntry {
  samples: number;
  settled: boolean;
  ambiguous: boolean;
  callsite: CallSite | undefined;
}

interface SourceMappingEntryLike {
  readonly originalSource?: string;
  readonly originalLine?: number;
  readonly originalColumn?: number;
}

function positiveInt(value: number | undefined, fallback: number, min = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.floor(value));
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function isCallSiteEqual(a: CallSite | undefined, b: CallSite | undefined): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    a.file === b.file &&
    a.line === b.line &&
    a.column === b.column &&
    a.function === b.function
  );
}

function safeFileUrlToPath(input: string): string {
  if (!input.startsWith("file://")) {
    return input;
  }
  try {
    return fileURLToPath(input);
  } catch {
    return input;
  }
}

function safePathToFileUrl(filePath: string): string | undefined {
  if (filePath.startsWith("file://")) {
    return filePath;
  }
  if (!path.isAbsolute(filePath)) {
    return undefined;
  }
  try {
    return pathToFileURL(filePath).href;
  } catch {
    return undefined;
  }
}

function formatFunctionName(site: NodeJS.CallSite): string | undefined {
  const fnName = site.getFunctionName();
  const typeName = site.getTypeName();
  const methodName = site.getMethodName();
  const usefulType =
    typeName &&
    typeName !== "Object" &&
    typeName !== "Module" &&
    typeName !== "global" &&
    typeName !== "globalThis"
      ? typeName
      : undefined;

  if (fnName && fnName.length > 0) {
    if (usefulType && methodName && !fnName.includes(".")) {
      return `${usefulType}.${fnName}`;
    }
    return fnName;
  }
  if (methodName && methodName.length > 0) {
    return usefulType ? `${usefulType}.${methodName}` : methodName;
  }
  return undefined;
}

function isSkippableFileName(fileName: string | null | undefined): boolean {
  if (!fileName || fileName.length === 0) {
    return true;
  }
  if (fileName.startsWith("node:") || fileName.startsWith("internal/")) {
    return true;
  }
  return false;
}

function parseFallbackStack(stackText: string | undefined): RawStackFrame | undefined {
  if (!stackText) {
    return undefined;
  }
  const lines = stackText.split(/\r?\n/);
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (!line || !line.startsWith("at ")) {
      continue;
    }
    // Format 1: at fnName (file:line:col)
    // Format 2: at file:line:col
    let fnName: string | undefined;
    let location = line.slice(3).trim();
    if (location.endsWith(")")) {
      const openIdx = location.lastIndexOf(" (");
      if (openIdx !== -1) {
        fnName = location.slice(0, openIdx).trim();
        location = location.slice(openIdx + 2, -1);
      }
    }
    const match = /^(.+):(\d+):(\d+)$/.exec(location);
    if (!match) {
      continue;
    }
    const fileName = match[1]!;
    const lineNumber = Number.parseInt(match[2]!, 10);
    const columnNumber = Number.parseInt(match[3]!, 10);
    if (
      isSkippableFileName(fileName) ||
      !Number.isInteger(lineNumber) ||
      lineNumber <= 0
    ) {
      continue;
    }
    return {
      fileName,
      lineNumber,
      columnNumber: Number.isInteger(columnNumber) && columnNumber > 0 ? columnNumber : 1,
      functionName: fnName && fnName.length > 0 ? fnName : undefined,
    };
  }
  return undefined;
}

/**
 * Captures the immediate caller's raw stack frame above `skipAbove` using V8's
 * structured `Error.captureStackTrace` + `Error.prepareStackTrace` API.
 */
export function captureCallerFrame(
  skipAbove: (...args: never[]) => unknown,
): RawStackFrame | undefined {
  const ErrorCtor = Error as ErrorConstructor & {
    prepareStackTrace?: (err: Error, stackTraces: NodeJS.CallSite[]) => unknown;
    stackTraceLimit?: number;
  };

  if (typeof ErrorCtor.captureStackTrace === "function") {
    const prevPrepare = ErrorCtor.prepareStackTrace;
    const prevLimit = ErrorCtor.stackTraceLimit;
    let capturedSites: NodeJS.CallSite[] | undefined;

    try {
      ErrorCtor.stackTraceLimit = 10;
      ErrorCtor.prepareStackTrace = (_err, stackTraces) => {
        capturedSites = stackTraces;
        return "";
      };

      const holder: { stack?: string } = {};
      ErrorCtor.captureStackTrace(holder, skipAbove);
      void holder.stack;
    } catch {
      capturedSites = undefined;
    } finally {
      try {
        ErrorCtor.prepareStackTrace = prevPrepare;
      } catch {
        // Ignore if prepareStackTrace cannot be restored.
      }
      try {
        ErrorCtor.stackTraceLimit = prevLimit;
      } catch {
        // Ignore if stackTraceLimit cannot be restored.
      }
    }

    if (Array.isArray(capturedSites)) {
      for (const site of capturedSites) {
        const fileName = site.getFileName();
        const lineNumber = site.getLineNumber();
        if (
          isSkippableFileName(fileName) ||
          typeof lineNumber !== "number" ||
          !Number.isInteger(lineNumber) ||
          lineNumber <= 0
        ) {
          continue;
        }
        const rawCol = site.getColumnNumber();
        const columnNumber =
          typeof rawCol === "number" && Number.isInteger(rawCol) && rawCol > 0
            ? rawCol
            : 1;
        const functionName = formatFunctionName(site);
        return {
          fileName: fileName!,
          lineNumber,
          columnNumber,
          ...(functionName ? { functionName } : {}),
        };
      }
      return undefined;
    }
  }

  return parseFallbackStack(new Error().stack);
}

function extractTrailingSourceMappingUrl(sourceText: string): string | undefined {
  // Walk backwards from the end of the file over trailing blank/comment lines
  // so string literals in code bodies are never misinterpreted as sourceMappingURL.
  let end = sourceText.length;
  let inspectedLines = 0;
  const maxTrailingLines = 32;

  while (end > 0 && inspectedLines < maxTrailingLines) {
    const prevNewline = sourceText.lastIndexOf("\n", end - 1);
    const lineStart = prevNewline === -1 ? 0 : prevNewline + 1;
    let line = sourceText.slice(lineStart, end);
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }
    end = prevNewline === -1 ? 0 : prevNewline;
    inspectedLines += 1;

    const match = SOURCE_MAPPING_URL_RE.exec(line);
    if (match) {
      return match[1] ?? match[2];
    }
    if (!COMMENT_OR_BLANK_LINE_RE.test(line)) {
      break;
    }
  }
  return undefined;
}

function decodeInlineSourceMap(dataUrl: string): moduleApi.SourceMapPayload {
  const commaIdx = dataUrl.indexOf(",");
  if (commaIdx === -1) {
    throw new Error("Malformed inline sourceMappingURL data URI");
  }
  const meta = dataUrl.slice(5, commaIdx).toLowerCase();
  const encoded = dataUrl.slice(commaIdx + 1);
  const rawJson = meta.includes(";base64")
    ? Buffer.from(encoded, "base64").toString("utf8")
    : decodeURIComponent(encoded);
  return JSON.parse(rawJson) as moduleApi.SourceMapPayload;
}

function resolveOriginalSourcePath(
  originalSource: string,
  mapDir: string,
  sourceRoot?: string,
): string {
  if (originalSource.startsWith("file://")) {
    return safeFileUrlToPath(originalSource);
  }
  if (path.isAbsolute(originalSource)) {
    return originalSource;
  }
  if (URL_SCHEME_RE.test(originalSource)) {
    return originalSource;
  }

  let baseDir = mapDir;
  if (sourceRoot && sourceRoot.length > 0) {
    if (sourceRoot.startsWith("file://")) {
      baseDir = safeFileUrlToPath(sourceRoot);
    } else if (path.isAbsolute(sourceRoot)) {
      baseDir = sourceRoot;
    } else if (URL_SCHEME_RE.test(sourceRoot)) {
      const prefix = sourceRoot.replace(/\/+$/, "");
      const suffix = originalSource.replace(/^\/+/, "");
      return `${prefix}/${suffix}`;
    } else {
      baseDir = path.resolve(mapDir, sourceRoot);
    }
  }

  return path.resolve(baseDir, originalSource);
}

function lookupEntry(
  map: moduleApi.SourceMap,
  lineNumber: number,
  columnNumber: number,
): SourceMappingEntryLike | undefined {
  const lineOffset = Math.max(0, lineNumber - 1);
  const colOffset = Math.max(0, columnNumber - 1);
  const entry = map.findEntry(lineOffset, colOffset) as
    | SourceMappingEntryLike
    | undefined;
  if (
    !entry ||
    typeof entry.originalSource !== "string" ||
    entry.originalSource.length === 0 ||
    typeof entry.originalLine !== "number" ||
    !Number.isInteger(entry.originalLine) ||
    entry.originalLine < 0
  ) {
    return undefined;
  }
  return entry;
}

/**
 * Resolves and caches source-mapped call sites per tagged-template call site
 * (`WeakMap<TemplateStringsArray, ...>`) and per structured-event shape key
 * (bounded shape cache sampled for the first `sampleLimit` calls per shape).
 */
export class CallSiteResolver {
  private readonly enabled: boolean;
  private readonly sampleLimit: number;
  private readonly maxShapeCacheEntries: number;
  private readonly maxSourceMapCacheEntries: number;
  private readonly onError?: (error: TransportError) => void;
  private readonly captureFrameFn: (
    skipAbove: (...args: never[]) => unknown,
  ) => RawStackFrame | undefined;
  private readonly customResolveSourceMap?: (
    frame: RawStackFrame,
  ) => SourceMapLookupResult | undefined;

  private readonly templateCache = new WeakMap<
    TemplateStringsArray,
    TemplateCacheEntry
  >();
  private readonly shapeCache = new Map<string, ShapeCacheEntry>();
  private readonly sourceMapCache = new Map<string, CachedDiskSourceMap | null>();

  private stackCaptures = 0;
  private templateHits = 0;
  private templateMisses = 0;
  private shapeHits = 0;
  private shapeMisses = 0;

  constructor(options: CallSiteResolverOptions = {}) {
    this.enabled = options.enabled !== false;
    this.sampleLimit = nonNegativeInt(
      options.sampleLimit,
      DEFAULT_CALLSITE_SAMPLE_LIMIT,
    );
    this.maxShapeCacheEntries = positiveInt(
      options.maxShapeCacheEntries,
      DEFAULT_MAX_SHAPE_CACHE_ENTRIES,
    );
    this.maxSourceMapCacheEntries = positiveInt(
      options.maxSourceMapCacheEntries,
      DEFAULT_MAX_SOURCEMAP_CACHE_ENTRIES,
    );
    this.onError = options.onError;
    this.captureFrameFn = options.captureFrame ?? captureCallerFrame;
    this.customResolveSourceMap = options.resolveSourceMap;
  }

  /**
   * Resolves a source-mapped call site for a tagged template literal.
   * Captured once per `TemplateStringsArray` identity and served from a `WeakMap` thereafter.
   */
  resolveForTemplate(
    templateStrings: TemplateStringsArray,
    skipAbove: (...args: never[]) => unknown,
  ): CallSite | undefined {
    if (!this.enabled || this.sampleLimit === 0) {
      return undefined;
    }

    const cached = this.templateCache.get(templateStrings);
    if (cached !== undefined) {
      this.templateHits += 1;
      return cached.callsite;
    }

    this.templateMisses += 1;
    const callsite = this.captureAndResolve(skipAbove);
    this.templateCache.set(templateStrings, { callsite });
    return callsite;
  }

  /**
   * Resolves a source-mapped call site for a structured event shape key.
   * Samples the first `sampleLimit` records of each distinct shape key, verifies
   * call-site consistency (marking multi-site shapes ambiguous so no wrong call site
   * is cached), and serves from the bounded shape cache thereafter.
   */
  resolveForShape(
    shapeKey: string,
    skipAbove: (...args: never[]) => unknown,
  ): CallSite | undefined {
    if (!this.enabled || this.sampleLimit === 0) {
      return undefined;
    }

    const existing = this.shapeCache.get(shapeKey);
    if (existing !== undefined && existing.settled) {
      // Refresh LRU ordering.
      this.shapeCache.delete(shapeKey);
      this.shapeCache.set(shapeKey, existing);
      this.shapeHits += 1;
      return existing.callsite;
    }

    this.shapeMisses += 1;
    const captured = this.captureAndResolve(skipAbove);

    if (existing === undefined) {
      if (this.shapeCache.size >= this.maxShapeCacheEntries) {
        const oldestKey = this.shapeCache.keys().next().value;
        if (oldestKey !== undefined) {
          this.shapeCache.delete(oldestKey);
        }
      }
      this.shapeCache.set(shapeKey, {
        samples: 1,
        settled: this.sampleLimit <= 1,
        ambiguous: false,
        callsite: captured,
      });
      return captured;
    }

    existing.samples += 1;
    if (!isCallSiteEqual(existing.callsite, captured)) {
      existing.ambiguous = true;
      existing.callsite = undefined;
      existing.settled = true;
    } else if (existing.samples >= this.sampleLimit) {
      existing.settled = true;
    }

    // Refresh LRU ordering.
    this.shapeCache.delete(shapeKey);
    this.shapeCache.set(shapeKey, existing);
    return captured;
  }

  getStats(): CallSiteCacheStats {
    return {
      stackCaptures: this.stackCaptures,
      templateHits: this.templateHits,
      templateMisses: this.templateMisses,
      shapeHits: this.shapeHits,
      shapeMisses: this.shapeMisses,
      shapeCacheSize: this.shapeCache.size,
      sourceMapCacheSize: this.sourceMapCache.size,
    };
  }

  clear(): void {
    this.shapeCache.clear();
    this.sourceMapCache.clear();
  }

  private captureAndResolve(
    skipAbove: (...args: never[]) => unknown,
  ): CallSite | undefined {
    this.stackCaptures += 1;

    let frame: RawStackFrame | undefined;
    try {
      frame = this.captureFrameFn(skipAbove);
    } catch (err) {
      this.reportError("Failed to capture stack frame for call site", err);
      return undefined;
    }

    if (!frame) {
      return undefined;
    }

    let mapped: SourceMapLookupResult | undefined;
    try {
      mapped = this.customResolveSourceMap
        ? this.customResolveSourceMap(frame)
        : this.resolveSourceMapDefault(frame);
    } catch (err) {
      this.reportError("Failed to resolve source map for call site", err);
      return undefined;
    }

    if (
      !mapped ||
      typeof mapped.file !== "string" ||
      mapped.file.length === 0 ||
      typeof mapped.line !== "number" ||
      !Number.isInteger(mapped.line) ||
      mapped.line < 0
    ) {
      return undefined;
    }

    const callsite: CallSite = {
      file: mapped.file,
      line: mapped.line,
    };
    if (
      typeof mapped.column === "number" &&
      Number.isInteger(mapped.column) &&
      mapped.column >= 0
    ) {
      callsite.column = mapped.column;
    }
    if (typeof frame.functionName === "string" && frame.functionName.length > 0) {
      callsite.function = frame.functionName;
    }
    return callsite;
  }

  private resolveSourceMapDefault(
    frame: RawStackFrame,
  ): SourceMapLookupResult | undefined {
    const filePath = safeFileUrlToPath(frame.fileName);
    const fileUrl = safePathToFileUrl(filePath);

    // 1. Prefer Node's in-memory source-map registry (`--enable-source-maps` or loader hooks).
    if (typeof moduleApi.findSourceMap === "function") {
      let nodeMap: moduleApi.SourceMap | undefined;
      try {
        nodeMap =
          moduleApi.findSourceMap(frame.fileName) ??
          (filePath !== frame.fileName ? moduleApi.findSourceMap(filePath) : undefined) ??
          (fileUrl && fileUrl !== frame.fileName
            ? moduleApi.findSourceMap(fileUrl)
            : undefined);
      } catch (err) {
        this.reportError("Node findSourceMap lookup failed", err);
        nodeMap = undefined;
      }

      if (nodeMap) {
        const entry = lookupEntry(nodeMap, frame.lineNumber, frame.columnNumber);
        if (!entry) {
          return undefined;
        }
        return {
          file: safeFileUrlToPath(entry.originalSource!),
          line: entry.originalLine! + 1,
          ...(typeof entry.originalColumn === "number" && entry.originalColumn >= 0
            ? { column: entry.originalColumn + 1 }
            : {}),
        };
      }
    }

    // 2. Fall back to deployed `.map` / inline `sourceMappingURL` via `node:module`'s `SourceMap`,
    //    cached once per compiled file path.
    if (typeof moduleApi.SourceMap !== "function" || !path.isAbsolute(filePath)) {
      return undefined;
    }

    const diskEntry = this.getOrLoadDiskSourceMap(filePath);
    if (!diskEntry) {
      return undefined;
    }

    const entry = lookupEntry(diskEntry.map, frame.lineNumber, frame.columnNumber);
    if (!entry) {
      return undefined;
    }

    const resolvedFile = resolveOriginalSourcePath(
      entry.originalSource!,
      diskEntry.mapDir,
      diskEntry.sourceRoot,
    );
    return {
      file: resolvedFile,
      line: entry.originalLine! + 1,
      ...(typeof entry.originalColumn === "number" && entry.originalColumn >= 0
        ? { column: entry.originalColumn + 1 }
        : {}),
    };
  }

  private getOrLoadDiskSourceMap(filePath: string): CachedDiskSourceMap | null {
    if (this.sourceMapCache.has(filePath)) {
      const cached = this.sourceMapCache.get(filePath) ?? null;
      this.sourceMapCache.delete(filePath);
      this.sourceMapCache.set(filePath, cached);
      return cached;
    }

    const loaded = this.loadDiskSourceMap(filePath);
    if (this.sourceMapCache.size >= this.maxSourceMapCacheEntries) {
      const oldest = this.sourceMapCache.keys().next().value;
      if (oldest !== undefined) {
        this.sourceMapCache.delete(oldest);
      }
    }
    this.sourceMapCache.set(filePath, loaded);
    return loaded;
  }

  private loadDiskSourceMap(filePath: string): CachedDiskSourceMap | null {
    let sourceText: string;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > MAX_SOURCE_FILE_BYTES) {
        return null;
      }
      sourceText = fs.readFileSync(filePath, "utf8");
    } catch {
      return null;
    }

    const mappingUrl = extractTrailingSourceMappingUrl(sourceText);
    if (!mappingUrl) {
      return null;
    }

    const jsDir = path.dirname(filePath);

    if (mappingUrl.startsWith("data:")) {
      try {
        const payload = decodeInlineSourceMap(mappingUrl);
        const map = new moduleApi.SourceMap(payload);
        return {
          map,
          mapDir: jsDir,
          sourceRoot:
            typeof payload.sourceRoot === "string" ? payload.sourceRoot : undefined,
        };
      } catch (err) {
        this.reportError(
          `Failed to parse inline source map in ${filePath}`,
          err,
        );
        return null;
      }
    }

    if (mappingUrl.startsWith("http://") || mappingUrl.startsWith("https://")) {
      return null;
    }

    let mapPath: string;
    if (mappingUrl.startsWith("file://")) {
      mapPath = safeFileUrlToPath(mappingUrl);
    } else {
      const cleanRef = mappingUrl.split(/[?#]/, 1)[0] ?? mappingUrl;
      let decodedRef = cleanRef;
      try {
        decodedRef = decodeURIComponent(cleanRef);
      } catch {
        decodedRef = cleanRef;
      }
      mapPath = path.resolve(jsDir, decodedRef);
    }

    let rawMapText: string;
    try {
      rawMapText = fs.readFileSync(mapPath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        // Source map file is not deployed; omit callsite cleanly per §6.
        return null;
      }
      this.reportError(`Failed to read source map ${mapPath}`, err);
      return null;
    }

    try {
      const payload = JSON.parse(rawMapText) as moduleApi.SourceMapPayload;
      const map = new moduleApi.SourceMap(payload);
      return {
        map,
        mapDir: path.dirname(mapPath),
        sourceRoot:
          typeof payload.sourceRoot === "string" ? payload.sourceRoot : undefined,
      };
    } catch (err) {
      this.reportError(`Failed to parse source map ${mapPath}`, err);
      return null;
    }
  }

  private reportError(message: string, cause: unknown): void {
    if (!this.onError) {
      return;
    }
    try {
      this.onError({
        code: "callsite_error",
        message,
        cause,
      });
    } catch {
      // Never allow user diagnostic callbacks to throw into customer code.
    }
  }
}
