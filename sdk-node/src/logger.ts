import { CallSiteResolver } from "./callsite.js";
import {
  normalizeStructuredFields,
  normalizeTemplateArgs,
  renderTemplateBody,
} from "./serialize.js";
import {
  Severity,
  type CallSite,
  type CallSiteResolverOptions,
  type JsonObject,
  type LogCallOptions,
  type Logger,
  type LoggerContext,
  type LoggerOptions,
  type LogMethod,
  type LogRecordInput,
  type RecordAttrs,
  type RecordSink,
  type SeverityNumber,
  type StructuredFields,
  type TimestampInput,
  type TransportError,
} from "./types.js";

export interface CreateLoggerOptions extends Omit<LoggerOptions, "callsite"> {
  callsite?: CallSiteResolver | CallSiteResolverOptions;
}

interface NormalizedContext {
  readonly attrs?: RecordAttrs;
  readonly trace_id?: string;
  readonly span_id?: string;
  readonly fields?: JsonObject;
}

export interface InternalLoggerTarget {
  emit(
    severity: SeverityNumber,
    skipAbove: (...args: never[]) => unknown,
    boundContexts: readonly LoggerContext[] | undefined,
    first: unknown,
    rest: readonly unknown[],
  ): boolean;
}

function reportErrorSafe(
  onError: ((error: TransportError) => void) | undefined,
  error: TransportError,
): void {
  if (!onError) {
    return;
  }
  try {
    onError(error);
  } catch {
    // Never allow diagnostic callbacks to throw into customer code.
  }
}

export function isTemplateStringsArray(value: unknown): value is TemplateStringsArray {
  return (
    Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "raw") &&
    Array.isArray((value as { raw?: unknown }).raw)
  );
}

function extractTemplateStrings(templateStrings: TemplateStringsArray): string[] {
  const out: string[] = new Array(templateStrings.length);
  for (let i = 0; i < templateStrings.length; i += 1) {
    const cooked = templateStrings[i];
    if (typeof cooked === "string") {
      out[i] = cooked;
    } else {
      const raw = templateStrings.raw[i];
      out[i] = typeof raw === "string" ? raw : "";
    }
  }
  return out;
}

function isPlainFieldsCandidate(value: unknown): value is StructuredFields {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (
    Array.isArray(value) ||
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Error ||
    value instanceof Map ||
    value instanceof Set ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer
  ) {
    return false;
  }
  return true;
}

function sanitizeAttrsMap(
  raw: unknown,
  onError: ((error: TransportError) => void) | undefined,
  sourceLabel: string,
): RecordAttrs | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    reportErrorSafe(onError, {
      code: "capture_error",
      message: `${sourceLabel} attrs must be a string map`,
    });
    return undefined;
  }

  let keys: string[];
  try {
    keys = Object.keys(raw);
  } catch (err) {
    reportErrorSafe(onError, {
      code: "capture_error",
      message: `Failed to enumerate ${sourceLabel} attrs`,
      cause: err,
    });
    return undefined;
  }

  const out: RecordAttrs = {};
  let count = 0;
  for (const key of keys) {
    try {
      const val = (raw as Record<string, unknown>)[key];
      if (val === undefined) {
        continue;
      }
      if (typeof val !== "string") {
        reportErrorSafe(onError, {
          code: "capture_error",
          message: `${sourceLabel} attrs[${JSON.stringify(key)}] must be a string`,
        });
        continue;
      }
      out[key] = val;
      count += 1;
    } catch (err) {
      reportErrorSafe(onError, {
        code: "capture_error",
        message: `Failed to read ${sourceLabel} attrs[${JSON.stringify(key)}]`,
        cause: err,
      });
    }
  }

  return count > 0 ? out : undefined;
}

function mergeAttrs(
  base: RecordAttrs | undefined,
  override: RecordAttrs | undefined,
): RecordAttrs | undefined {
  if (!base && !override) {
    return undefined;
  }
  if (!base) {
    return { ...override };
  }
  if (!override) {
    return { ...base };
  }
  return { ...base, ...override };
}

function sanitizeOptionalString(
  value: unknown,
  fieldName: string,
  onError: ((error: TransportError) => void) | undefined,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    reportErrorSafe(onError, {
      code: "capture_error",
      message: `Log option ${fieldName} must be a string`,
    });
    return undefined;
  }
  return value;
}

