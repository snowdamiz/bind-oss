import type { JsonArray, JsonObject, JsonValue, TransportError } from "./types.js";

export const MAX_NORMALIZE_DEPTH = 32;

const CIRCULAR_PLACEHOLDER = "[Circular]";
const MAX_DEPTH_PLACEHOLDER = "[MaxDepth]";
const UNSERIALIZABLE_PLACEHOLDER = "[Unserializable]";

export type CaptureErrorReporter = (error: TransportError) => void;

function reportCaptureError(
  onError: CaptureErrorReporter | undefined,
  message: string,
  cause: unknown,
): void {
  if (!onError) {
    return;
  }
  try {
    onError({
      code: "capture_error",
      message,
      cause,
    });
  } catch {
    // Never allow diagnostic callbacks to throw into customer code.
  }
}

function normalizeErrorObject(
  err: Error,
  ancestors: Set<object>,
  depth: number,
  onError?: CaptureErrorReporter,
): JsonObject {
  const out: JsonObject = {};

  let name = "Error";
  try {
    if (typeof err.name === "string" && err.name.length > 0) {
      name = err.name;
    }
  } catch (readErr) {
    reportCaptureError(onError, "Failed to read Error.name during log capture", readErr);
  }
  out.name = name;

  let message = "";
  try {
    if (typeof err.message === "string") {
      message = err.message;
    }
  } catch (readErr) {
    reportCaptureError(
      onError,
      "Failed to read Error.message during log capture",
      readErr,
    );
  }
  out.message = message;

  try {
    if (typeof err.stack === "string" && err.stack.length > 0) {
      out.stack = err.stack;
    }
  } catch (readErr) {
    reportCaptureError(onError, "Failed to read Error.stack during log capture", readErr);
  }

  try {
    const errWithCause = err as Error & { cause?: unknown; code?: unknown };
    if (errWithCause.code !== undefined) {
      out.code = normalizeInternal(errWithCause.code, ancestors, depth + 1, onError);
    }
    if (errWithCause.cause !== undefined) {
      out.cause = normalizeInternal(errWithCause.cause, ancestors, depth + 1, onError);
    }
  } catch (readErr) {
    reportCaptureError(
      onError,
      "Failed to read Error metadata during log capture",
      readErr,
    );
  }

  let keys: string[];
  try {
    keys = Object.keys(err);
  } catch (keysErr) {
    reportCaptureError(onError, "Failed to enumerate Error keys during log capture", keysErr);
    return out;
  }

  for (const key of keys) {
    if (
      key === "name" ||
      key === "message" ||
      key === "stack" ||
      key === "code" ||
      key === "cause"
    ) {
      continue;
    }
    try {
      const prop = (err as unknown as Record<string, unknown>)[key];
      if (prop !== undefined) {
        out[key] = normalizeInternal(prop, ancestors, depth + 1, onError);
      }
    } catch (propErr) {
      reportCaptureError(
        onError,
        `Failed to read Error property ${JSON.stringify(key)} during log capture`,
        propErr,
      );
      out[key] = UNSERIALIZABLE_PLACEHOLDER;
    }
  }

  return out;
}

