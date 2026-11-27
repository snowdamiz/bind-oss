import crypto from "node:crypto";

export const DEFAULT_CONTEXT = {
  hmac_keys: {
    edge: "bind-conformance-edge-key-v1",
    server: "bind-conformance-server-key-v1",
  },
  reference_ts_ms: Date.UTC(2026, 10, 26, 14, 0, 0, 0), // 2026-11-26T14:00:00.000Z = 1795701600000
};

export const SQL_REFUSAL_JSON_HOLE = {
  supported: false,
  refusal_code: "unsupported_json_hole",
  reason:
    "Specs containing a text json hole are refused by the ClickHouse SQL compiler because balanced JSON text scanning is not supported in SQL compilation.",
};

export function f64Hex(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error(`f64Hex expects finite double, got ${n}`);
  }
  const buf = Buffer.alloc(8);
  buf.writeDoubleBE(n, 0);
  return buf.toString("hex");
}

export function hmacTag(value, hmacKeys = DEFAULT_CONTEXT.hmac_keys) {
  const inner = crypto
    .createHmac("sha256", Buffer.from(hmacKeys.edge, "utf8"))
    .update(Buffer.from(value, "utf8"))
    .digest();
  return crypto
    .createHmac("sha256", Buffer.from(hmacKeys.server, "utf8"))
    .update(inner)
    .digest("hex")
    .slice(0, 16);
}

export const okStr = (value) => ({ status: "ok", type: "string", value });
export const okEnum = (value) => ({ status: "ok", type: "enum", value });
export const okInt = (value) => ({ status: "ok", type: "int", value: String(value) });
export const okFloat = (num) => ({ status: "ok", type: "float", value: f64Hex(num) });
export const okFloatHex = (hex) => ({ status: "ok", type: "float", value: hex });
export const okBool = (value) => ({ status: "ok", type: "bool", value });
export const okTs = (ms) => ({ status: "ok", type: "timestamp", value: ms });
export const okJson = (value) => ({ status: "ok", type: "json", value });

export const redacted = (token) => ({ status: "redacted", token });
export const dropped = () => ({ status: "dropped" });
export const missing = () => ({ status: "missing" });
export const parseErr = (code) => ({ status: "parse_error", code });

export const match = (fields) => ({ matched: true, fields });
export const noMatch = () => ({ matched: false });

export function field(opts) {
  const out = {
    id: opts.id ?? "fld_01VEC00001",
    name: opts.name,
    from: opts.from,
    type: opts.type,
    semantic: opts.semantic ?? "unknown",
  };
  if (opts.entity !== undefined) out.entity = opts.entity;
  if (opts.unit !== undefined) out.unit = opts.unit;
  if (opts.pii !== undefined) out.pii = opts.pii;
  if (opts.transforms !== undefined) out.transforms = opts.transforms;
  if (opts.confidence !== undefined) out.confidence = opts.confidence;
  if (opts.evidence !== undefined) out.evidence = opts.evidence;
  return out;
}

export function textSpec({
  template = "tpl_01VEC00001",
  event = "conformance.text",
  version = 1,
  status = "active",
  origin = "agent",
  source = { kind: "mined" },
  segments,
  fields,
  sampleLine,
  sampleExpect,
}) {
  return {
    spec_version: 1,
    template,
    event,
    version,
    status,
    origin,
    source,
    match: {
      kind: "text",
      segments,
    },
    fields,
    tests: [{ line: sampleLine, expect: sampleExpect }],
  };
}

export function objectSpec({
  template = "tpl_01VECOBJ01",
  event = "conformance.object",
  version = 1,
  status = "active",
  origin = "agent",
  source = { kind: "mined" },
  shape,
  message,
  fields,
  sampleObject,
  sampleExpect,
}) {
  const matchObj = { kind: "object", shape };
  if (message) matchObj.message = message;
  return {
    spec_version: 1,
    template,
    event,
    version,
    status,
    origin,
    source,
    match: matchObj,
    fields,
    tests: [{ object: sampleObject, expect: sampleExpect }],
  };
}

export function argsSpec({
  template = "tpl_01VECARG01",
  event = "conformance.args",
  version = 1,
  status = "active",
  origin = "agent",
  source = { kind: "sdk_template" },
  strings,
  fields,
  sampleArgs,
  sampleExpect,
}) {
  return {
    spec_version: 1,
    template,
    event,
    version,
    status,
    origin,
    source,
    match: {
      kind: "args",
      strings,
    },
    fields,
    tests: [{ args: sampleArgs, expect: sampleExpect }],
  };
}

function hasJsonHoleInSpec(spec) {
  const segs =
    spec.match.kind === "text"
      ? spec.match.segments
      : spec.match.kind === "object" && spec.match.message
        ? spec.match.message.segments
        : [];
  return segs.some((s) => "hole" in s && s.class === "json");
}

export function vec({ id, description, tags, spec, input, expected, context }) {
  const isJsonRefused = hasJsonHoleInSpec(spec);
  const tagSet = new Set(tags);
  tagSet.add(`match:${spec.match.kind}`);
  if (isJsonRefused) {
    tagSet.add("sql:refuse");
    tagSet.add("sql:refuse:json_hole");
  }
  const out = {
    id,
    description,
    tags: [...tagSet],
    sql: isJsonRefused ? { ...SQL_REFUSAL_JSON_HOLE } : { supported: true },
    spec,
    input,
    expected,
  };
  if (context) out.context = context;
  return out;
}

export function textInput(line) {
  return { kind: "text", line };
}

export function objectInput(object) {
  return { kind: "object", object };
}

export function argsInput(strings, args) {
  return { kind: "args", strings, args };
}