function sanitizeOptionalCallSite(
  value: unknown,
  onError: ((error: TransportError) => void) | undefined,
): CallSite | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    reportErrorSafe(onError, {
      code: "capture_error",
      message: "Log option callsite must be an object",
    });
    return undefined;
  }
  const candidate = value as Partial<CallSite>;
  if (
    typeof candidate.file !== "string" ||
    candidate.file.length === 0 ||
    typeof candidate.line !== "number" ||
    !Number.isInteger(candidate.line) ||
    candidate.line < 0
  ) {
    reportErrorSafe(onError, {
      code: "capture_error",
      message: "Log option callsite must have valid file and non-negative integer line",
    });
    return undefined;
  }
  const out: CallSite = {
    file: candidate.file,
    line: candidate.line,
  };
  if (candidate.column !== undefined) {
    if (
      typeof candidate.column === "number" &&
      Number.isInteger(candidate.column) &&
      candidate.column >= 0
    ) {
      out.column = candidate.column;
    } else {
      reportErrorSafe(onError, {
        code: "capture_error",
        message: "Log option callsite.column must be a non-negative integer",
      });
    }
  }
  if (candidate.function !== undefined) {
    if (typeof candidate.function === "string") {
      out.function = candidate.function;
    } else {
      reportErrorSafe(onError, {
        code: "capture_error",
        message: "Log option callsite.function must be a string",
      });
    }
  }
  return out;
}

function normalizeLoggerContext(
  context: LoggerContext | undefined,
  onError: ((error: TransportError) => void) | undefined,
): NormalizedContext | undefined {
  if (!context || typeof context !== "object") {
    return undefined;
  }
  const attrs = sanitizeAttrsMap(context.attrs, onError, "Logger context");
  const trace_id = sanitizeOptionalString(context.trace_id, "trace_id", onError);
  const span_id = sanitizeOptionalString(context.span_id, "span_id", onError);
  let fields: JsonObject | undefined;
  if (context.fields !== undefined && context.fields !== null) {
    if (isPlainFieldsCandidate(context.fields)) {
      fields = normalizeStructuredFields(context.fields, onError);
    } else {
      reportErrorSafe(onError, {
        code: "capture_error",
        message: "Logger context fields must be a plain object",
      });
    }
  }

  if (!attrs && trace_id === undefined && span_id === undefined && !fields) {
    return undefined;
  }
  return {
    ...(attrs ? { attrs } : {}),
    ...(trace_id !== undefined ? { trace_id } : {}),
    ...(span_id !== undefined ? { span_id } : {}),
    ...(fields ? { fields } : {}),
  };
}

function normalizeContextChain(
  contexts: readonly LoggerContext[] | undefined,
  onError: ((error: TransportError) => void) | undefined,
): NormalizedContext | undefined {
  if (!contexts || contexts.length === 0) {
    return undefined;
  }
  let attrs: RecordAttrs | undefined;
  let trace_id: string | undefined;
  let span_id: string | undefined;
  let fields: JsonObject | undefined;

  for (const raw of contexts) {
    const norm = normalizeLoggerContext(raw, onError);
    if (!norm) {
      continue;
    }
    attrs = mergeAttrs(attrs, norm.attrs);
    if (norm.trace_id !== undefined) {
      trace_id = norm.trace_id;
    }
    if (norm.span_id !== undefined) {
      span_id = norm.span_id;
    }
    if (norm.fields) {
      fields = fields ? { ...fields, ...norm.fields } : { ...norm.fields };
    }
  }

  if (!attrs && trace_id === undefined && span_id === undefined && !fields) {
    return undefined;
  }
  return {
    ...(attrs ? { attrs } : {}),
    ...(trace_id !== undefined ? { trace_id } : {}),
    ...(span_id !== undefined ? { span_id } : {}),
    ...(fields ? { fields } : {}),
  };
}

function snapshotRawContext(context: LoggerContext | undefined): LoggerContext | undefined {
  if (!context || typeof context !== "object") {
    return undefined;
  }
  const out: {
    attrs?: RecordAttrs;
    trace_id?: string;
    span_id?: string;
    fields?: StructuredFields;
  } = {};
  try {
    const rawAttrs = context.attrs;
    if (rawAttrs && typeof rawAttrs === "object" && !Array.isArray(rawAttrs)) {
      try {
        out.attrs = { ...rawAttrs };
      } catch {
        // Preserve original reference so emit reports the getter failure via onError.
        out.attrs = rawAttrs;
      }
    } else if (rawAttrs !== undefined) {
      out.attrs = rawAttrs;
    }
  } catch {
    return context;
  }
  try {
    if (context.trace_id !== undefined) {
      out.trace_id = context.trace_id;
    }
    if (context.span_id !== undefined) {
      out.span_id = context.span_id;
    }
  } catch {
    return context;
  }
  try {
    const rawFields = context.fields;
    if (isPlainFieldsCandidate(rawFields)) {
      try {
        out.fields = { ...rawFields };
      } catch {
        // Preserve original reference so emit reports the getter failure via onError.
        out.fields = rawFields;
      }
    } else if (rawFields !== undefined) {
      out.fields = rawFields;
    }
  } catch {
    return context;
  }
  return out;
}