function normalizeInternal(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
  onError?: CaptureErrorReporter,
): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }

  const kind = typeof value;
  if (kind === "string" || kind === "boolean") {
    return value as string | boolean;
  }
  if (kind === "number") {
    const num = value as number;
    if (!Number.isFinite(num)) {
      return String(num);
    }
    return Object.is(num, -0) ? 0 : num;
  }
  if (kind === "bigint") {
    return (value as bigint).toString(10);
  }
  if (kind === "symbol") {
    return (value as symbol).toString();
  }
  if (kind === "function") {
    const fn = value as (...args: unknown[]) => unknown;
    return fn.name ? `[Function: ${fn.name}]` : "[Function]";
  }

  const obj = value as object;

  if (obj instanceof Date) {
    try {
      const time = obj.getTime();
      return Number.isNaN(time) ? "Invalid Date" : obj.toISOString();
    } catch (err) {
      reportCaptureError(onError, "Failed to serialize Date during log capture", err);
      return UNSERIALIZABLE_PLACEHOLDER;
    }
  }

  if (obj instanceof RegExp) {
    try {
      return obj.toString();
    } catch (err) {
      reportCaptureError(onError, "Failed to serialize RegExp during log capture", err);
      return UNSERIALIZABLE_PLACEHOLDER;
    }
  }

  if (obj instanceof URL) {
    try {
      return obj.href;
    } catch (err) {
      reportCaptureError(onError, "Failed to serialize URL during log capture", err);
      return UNSERIALIZABLE_PLACEHOLDER;
    }
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(obj)) {
    return `[Buffer(${obj.byteLength})]`;
  }

  if (ArrayBuffer.isView(obj)) {
    const ctorName = obj.constructor?.name || "TypedArray";
    return `[${ctorName}(${obj.byteLength})]`;
  }

  if (obj instanceof ArrayBuffer) {
    return `[ArrayBuffer(${obj.byteLength})]`;
  }

  if (depth >= MAX_NORMALIZE_DEPTH) {
    return MAX_DEPTH_PLACEHOLDER;
  }

  if (ancestors.has(obj)) {
    return CIRCULAR_PLACEHOLDER;
  }

  ancestors.add(obj);
  try {
    if (obj instanceof Error) {
      return normalizeErrorObject(obj, ancestors, depth, onError);
    }

    if (Array.isArray(obj)) {
      const out: JsonArray = new Array(obj.length);
      for (let i = 0; i < obj.length; i += 1) {
        try {
          out[i] = normalizeInternal(obj[i], ancestors, depth + 1, onError);
        } catch (err) {
          reportCaptureError(
            onError,
            `Failed to read array element [${i}] during log capture`,
            err,
          );
          out[i] = UNSERIALIZABLE_PLACEHOLDER;
        }
      }
      return out;
    }

    if (obj instanceof Set) {
      const out: JsonArray = [];
      for (const item of obj) {
        out.push(normalizeInternal(item, ancestors, depth + 1, onError));
      }
      return out;
    }

    if (obj instanceof Map) {
      const out: JsonObject = {};
      for (const [k, v] of obj.entries()) {
        if (v === undefined) {
          continue;
        }
        const keyStr = typeof k === "string" ? k : String(k);
        out[keyStr] = normalizeInternal(v, ancestors, depth + 1, onError);
      }
      return out;
    }

    let customToJson: unknown;
    try {
      customToJson = (obj as { toJSON?: unknown }).toJSON;
    } catch (err) {
      reportCaptureError(onError, "Failed to access toJSON during log capture", err);
      return UNSERIALIZABLE_PLACEHOLDER;
    }

    if (typeof customToJson === "function") {
      try {
        const converted = (customToJson as () => unknown).call(obj);
        if (converted !== obj) {
          return normalizeInternal(converted, ancestors, depth + 1, onError);
        }
      } catch (err) {
        reportCaptureError(onError, "toJSON() threw during log capture", err);
        return UNSERIALIZABLE_PLACEHOLDER;
      }
    }

    let keys: string[];
    try {
      keys = Object.keys(obj);
    } catch (err) {
      reportCaptureError(onError, "Failed to enumerate object keys during log capture", err);
      return UNSERIALIZABLE_PLACEHOLDER;
    }

    const out: JsonObject = {};
    for (const key of keys) {
      try {
        const prop = (obj as Record<string, unknown>)[key];
        if (prop === undefined) {
          continue;
        }
        out[key] = normalizeInternal(prop, ancestors, depth + 1, onError);
      } catch (err) {
        reportCaptureError(
          onError,
          `Failed to read property ${JSON.stringify(key)} during log capture`,
          err,
        );
        out[key] = UNSERIALIZABLE_PLACEHOLDER;
      }
    }
    return out;
  } finally {
    ancestors.delete(obj);
  }
}