/**
 * Builds a deterministic shape key for structured-event call-site caching:
 * severity + length-prefixed event name + sorted field keys.
 */
export function buildStructuredShapeKey(
  severity: SeverityNumber,
  event: string,
  fields: Readonly<Record<string, unknown>>,
): string {
  const keys = Object.keys(fields).sort();
  return `event:${severity}:${event.length}:${event}:${keys.join("\0")}`;
}

export class BindLoggerCore implements InternalLoggerTarget {
  readonly callsiteResolver: CallSiteResolver;
  private readonly sink: RecordSink;
  private readonly onError?: (error: TransportError) => void;
  private readonly baseContext?: NormalizedContext;

  constructor(sink: RecordSink, options: CreateLoggerOptions = {}) {
    this.sink = sink;
    this.onError = options.onError;
    if (options.callsite instanceof CallSiteResolver) {
      this.callsiteResolver = options.callsite;
    } else {
      const csOpts: CallSiteResolverOptions = {
        ...options.callsite,
        onError: options.callsite?.onError ?? options.onError,
      };
      this.callsiteResolver = new CallSiteResolver(csOpts);
    }
    this.baseContext = normalizeLoggerContext(options.context, this.onError);
  }

  emit(
    severity: SeverityNumber,
    skipAbove: (...args: never[]) => unknown,
    boundContexts: readonly LoggerContext[] | undefined,
    first: unknown,
    rest: readonly unknown[],
  ): boolean {
    try {
      const extraContext = normalizeContextChain(boundContexts, this.onError);

      if (isTemplateStringsArray(first)) {
        return this.emitTaggedTemplate(severity, skipAbove, extraContext, first, rest);
      }

      if (typeof first === "string") {
        return this.emitStructuredEvent(
          severity,
          skipAbove,
          extraContext,
          first,
          rest[0],
          rest[1],
        );
      }

      reportErrorSafe(this.onError, {
        code: "capture_error",
        message: `Expected tagged template or string event name, received ${first === null ? "null" : typeof first}`,
      });
      return false;
    } catch (err) {
      reportErrorSafe(this.onError, {
        code: "capture_error",
        message: err instanceof Error ? err.message : "Unexpected log capture failure",
        cause: err,
      });
      return false;
    }
  }

  private emitTaggedTemplate(
    severity: SeverityNumber,
    skipAbove: (...args: never[]) => unknown,
    extraContext: NormalizedContext | undefined,
    templateStrings: TemplateStringsArray,
    rawArgs: readonly unknown[],
  ): boolean {
    const strings = extractTemplateStrings(templateStrings);
    const args = normalizeTemplateArgs(rawArgs, this.onError);
    const body = renderTemplateBody(strings, rawArgs, args, this.onError);
    const callsite = this.callsiteResolver.resolveForTemplate(templateStrings, skipAbove);

    const attrs = mergeAttrs(this.baseContext?.attrs, extraContext?.attrs);
    const trace_id = extraContext?.trace_id ?? this.baseContext?.trace_id;
    const span_id = extraContext?.span_id ?? this.baseContext?.span_id;

    const record: LogRecordInput = {
      severity,
      body,
      tpl: { strings, args },
      ...(callsite ? { callsite } : {}),
      ...(attrs ? { attrs } : {}),
      ...(trace_id !== undefined ? { trace_id } : {}),
      ...(span_id !== undefined ? { span_id } : {}),
    };

    return this.enqueueSafely(record);
  }

  private emitStructuredEvent(
    severity: SeverityNumber,
    skipAbove: (...args: never[]) => unknown,
    extraContext: NormalizedContext | undefined,
    event: string,
    rawFields: unknown,
    rawOptions: unknown,
  ): boolean {
    let callFields: JsonObject = {};
    if (rawFields !== undefined && rawFields !== null) {
      if (!isPlainFieldsCandidate(rawFields)) {
        reportErrorSafe(this.onError, {
          code: "capture_error",
          message: "Structured log fields must be a plain object",
        });
        return false;
      }
      callFields = normalizeStructuredFields(rawFields, this.onError);
    }

    let mergedFields: JsonObject;
    if (this.baseContext?.fields || extraContext?.fields) {
      mergedFields = {
        ...(this.baseContext?.fields ?? {}),
        ...(extraContext?.fields ?? {}),
        ...callFields,
      };
    } else {
      mergedFields = callFields;
    }

    let callAttrs: RecordAttrs | undefined;
    let callTraceId: string | undefined;
    let callSpanId: string | undefined;
    let callTs: TimestampInput | undefined;
    let explicitCallsite: CallSite | undefined;

    if (rawOptions !== undefined && rawOptions !== null) {
      if (typeof rawOptions !== "object" || Array.isArray(rawOptions)) {
        reportErrorSafe(this.onError, {
          code: "capture_error",
          message: "Log call options must be an object",
        });
      } else {
        const opts = rawOptions as LogCallOptions;
        callAttrs = sanitizeAttrsMap(opts.attrs, this.onError, "Log call");
        callTraceId = sanitizeOptionalString(opts.trace_id, "trace_id", this.onError);
        callSpanId = sanitizeOptionalString(opts.span_id, "span_id", this.onError);
        explicitCallsite = sanitizeOptionalCallSite(opts.callsite, this.onError);
        if (opts.ts !== undefined) {
          callTs = opts.ts;
        }
      }
    }

    const shapeKey = buildStructuredShapeKey(severity, event, mergedFields);
    const callsite =
      explicitCallsite ?? this.callsiteResolver.resolveForShape(shapeKey, skipAbove);

    const attrs = mergeAttrs(
      mergeAttrs(this.baseContext?.attrs, extraContext?.attrs),
      callAttrs,
    );
    const trace_id =
      callTraceId ?? extraContext?.trace_id ?? this.baseContext?.trace_id;
    const span_id =
      callSpanId ?? extraContext?.span_id ?? this.baseContext?.span_id;

    const body: JsonObject = {
      event,
      fields: mergedFields,
    };

    const record: LogRecordInput = {
      severity,
      body,
      tpl: { strings: [event], args: [] },
      ...(callTs !== undefined ? { ts: callTs } : {}),
      ...(callsite ? { callsite } : {}),
      ...(attrs ? { attrs } : {}),
      ...(trace_id !== undefined ? { trace_id } : {}),
      ...(span_id !== undefined ? { span_id } : {}),
    };

    return this.enqueueSafely(record);
  }

  private enqueueSafely(record: LogRecordInput): boolean {
    try {
      return this.sink.enqueue(record);
    } catch (err) {
      reportErrorSafe(this.onError, {
        code: "capture_error",
        message: err instanceof Error ? err.message : "RecordSink.enqueue() threw",
        cause: err,
      });
      return false;
    }
  }
}

function makeMethod(
  severity: SeverityNumber,
  getTarget: () => InternalLoggerTarget | undefined,
  boundContexts: readonly LoggerContext[] | undefined,
): LogMethod {
  const method = function logMethod(
    first: unknown,
    ...rest: readonly unknown[]
  ): boolean {
    const target = getTarget();
    if (!target) {
      return false;
    }
    return target.emit(severity, method, boundContexts, first, rest);
  };
  return method as LogMethod;
}

/**
 * Creates a `Logger` facade over a dynamic target getter (used by both
 * `createLogger` and the module-level `log` facade bound to `getClient()`).
 */
export function createBoundLogger(
  getTarget: () => InternalLoggerTarget | undefined,
  boundContexts?: readonly LoggerContext[],
): Logger {
  const logger: Logger = {
    trace: makeMethod(Severity.TRACE, getTarget, boundContexts),
    debug: makeMethod(Severity.DEBUG, getTarget, boundContexts),
    info: makeMethod(Severity.INFO, getTarget, boundContexts),
    warn: makeMethod(Severity.WARN, getTarget, boundContexts),
    error: makeMethod(Severity.ERROR, getTarget, boundContexts),
    fatal: makeMethod(Severity.FATAL, getTarget, boundContexts),
    child(context: LoggerContext): Logger {
      const snap = snapshotRawContext(context);
      const nextChain = snap
        ? boundContexts
          ? [...boundContexts, snap]
          : [snap]
        : boundContexts;
      return createBoundLogger(getTarget, nextChain);
    },
  };
  return Object.freeze(logger);
}

/**
 * Creates a standalone `Logger` writing captured records into the provided `RecordSink`.
 */
export function createLogger(
  sink: RecordSink,
  options: CreateLoggerOptions = {},
): Logger {
  const core = new BindLoggerCore(sink, options);
  return createBoundLogger(() => core);
}