/**
 * Safely converts an arbitrary JavaScript value into a cycle-free, depth-bounded
 * `JsonValue` while preserving typed primitives (`number`, `boolean`, `string`, `null`).
 */
export function normalizeJsonValue(
  value: unknown,
  onError?: CaptureErrorReporter,
): JsonValue {
  return normalizeInternal(value, new Set<object>(), 0, onError);
}

/**
 * Normalizes positional tagged-template arguments into a `JsonValue[]` of the exact
 * same length (converting `undefined` slots to `null` so argument indices stay aligned).
 */
export function normalizeTemplateArgs(
  values: readonly unknown[],
  onError?: CaptureErrorReporter,
): JsonValue[] {
  const out: JsonValue[] = new Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    out[i] = normalizeJsonValue(values[i], onError);
  }
  return out;
}

/**
 * Normalizes a structured event's fields record into a typed `JsonObject` snapshot.
 */
export function normalizeStructuredFields(
  fields: Readonly<Record<string, unknown>>,
  onError?: CaptureErrorReporter,
): JsonObject {
  let keys: string[];
  try {
    keys = Object.keys(fields);
  } catch (err) {
    reportCaptureError(
      onError,
      "Failed to enumerate structured log fields during capture",
      err,
    );
    return {};
  }

  const out: JsonObject = {};
  const ancestors = new Set<object>([fields]);
  try {
    for (const key of keys) {
      try {
        const prop = fields[key];
        if (prop === undefined) {
          continue;
        }
        out[key] = normalizeInternal(prop, ancestors, 1, onError);
      } catch (err) {
        reportCaptureError(
          onError,
          `Failed to read structured log field ${JSON.stringify(key)}`,
          err,
        );
        out[key] = UNSERIALIZABLE_PLACEHOLDER;
      }
    }
  } finally {
    ancestors.delete(fields);
  }
  return out;
}

function formatArgForBody(
  rawValue: unknown,
  normalizedValue: JsonValue,
  onError?: CaptureErrorReporter,
): string {
  if (rawValue === undefined) {
    return "undefined";
  }
  if (rawValue === null) {
    return "null";
  }
  const kind = typeof rawValue;
  if (kind === "string") {
    return rawValue as string;
  }
  if (kind === "number" || kind === "boolean" || kind === "bigint") {
    return String(rawValue);
  }
  if (kind === "symbol") {
    return (rawValue as symbol).toString();
  }
  if (kind === "function") {
    return typeof normalizedValue === "string" ? normalizedValue : "[Function]";
  }

  if (rawValue instanceof Error) {
    try {
      const name =
        typeof rawValue.name === "string" && rawValue.name.length > 0
          ? rawValue.name
          : "Error";
      const message = typeof rawValue.message === "string" ? rawValue.message : "";
      return message.length > 0 ? `${name}: ${message}` : name;
    } catch (err) {
      reportCaptureError(onError, "Failed to format Error for template body", err);
      return UNSERIALIZABLE_PLACEHOLDER;
    }
  }

  if (typeof normalizedValue === "string") {
    return normalizedValue;
  }

  try {
    return JSON.stringify(normalizedValue);
  } catch (err) {
    reportCaptureError(onError, "Failed to stringify template argument for body", err);
    return UNSERIALIZABLE_PLACEHOLDER;
  }
}

/**
 * Renders a searchable plain-text `body` from tagged-template literal parts
 * and their captured arguments without throwing.
 */
export function renderTemplateBody(
  strings: readonly string[],
  rawArgs: readonly unknown[],
  normalizedArgs: readonly JsonValue[],
  onError?: CaptureErrorReporter,
): string {
  let out = "";
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i] ?? "";
    if (i < rawArgs.length) {
      const norm = i < normalizedArgs.length ? normalizedArgs[i]! : null;
      out += formatArgForBody(rawArgs[i], norm, onError);
    }
  }
  return out;
}
