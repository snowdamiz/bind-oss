#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { SCHEMAS_DIR, SPEC_ROOT, formatAjvErrors } from "./validate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const VECTORS_DIR = path.join(SPEC_ROOT, "vectors");
export const SUITES_DIR = path.join(VECTORS_DIR, "suites");
export const MANIFEST_PATH = path.join(VECTORS_DIR, "manifest.json");
export const VECTOR_SCHEMA_PATH = path.join(VECTORS_DIR, "vector.schema.json");

export const INT64_MIN = -9223372036854775808n;
export const INT64_MAX = 9223372036854775807n;

export const KNOWN_REDACTION_KINDS = new Set([
  "secret",
  "private_key",
  "jwt",
  "auth_header",
  "vendor_token",
  "kv_secret",
  "url_credentials",
  "high_entropy",
  "card",
  "us_ssn",
  "email",
  "phone",
  "ip",
  "long_digits",
  "name",
  "address",
  "free_text",
  "pseudonymous_id",
  "hash",
  "redacted",
]);

const REDACTION_TOKEN_RE = /^<([a-z][a-z0-9_]*)(?::([^\s<>]+))?>$/;
const REDACTION_TOKEN_PREFIX_RE = /^<([a-z][a-z0-9_]*)(?::([^\s<>]+))?>/;
const HEX16_RE = /^[0-9a-f]{16}$/;
const INNER_HEX64_RE = /^~[0-9a-f]{64}$/;

const MONTHS = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

const TIME_UNIT_NS = {
  ns: 1n,
  us: 1000n,
  ms: 1000000n,
  s: 1000000000n,
  m: 60000000000n,
  h: 3600000000000n,
  d: 86400000000000n,
};

const BYTE_UNIT_B = {
  B: 1n,
  KB: 1000n,
  MB: 1000000n,
  GB: 1000000000n,
  TB: 1000000000000n,
  KiB: 1024n,
  MiB: 1048576n,
  GiB: 1073741824n,
  TiB: 1099511627776n,
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function float64ToHex(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error(`Expected finite number, got ${n}`);
  }
  const buf = Buffer.alloc(8);
  buf.writeDoubleBE(n, 0);
  return buf.toString("hex");
}

export function hexToFloat64(hex) {
  if (!/^[0-9a-f]{16}$/.test(hex)) {
    throw new Error(`Invalid float64 hex: ${hex}`);
  }
  const buf = Buffer.from(hex, "hex");
  return buf.readDoubleBE(0);
}

export function computeHmacTag(value, hmacKeys) {
  const inner = crypto
    .createHmac("sha256", Buffer.from(hmacKeys.edge, "utf8"))
    .update(Buffer.from(value, "utf8"))
    .digest();
  const outer = crypto
    .createHmac("sha256", Buffer.from(hmacKeys.server, "utf8"))
    .update(inner)
    .digest("hex");
  return outer.slice(0, 16);
}

export function createVectorValidator() {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);

  const commonSchema = readJson(path.join(SCHEMAS_DIR, "common.schema.json"));
  const parserSpecSchema = readJson(path.join(SCHEMAS_DIR, "parser-spec.schema.json"));
  const vectorSuiteSchema = readJson(VECTOR_SCHEMA_PATH);

  ajv.addSchema(commonSchema);
  ajv.addSchema(parserSpecSchema);
  const validateSuiteFn = ajv.compile(vectorSuiteSchema);

  return {
    ajv,
    vectorSuiteSchema,
    validateSuite(doc) {
      const valid = validateSuiteFn(doc);
      const errors = valid ? [] : (validateSuiteFn.errors ?? []);
      return {
        valid,
        errors,
        formattedErrors: formatAjvErrors(errors, doc),
      };
    },
  };
}

export function specHasJsonHole(spec) {
  const segments =
    spec.match.kind === "text"
      ? spec.match.segments
      : spec.match.kind === "object" && spec.match.message
        ? spec.match.message.segments
        : [];
  return segments.some((seg) => "hole" in seg && seg.class === "json");
}

export function checkSpecInvariants(spec) {
  const errors = [];
  const fieldIds = new Set();
  const fieldNames = new Set();

  for (const field of spec.fields) {
    if (fieldIds.has(field.id)) {
      errors.push(`duplicate field id "${field.id}"`);
    }
    fieldIds.add(field.id);
    if (fieldNames.has(field.name)) {
      errors.push(`duplicate field name "${field.name}"`);
    }
    fieldNames.add(field.name);
  }

  const checkSegments = (segments, label) => {
    const holeNames = new Set();
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      const next = segments[i + 1];
      if ("lit" in seg) {
        if (next && "lit" in next) {
          errors.push(`${label}[${i}] and [${i + 1}] are adjacent literal segments`);
        }
      } else {
        if (holeNames.has(seg.hole)) {
          errors.push(`${label}: duplicate hole name "${seg.hole}"`);
        }
        holeNames.add(seg.hole);
        const cls = seg.class ?? "word";
        if (cls === "until" && (!next || !("lit" in next))) {
          errors.push(`${label}[${i}]: "until" hole "${seg.hole}" must be followed by a literal segment`);
        }
        if (cls === "rest" && i !== segments.length - 1) {
          errors.push(`${label}[${i}]: "rest" hole "${seg.hole}" must be the final segment`);
        }
      }
    }
    return holeNames;
  };

  if (spec.match.kind === "text") {
    const holes = checkSegments(spec.match.segments, "match.segments");
    for (const f of spec.fields) {
      if (!holes.has(f.from.hole)) {
        errors.push(`field "${f.name}" references undeclared hole "${f.from.hole}"`);
      }
    }
  } else if (spec.match.kind === "object") {
    let holes = new Set();
    if (spec.match.message) {
      if (!spec.match.shape.includes(spec.match.message.path)) {
        errors.push(
          `match.message.path "${spec.match.message.path}" is not listed in match.shape`
        );
      }
      holes = checkSegments(spec.match.message.segments, "match.message.segments");
    }
    for (const f of spec.fields) {
      if ("hole" in f.from && !holes.has(f.from.hole)) {
        errors.push(`field "${f.name}" references undeclared message hole "${f.from.hole}"`);
      }
    }
  } else if (spec.match.kind === "args") {
    const argCount = spec.match.strings.length - 1;
    for (const f of spec.fields) {
      if (f.from.arg >= argCount) {
        errors.push(
          `field "${f.name}" references arg ${f.from.arg}, but match.strings allows 0..${argCount - 1}`
        );
      }
    }
  }

  return errors;
}

/* ---------------- Independent Reference Evaluator ---------------- */

function classifyRedactionToken(str) {
  const m = REDACTION_TOKEN_RE.exec(str);
  if (!m) return null;
  const [, kind, tag] = m;
  if (!KNOWN_REDACTION_KINDS.has(kind)) return null;
  if (tag !== undefined && (HEX16_RE.test(tag) || INNER_HEX64_RE.test(tag))) {
    return { token: str, kind, isPseudonym: true };
  }
  return { token: str, kind, isPseudonym: false };
}

function matchKnownRedactionTokenPrefix(line, pos) {
  if (line[pos] !== "<") return null;
  const m = REDACTION_TOKEN_PREFIX_RE.exec(line.slice(pos));
  if (!m) return null;
  const tokenInfo = classifyRedactionToken(m[0]);
  if (!tokenInfo) return null;
  return { raw: m[0], tokenInfo, nextPos: pos + m[0].length };
}

function isAsciiWhitespace(code) {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function parseIpv4(str) {
  const parts = str.split(".");
  if (parts.length !== 4) return null;
  const nums = [];
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums;
}

function parseIpv6(str) {
  if (!str.includes(":")) return null;
  const doubleColonParts = str.split("::");
  if (doubleColonParts.length > 2) return null;

  const parseGroups = (part, allowIpv4Tail) => {
    if (part === "") return [];
    const tokens = part.split(":");
    const groups = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const tok = tokens[i];
      if (allowIpv4Tail && i === tokens.length - 1 && tok.includes(".")) {
        const ipv4 = parseIpv4(tok);
        if (!ipv4) return null;
        groups.push((ipv4[0] << 8) | ipv4[1]);
        groups.push((ipv4[2] << 8) | ipv4[3]);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(tok)) return null;
        groups.push(parseInt(tok, 16));
      }
    }
    return groups;
  };

  if (doubleColonParts.length === 1) {
    const groups = parseGroups(doubleColonParts[0], true);
    if (!groups || groups.length !== 8) return null;
    return groups;
  }

  const left = parseGroups(doubleColonParts[0], false);
  const right = parseGroups(doubleColonParts[1], true);
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...new Array(missing).fill(0), ...right];
}

function formatIpv6Canonical(groups) {
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i += 1) {
    if (groups[i] === 0) {
      if (curStart === -1) curStart = i;
      curLen += 1;
      if (curLen > bestLen) {
        bestStart = curStart;
        bestLen = curLen;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen < 2) {
    return groups.map((g) => g.toString(16)).join(":");
  }
  const left = groups
    .slice(0, bestStart)
    .map((g) => g.toString(16))
    .join(":");
  const right = groups
    .slice(bestStart + bestLen)
    .map((g) => g.toString(16))
    .join(":");
  return `${left}::${right}`;
}

function maskIpPrefix(raw) {
  const ipv4 = parseIpv4(raw);
  if (ipv4) {
    return `${ipv4[0]}.${ipv4[1]}.${ipv4[2]}.0/24`;
  }
  const ipv6 = parseIpv6(raw);
  if (ipv6) {
    const masked = [ipv6[0], ipv6[1], ipv6[2], 0, 0, 0, 0, 0];
    return `${formatIpv6Canonical(masked)}/48`;
  }
  return null;
}

function lexIpAt(line, pos, limit = line.length) {
  // Check IPv4 first (bounded before non-IPv4 chars)
  const rest = line.slice(pos, limit);
  const ipv4Match = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(rest);
  if (ipv4Match && parseIpv4(ipv4Match[1])) {
    // Ensure next char is not a digit or dot (would indicate malformed IPv4 like 1.2.3.4.5)
    const after = rest[ipv4Match[1].length];
    if (after !== "." && !(after >= "0" && after <= "9")) {
      return { raw: ipv4Match[1], nextPos: pos + ipv4Match[1].length };
    }
  }
  // Check IPv6 token characters
  const ipv6Match = /^[0-9a-fA-F:.]+/.exec(rest);
  if (ipv6Match && ipv6Match[0].includes(":") && parseIpv6(ipv6Match[0])) {
    return { raw: ipv6Match[0], nextPos: pos + ipv6Match[0].length };
  }
  return null;
}

function isValidYmdHms(year, month, day, hour, minute, second) {
  if (month < 1 || month > 12) return false;
  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;
  if (second < 0 || second > 59) return false;
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= maxDay;
}

function lexTimeAt(line, pos) {
  const rest = line.slice(pos);
  // ISO 8601 / RFC 3339
  const iso =
    /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2}))/.exec(rest);
  if (iso) {
    return { raw: iso[1], nextPos: pos + iso[1].length };
  }
  // Apache: 26/Nov/2026:14:00:00 +0000
  const apache =
    /^(\d{2}\/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\/\d{4}:\d{2}:\d{2}:\d{2} [+-]\d{4})/.exec(
      rest
    );
  if (apache) {
    return { raw: apache[1], nextPos: pos + apache[1].length };
  }
  // Syslog RFC 3164: Nov 26 14:00:00 or Nov  5 09:05:01
  const syslog =
    /^((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: [1-9]|[12]\d|3[01]) \d{2}:\d{2}:\d{2})/.exec(
      rest
    );
  if (syslog) {
    return { raw: syslog[1], nextPos: pos + syslog[1].length };
  }
  return null;
}

function lexQuotedAt(line, pos) {
  const quote = line[pos];
  if (quote !== '"' && quote !== "'") return null;
  let i = pos + 1;
  let out = "";
  while (i < line.length) {
    const ch = line[i];
    if (ch === "\\") {
      if (i + 1 >= line.length) return null;
      const esc = line[i + 1];
      switch (esc) {
        case "\\":
          out += "\\";
          break;
        case '"':
          out += '"';
          break;
        case "'":
          out += "'";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        default:
          out += esc;
          break;
      }
      i += 2;
      continue;
    }
    if (ch === quote) {
      return { raw: out, rawSlice: line.slice(pos, i + 1), nextPos: i + 1 };
    }
    out += ch;
    i += 1;
  }
  return null;
}

function lexJsonAt(line, pos) {
  const start = line[pos];
  if (start !== "{" && start !== "[") return null;
  const stack = [start === "{" ? "}" : "]"];
  let i = pos + 1;
  let inString = false;
  let escaped = false;

  while (i < line.length && stack.length > 0) {
    const ch = line[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      stack.push("}");
    } else if (ch === "[") {
      stack.push("]");
    } else if (ch === "}" || ch === "]") {
      if (stack[stack.length - 1] !== ch) return null;
      stack.pop();
    }
    i += 1;
  }

  if (stack.length !== 0 || inString) return null;
  const slice = line.slice(pos, i);
  try {
    const parsed = JSON.parse(slice);
    return { raw: slice, parsedJson: parsed, nextPos: i };
  } catch {
    return null;
  }
}

function matchTextSegments(segments, line) {
  let pos = 0;
  const holes = new Map();

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if ("lit" in seg) {
      if (!line.startsWith(seg.lit, pos)) {
        return null;
      }
      pos += seg.lit.length;
      continue;
    }

    const cls = seg.class ?? "word";
    const nextSeg = segments[i + 1];
    const nextLit = nextSeg && "lit" in nextSeg ? nextSeg.lit : null;

    if (cls === "until") {
      const idx = line.indexOf(nextLit, pos);
      if (idx === -1) return null;
      const raw = line.slice(pos, idx);
      const tokenInfo = classifyRedactionToken(raw);
      holes.set(seg.hole, { raw, holeClass: cls, tokenInfo });
      pos = idx;
      continue;
    }

    if (cls === "rest") {
      const raw = line.slice(pos);
      const tokenInfo = classifyRedactionToken(raw);
      holes.set(seg.hole, { raw, holeClass: cls, tokenInfo });
      pos = line.length;
      continue;
    }

    if (cls === "word") {
      // A known redaction token matches a word hole only when bounded by EOL,
      // ASCII whitespace, or the immediately following literal. Unknown angle
      // forms such as <nil> or <b>bold stay ordinary word text.
      const tok = matchKnownRedactionTokenPrefix(line, pos);
      if (
        tok &&
        (tok.nextPos === line.length ||
          isAsciiWhitespace(line.charCodeAt(tok.nextPos)) ||
          (nextLit !== null && line.startsWith(nextLit, tok.nextPos)))
      ) {
        holes.set(seg.hole, { raw: tok.raw, holeClass: cls, tokenInfo: tok.tokenInfo });
        pos = tok.nextPos;
        continue;
      }
      let limit = line.length;
      if (nextLit !== null) {
        const idx = line.indexOf(nextLit, pos);
        if (idx === -1) return null;
        limit = idx;
      }
      let end = pos;
      while (end < limit && !isAsciiWhitespace(line.charCodeAt(end))) {
        end += 1;
      }
      if (end === pos) return null;
      const raw = line.slice(pos, end);
      const tokenInfo = classifyRedactionToken(raw);
      holes.set(seg.hole, { raw, holeClass: cls, tokenInfo });
      pos = end;
      continue;
    }

    // Known redaction tokens match any structured/typed hole class.
    const tok = matchKnownRedactionTokenPrefix(line, pos);
    if (tok) {
      holes.set(seg.hole, { raw: tok.raw, holeClass: cls, tokenInfo: tok.tokenInfo });
      pos = tok.nextPos;
      continue;
    }

    // Variable-width scalar classes (int, float, hex, ip) are bounded by the
    // leftmost occurrence of an immediately following literal segment (linear
    // time, no backtracking). Self-delimited / fixed-syntax classes (uuid,
    // time, quoted, json) lex directly without following-literal truncation.
    const isBoundedScalar = cls === "int" || cls === "float" || cls === "hex" || cls === "ip";
    let limit = line.length;
    if (isBoundedScalar && nextLit !== null) {
      const idx = line.indexOf(nextLit, pos);
      if (idx === -1) return null;
      limit = idx;
    }

    const rest = isBoundedScalar ? line.slice(pos, limit) : line.slice(pos);
    let lexed = null;

    switch (cls) {
      case "int": {
        const m = /^[+-]?[0-9]+/.exec(rest);
        if (!m) return null;
        lexed = { raw: m[0], nextPos: pos + m[0].length };
        break;
      }
      case "float": {
        const m = /^[+-]?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
        if (!m) return null;
        lexed = { raw: m[0], nextPos: pos + m[0].length };
        break;
      }
      case "uuid": {
        const m =
          /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/.exec(
            rest
          );
        if (!m) return null;
        lexed = { raw: m[0], nextPos: pos + m[0].length };
        break;
      }
      case "hex": {
        const m = /^[0-9a-fA-F]+/.exec(rest);
        if (!m) return null;
        lexed = { raw: m[0], nextPos: pos + m[0].length };
        break;
      }
      case "ip": {
        lexed = lexIpAt(line, pos, limit);
        if (!lexed) return null;
        break;
      }
      case "time": {
        lexed = lexTimeAt(line, pos);
        if (!lexed) return null;
        break;
      }
      case "quoted": {
        lexed = lexQuotedAt(line, pos);
        if (!lexed) return null;
        break;
      }
      case "json": {
        lexed = lexJsonAt(line, pos);
        if (!lexed) return null;
        break;
      }
      default:
        throw new Error(`Unsupported hole class: ${cls}`);
    }

    holes.set(seg.hole, {
      raw: lexed.raw,
      parsedJson: lexed.parsedJson,
      holeClass: cls,
      tokenInfo: null,
    });
    pos = lexed.nextPos;
  }

  if (pos !== line.length) {
    return null;
  }
  return holes;
}

function getObjectPath(obj, keyPath) {
  const parts = keyPath.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) {
      return { exists: false, value: undefined };
    }
    if (!Object.prototype.hasOwnProperty.call(cur, p)) {
      return { exists: false, value: undefined };
    }
    cur = cur[p];
  }
  return { exists: true, value: cur };
}

function parseIsoOrRfc3339(raw) {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/.exec(
      raw
    );
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (!isValidYmdHms(year, month, day, hour, minute, second)) return null;
  const fracStr = (m[7] ?? "").padEnd(3, "0").slice(0, 3);
  const ms = Number(fracStr);
  let offsetMs = 0;
  if (m[8] !== "Z") {
    const sign = m[8][0] === "+" ? 1 : -1;
    const clean = m[8].slice(1).replace(":", "");
    const oh = Number(clean.slice(0, 2));
    const om = Number(clean.slice(2, 4));
    if (oh > 23 || om > 59) return null;
    offsetMs = sign * (oh * 60 + om) * 60000;
  }
  return Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMs;
}

function parseApacheTime(raw) {
  const m =
    /^(\d{2})\/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(
      raw
    );
  if (!m) return null;
  const day = Number(m[1]);
  const month = MONTHS[m[2]] + 1;
  const year = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (!isValidYmdHms(year, month, day, hour, minute, second)) return null;
  const sign = m[7] === "+" ? 1 : -1;
  const oh = Number(m[8]);
  const om = Number(m[9]);
  if (oh > 23 || om > 59) return null;
  const offsetMs = sign * (oh * 60 + om) * 60000;
  return Date.UTC(year, month - 1, day, hour, minute, second, 0) - offsetMs;
}

function parseRfc2822Time(raw) {
  const m =
    /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), )?(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(
      raw
    );
  if (!m) return null;
  const day = Number(m[1]);
  const month = MONTHS[m[2]] + 1;
  const year = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (!isValidYmdHms(year, month, day, hour, minute, second)) return null;
  const sign = m[7] === "+" ? 1 : -1;
  const oh = Number(m[8]);
  const om = Number(m[9]);
  if (oh > 23 || om > 59) return null;
  const offsetMs = sign * (oh * 60 + om) * 60000;
  return Date.UTC(year, month - 1, day, hour, minute, second, 0) - offsetMs;
}

function parseSyslogTime(raw, referenceTsMs) {
  // RFC 5424 first
  const iso = parseIsoOrRfc3339(raw);
  if (iso !== null) return iso;
  // RFC 3164 (yearless -> UTC year of referenceTsMs)
  const m =
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|[12]\d|3[01]) (\d{2}):(\d{2}):(\d{2})$/.exec(
      raw
    );
  if (!m) return null;
  if (typeof referenceTsMs !== "number") return null;
  const year = new Date(referenceTsMs).getUTCFullYear();
  const month = MONTHS[m[1]] + 1;
  const day = Number(m[2].trim());
  const hour = Number(m[3]);
  const minute = Number(m[4]);
  const second = Number(m[5]);
  if (!isValidYmdHms(year, month, day, hour, minute, second)) return null;
  return Date.UTC(year, month - 1, day, hour, minute, second, 0);
}

function parseUnixDecimalToMs(val, shift) {
  const str = typeof val === "number" || typeof val === "bigint" ? String(val) : val;
  if (typeof str !== "string") return null;
  const m = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(str);
  if (!m) return null;
  const sign = m[1] === "-" ? -1n : 1n;
  const intPart = m[2];
  const fracPart = m[3] ?? "";
  const expRaw = m[4];
  let exp = 0;
  if (expRaw !== undefined) {
    if (expRaw.length > 8) {
      return expRaw.startsWith("-") ? 0 : null;
    }
    exp = Number(expRaw);
    if (!Number.isSafeInteger(exp)) return null;
  }
  const digits = (intPart + fracPart).replace(/^0+/, "");
  if (digits.length === 0) return 0;
  const totalShift = exp + shift - fracPart.length;
  const intLen = digits.length + totalShift;
  if (intLen <= 0) return 0;
  if (intLen > 19) return null;
  const scaled =
    totalShift >= 0 ? digits + "0".repeat(totalShift) : digits.slice(0, intLen);
  const bi = sign * BigInt(scaled);
  if (bi < INT64_MIN || bi > INT64_MAX) return null;
  const num = Number(bi);
  return Number.isSafeInteger(num) ? num : null;
}

function parseUnixIntDivToMs(val, divisor) {
  const str = typeof val === "number" || typeof val === "bigint" ? String(val) : val;
  if (typeof str !== "string" || !/^[+-]?\d+$/.test(str)) return null;
  const bi = BigInt(str);
  if (bi < INT64_MIN || bi > INT64_MAX) return null;
  const scaled = bi / divisor;
  if (scaled < INT64_MIN || scaled > INT64_MAX) return null;
  const num = Number(scaled);
  return Number.isSafeInteger(num) ? num : null;
}

function parseTimeValue(val, format, context) {
  const fmt = format ?? "auto";
  if (fmt === "unix_s") {
    return parseUnixDecimalToMs(val, 3);
  }
  if (fmt === "unix_ms") {
    return parseUnixIntDivToMs(val, 1n);
  }
  if (fmt === "unix_us") {
    return parseUnixIntDivToMs(val, 1000n);
  }
  if (fmt === "unix_ns") {
    return parseUnixIntDivToMs(val, 1000000n);
  }
  if (typeof val !== "string") return null;

  switch (fmt) {
    case "iso8601":
    case "rfc3339":
      return parseIsoOrRfc3339(val);
    case "apache":
      return parseApacheTime(val);
    case "rfc2822":
      return parseRfc2822Time(val);
    case "syslog":
      return parseSyslogTime(val, context?.reference_ts_ms);
    case "auto": {
      const a = parseIsoOrRfc3339(val);
      if (a !== null) return a;
      const b = parseApacheTime(val);
      if (b !== null) return b;
      return parseSyslogTime(val, context?.reference_ts_ms);
    }
    default:
      return null;
  }
}

function gcdBigInt(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function parseInt64String(raw) {
  if (!/^[+-]?[0-9]+$/.test(raw)) return { ok: false, code: "cast_failed" };
  const bi = BigInt(raw);
  if (bi < INT64_MIN || bi > INT64_MAX) {
    return { ok: false, code: "int_overflow" };
  }
  return { ok: true, value: bi };
}

function toNumericDouble(val) {
  if (typeof val === "bigint") {
    return Number(val);
  }
  if (typeof val === "number") {
    return val;
  }
  if (typeof val === "string" && /^[+-]?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(val)) {
    return Number(val);
  }
  return null;
}

function evaluateField(field, extracted, context) {
  if (extracted.missing) {
    return { status: "missing" };
  }

  // Pre-scrubbed redaction tokens short-circuit the transform pipeline:
  // a pseudonym token on a string field is preserved as-is, while mask tokens
  // and pseudonyms on non-string fields remain redacted markers.
  if (extracted.tokenInfo) {
    const { token, isPseudonym } = extracted.tokenInfo;
    if (isPseudonym && field.type === "string") {
      return { status: "ok", type: "string", value: token };
    }
    return { status: "redacted", token };
  }

  let cur = extracted.value;
  let curKind = extracted.kind; // "string" | "int" | "float" | "bool" | "timestamp" | "json"

  // Initial coercion from hole lexeme when hole has inherent numeric/json class
  if (extracted.holeClass === "int" && field.type !== "string" && !(field.transforms?.[0]?.op === "cast")) {
    const parsed = parseInt64String(cur);
    if (!parsed.ok) return { status: "parse_error", code: parsed.code };
    cur = parsed.value;
    curKind = "int";
  } else if (extracted.holeClass === "float" && field.type !== "string" && !(field.transforms?.[0]?.op === "cast")) {
    const n = Number(cur);
    if (!Number.isFinite(n)) return { status: "parse_error", code: "float_overflow" };
    cur = n;
    curKind = "float";
  } else if (extracted.holeClass === "json" && field.type === "json") {
    cur = extracted.parsedJson;
    curKind = "json";
  }

  for (const tr of field.transforms ?? []) {
    switch (tr.op) {
      case "drop":
        return { status: "dropped" };

      case "mask": {
        const mode = tr.mode ?? "token";
        if (mode === "token") {
          return { status: "redacted", token: `<${tr.kind ?? "redacted"}>` };
        }
        if (mode === "ip_prefix") {
          if (typeof cur !== "string") {
            return { status: "parse_error", code: "invalid_ip" };
          }
          const masked = maskIpPrefix(cur);
          if (masked === null) {
            return { status: "parse_error", code: "invalid_ip" };
          }
          cur = masked;
          curKind = "string";
        }
        break;
      }

      case "hash": {
        if (typeof cur !== "string") {
          cur = String(cur);
        }
        const alreadyToken = classifyRedactionToken(cur);
        if (alreadyToken && alreadyToken.isPseudonym) {
          curKind = "string";
          break;
        }
        const tagKind = tr.kind ?? (field.pii && field.pii !== "none" ? field.pii : "hash");
        const tag = computeHmacTag(cur, context.hmac_keys);
        cur = `<${tagKind}:${tag}>`;
        curKind = "string";
        break;
      }

      case "lower": {
        if (typeof cur !== "string") {
          return { status: "parse_error", code: "type_mismatch" };
        }
        cur = cur.toLowerCase();
        curKind = "string";
        break;
      }

      case "enum_map": {
        const key = typeof cur === "string" ? cur : String(cur);
        if (Object.prototype.hasOwnProperty.call(tr.map, key)) {
          cur = tr.map[key];
          curKind = "string";
        } else if (tr.default !== undefined) {
          cur = tr.default;
          curKind = "string";
        } else {
          return { status: "parse_error", code: "unmapped_enum" };
        }
        break;
      }

      case "cast": {
        switch (tr.to) {
          case "string":
            cur = typeof cur === "bigint" ? cur.toString(10) : String(cur);
            curKind = "string";
            break;
          case "int": {
            if (typeof cur === "boolean") {
              cur = cur ? 1n : 0n;
              curKind = "int";
            } else if (typeof cur === "bigint") {
              curKind = "int";
            } else if (typeof cur === "number") {
              if (!Number.isFinite(cur) || !Number.isInteger(cur)) {
                return { status: "parse_error", code: "cast_failed" };
              }
              const bi = BigInt(cur);
              if (bi < INT64_MIN || bi > INT64_MAX) {
                return { status: "parse_error", code: "int_overflow" };
              }
              cur = bi;
              curKind = "int";
            } else if (typeof cur === "string") {
              const parsed = parseInt64String(cur);
              if (!parsed.ok) return { status: "parse_error", code: parsed.code };
              cur = parsed.value;
              curKind = "int";
            } else {
              return { status: "parse_error", code: "cast_failed" };
            }
            break;
          }
          case "float": {
            if (typeof cur === "number") {
              if (!Number.isFinite(cur)) return { status: "parse_error", code: "float_overflow" };
              curKind = "float";
            } else if (typeof cur === "bigint") {
              cur = Number(cur);
              curKind = "float";
            } else if (typeof cur === "string") {
              if (!/^[+-]?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(cur)) {
                return { status: "parse_error", code: "cast_failed" };
              }
              const n = Number(cur);
              if (!Number.isFinite(n)) return { status: "parse_error", code: "float_overflow" };
              cur = n;
              curKind = "float";
            } else {
              return { status: "parse_error", code: "cast_failed" };
            }
            break;
          }
          case "bool": {
            if (typeof cur === "boolean") {
              curKind = "bool";
            } else if (typeof cur === "bigint") {
              if (cur === 1n) cur = true;
              else if (cur === 0n) cur = false;
              else return { status: "parse_error", code: "cast_failed" };
              curKind = "bool";
            } else if (typeof cur === "number") {
              if (cur === 1) cur = true;
              else if (cur === 0) cur = false;
              else return { status: "parse_error", code: "cast_failed" };
              curKind = "bool";
            } else if (typeof cur === "string") {
              const lc = cur.toLowerCase();
              if (lc === "true" || lc === "1") cur = true;
              else if (lc === "false" || lc === "0") cur = false;
              else return { status: "parse_error", code: "cast_failed" };
              curKind = "bool";
            } else {
              return { status: "parse_error", code: "cast_failed" };
            }
            break;
          }
          case "json": {
            if (typeof cur !== "string") {
              curKind = "json";
            } else {
              try {
                cur = JSON.parse(cur);
                curKind = "json";
              } catch {
                return { status: "parse_error", code: "invalid_json" };
              }
            }
            break;
          }
          default:
            throw new Error(`Unknown cast target: ${tr.to}`);
        }
        break;
      }

      case "scale": {
        const num = toNumericDouble(cur);
        if (num === null) {
          return { status: "parse_error", code: "type_mismatch" };
        }
        // Single IEEE 754 binary64 operation
        const out = tr.mul !== undefined ? num * tr.mul : num / tr.div;
        if (!Number.isFinite(out)) {
          return { status: "parse_error", code: "float_overflow" };
        }
        cur = out;
        curKind = "float";
        break;
      }

      case "unit": {
        const num = toNumericDouble(cur);
        if (num === null) {
          return { status: "parse_error", code: "type_mismatch" };
        }
        const table = tr.from in TIME_UNIT_NS ? TIME_UNIT_NS : BYTE_UNIT_B;
        const fromFactor = table[tr.from];
        const toFactor = table[tr.to];
        const g = gcdBigInt(fromFactor, toFactor);
        const mul = fromFactor / g;
        const div = toFactor / g;
        let out = num;
        if (mul !== 1n) out = out * Number(mul);
        if (div !== 1n) out = out / Number(div);
        if (!Number.isFinite(out)) {
          return { status: "parse_error", code: "float_overflow" };
        }
        cur = out;
        curKind = "float";
        break;
      }

      case "parse_time": {
        const tsMs = parseTimeValue(cur, tr.format, context);
        if (tsMs === null || !Number.isSafeInteger(tsMs)) {
          return { status: "parse_error", code: "invalid_time" };
        }
        cur = tsMs;
        curKind = "timestamp";
        break;
      }

      default:
        throw new Error(`Unknown transform op: ${tr.op}`);
    }
  }

  // Final field type conversion and canonical result encoding
  switch (field.type) {
    case "string":
    case "enum": {
      if (typeof cur !== "string") {
        return { status: "parse_error", code: "type_mismatch" };
      }
      return { status: "ok", type: field.type, value: cur };
    }
    case "int": {
      if (typeof cur === "bigint") {
        return { status: "ok", type: "int", value: cur.toString(10) };
      }
      if (typeof cur === "number") {
        if (!Number.isFinite(cur) || !Number.isInteger(cur)) {
          return { status: "parse_error", code: "type_mismatch" };
        }
        const bi = BigInt(cur);
        if (bi < INT64_MIN || bi > INT64_MAX) {
          return { status: "parse_error", code: "int_overflow" };
        }
        return { status: "ok", type: "int", value: bi.toString(10) };
      }
      if (typeof cur === "string" && extracted.fromHole) {
        const parsed = parseInt64String(cur);
        if (!parsed.ok) return { status: "parse_error", code: parsed.code };
        return { status: "ok", type: "int", value: parsed.value.toString(10) };
      }
      return { status: "parse_error", code: "type_mismatch" };
    }
    case "float": {
      if (typeof cur === "number") {
        if (!Number.isFinite(cur)) return { status: "parse_error", code: "float_overflow" };
        return { status: "ok", type: "float", value: float64ToHex(cur) };
      }
      if (typeof cur === "bigint") {
        const n = Number(cur);
        if (!Number.isFinite(n)) return { status: "parse_error", code: "float_overflow" };
        return { status: "ok", type: "float", value: float64ToHex(n) };
      }
      if (typeof cur === "string" && extracted.fromHole) {
        if (!/^[+-]?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(cur)) {
          return { status: "parse_error", code: "type_mismatch" };
        }
        const n = Number(cur);
        if (!Number.isFinite(n)) return { status: "parse_error", code: "float_overflow" };
        return { status: "ok", type: "float", value: float64ToHex(n) };
      }
      return { status: "parse_error", code: "type_mismatch" };
    }
    case "bool": {
      if (typeof cur !== "boolean") {
        return { status: "parse_error", code: "type_mismatch" };
      }
      return { status: "ok", type: "bool", value: cur };
    }
    case "timestamp": {
      if (curKind !== "timestamp" || typeof cur !== "number" || !Number.isSafeInteger(cur)) {
        return { status: "parse_error", code: "type_mismatch" };
      }
      return { status: "ok", type: "timestamp", value: cur };
    }
    case "json": {
      if (curKind !== "json") {
        return { status: "parse_error", code: "type_mismatch" };
      }
      return { status: "ok", type: "json", value: cur };
    }
    default:
      throw new Error(`Unknown field type: ${field.type}`);
  }
}

function extractRawFromValue(val) {
  if (val === null || val === undefined) {
    return { missing: true };
  }
  if (typeof val === "string") {
    const tokenInfo = classifyRedactionToken(val);
    return { missing: false, value: val, kind: "string", tokenInfo, fromHole: false };
  }
  if (typeof val === "boolean") {
    return { missing: false, value: val, kind: "bool", tokenInfo: null, fromHole: false };
  }
  if (typeof val === "number") {
    return {
      missing: false,
      value: val,
      kind: Number.isInteger(val) ? "int" : "float",
      tokenInfo: null,
      fromHole: false,
    };
  }
  return { missing: false, value: val, kind: "json", tokenInfo: null, fromHole: false };
}

export function evaluateVector(spec, input, context) {
  if (spec.match.kind !== input.kind) {
    return { matched: false };
  }

  let holes = null;
  if (spec.match.kind === "text") {
    holes = matchTextSegments(spec.match.segments, input.line);
    if (!holes) return { matched: false };
  } else if (spec.match.kind === "object") {
    if (input.object === null || typeof input.object !== "object" || Array.isArray(input.object)) {
      return { matched: false };
    }
    for (const reqPath of spec.match.shape) {
      if (!getObjectPath(input.object, reqPath).exists) {
        return { matched: false };
      }
    }
    if (spec.match.message) {
      const msgRes = getObjectPath(input.object, spec.match.message.path);
      if (!msgRes.exists || typeof msgRes.value !== "string") {
        return { matched: false };
      }
      holes = matchTextSegments(spec.match.message.segments, msgRes.value);
      if (!holes) return { matched: false };
    }
  } else if (spec.match.kind === "args") {
    if (
      !Array.isArray(input.strings) ||
      !Array.isArray(input.args) ||
      input.strings.length !== spec.match.strings.length ||
      input.args.length !== spec.match.strings.length - 1
    ) {
      return { matched: false };
    }
    for (let i = 0; i < spec.match.strings.length; i += 1) {
      if (input.strings[i] !== spec.match.strings[i]) {
        return { matched: false };
      }
    }
  }

  const fields = {};
  for (const field of spec.fields) {
    let extracted;
    if ("hole" in field.from) {
      const h = holes ? holes.get(field.from.hole) : undefined;
      if (!h) {
        extracted = { missing: true };
      } else {
        extracted = {
          missing: false,
          value: h.raw,
          parsedJson: h.parsedJson,
          holeClass: h.holeClass,
          kind: h.holeClass === "json" ? "json" : "string",
          tokenInfo: h.tokenInfo,
          fromHole: true,
        };
      }
    } else if ("path" in field.from) {
      const found = getObjectPath(input.object, field.from.path);
      extracted = found.exists ? extractRawFromValue(found.value) : { missing: true };
    } else if ("arg" in field.from) {
      extracted = extractRawFromValue(input.args[field.from.arg]);
    }
    fields[field.name] = evaluateField(field, extracted, context);
  }

  return { matched: true, fields };
}

function fieldResultToSpecTestValue(res) {
  if (res.status === "redacted" || res.status === "dropped" || res.status === "missing") {
    return null;
  }
  if (res.status === "parse_error") {
    return Symbol("parse_error");
  }
  switch (res.type) {
    case "int": {
      const bi = BigInt(res.value);
      if (bi >= BigInt(Number.MIN_SAFE_INTEGER) && bi <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(bi);
      }
      return res.value;
    }
    case "float":
      return hexToFloat64(res.value);
    default:
      return res.value;
  }
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i += 1) {
      if (ka[i] !== kb[i]) return false;
      if (!deepEqual(a[ka[i]], b[kb[i]])) return false;
    }
    return true;
  }
  return false;
}

export function validateVectorSuiteDocument(suiteDoc, validator) {
  const errors = [];
  const schemaRes = validator.validateSuite(suiteDoc);
  if (!schemaRes.valid) {
    for (const msg of schemaRes.formattedErrors) {
      errors.push(`schema: ${msg}`);
    }
    return errors;
  }

  const seenIds = new Set();
  for (const vec of suiteDoc.vectors) {
    if (seenIds.has(vec.id)) {
      errors.push(`${vec.id}: duplicate vector id within suite`);
    }
    seenIds.add(vec.id);

    // 1. Spec cross-reference & lexer grammar invariants
    const invErrors = checkSpecInvariants(vec.spec);
    for (const invErr of invErrors) {
      errors.push(`${vec.id}: spec invariant: ${invErr}`);
    }

    // 2. Input kind must match spec.match.kind
    if (vec.input.kind !== vec.spec.match.kind) {
      errors.push(
        `${vec.id}: input.kind (${vec.input.kind}) does not match spec.match.kind (${vec.spec.match.kind})`
      );
    }

    // 3. Exact SQL refusal invariant
    const hasJsonHole = specHasJsonHole(vec.spec);
    if (hasJsonHole) {
      if (vec.sql.supported !== false || vec.sql.refusal_code !== "unsupported_json_hole") {
        errors.push(`${vec.id}: spec has a json hole so sql.supported must be false with refusal_code "unsupported_json_hole"`);
      }
      if (!vec.tags.includes("sql:refuse") || !vec.tags.includes("sql:refuse:json_hole")) {
        errors.push(`${vec.id}: SQL-refused vector must include tags "sql:refuse" and "sql:refuse:json_hole"`);
      }
    } else {
      if (vec.sql.supported !== true) {
        errors.push(`${vec.id}: spec has no json hole so sql.supported must be true`);
      }
      if (vec.tags.includes("sql:refuse") || vec.tags.includes("sql:refuse:json_hole")) {
        errors.push(`${vec.id}: SQL-supported vector must not carry sql:refuse tags`);
      }
    }

    // 4. Expected field set & canonical value bounds
    if (vec.expected.matched) {
      const expectedKeys = Object.keys(vec.expected.fields).sort();
      const declaredKeys = vec.spec.fields.map((f) => f.name).sort();
      if (!deepEqual(expectedKeys, declaredKeys)) {
        errors.push(
          `${vec.id}: expected.fields keys [${expectedKeys.join(", ")}] do not match spec.fields [${declaredKeys.join(", ")}]`
        );
      }
      const fieldByName = new Map(vec.spec.fields.map((f) => [f.name, f]));
      for (const [fname, fval] of Object.entries(vec.expected.fields)) {
        const decl = fieldByName.get(fname);
        if (fval.status === "ok" && decl) {
          if (fval.type !== decl.type) {
            errors.push(`${vec.id}: field "${fname}" expected type "${fval.type}" != declared "${decl.type}"`);
          }
          if (fval.type === "int") {
            const bi = BigInt(fval.value);
            if (bi < INT64_MIN || bi > INT64_MAX) {
              errors.push(`${vec.id}: field "${fname}" int value ${fval.value} out of int64 bounds`);
            }
          }
          if (fval.type === "float") {
            const num = hexToFloat64(fval.value);
            if (!Number.isFinite(num)) {
              errors.push(`${vec.id}: field "${fname}" float hex ${fval.value} decodes to non-finite value`);
            }
          }
        }
      }
    }

    if (invErrors.length > 0) {
      continue;
    }

    // 5. Independent reference evaluation against vec.input
    const ctx = {
      ...(suiteDoc.context ?? {}),
      ...(vec.context ?? {}),
    };
    const actual = evaluateVector(vec.spec, vec.input, ctx);
    if (!deepEqual(actual, vec.expected)) {
      errors.push(
        `${vec.id}: reference evaluator mismatch:\n  expected: ${JSON.stringify(vec.expected)}\n  actual:   ${JSON.stringify(actual)}`
      );
    }

    // 6. Verify every embedded spec.tests[] positive case also passes
    for (let ti = 0; ti < vec.spec.tests.length; ti += 1) {
      const tc = vec.spec.tests[ti];
      const testInput =
        vec.spec.match.kind === "text"
          ? { kind: "text", line: tc.line }
          : vec.spec.match.kind === "object"
            ? { kind: "object", object: tc.object }
            : { kind: "args", strings: vec.spec.match.strings, args: tc.args };
      const testActual = evaluateVector(vec.spec, testInput, ctx);
      if (!testActual.matched) {
        errors.push(`${vec.id}: spec.tests[${ti}] failed to match`);
        continue;
      }
      const simplified = {};
      for (const [k, v] of Object.entries(testActual.fields)) {
        simplified[k] = fieldResultToSpecTestValue(v);
      }
      if (!deepEqual(simplified, tc.expect)) {
        errors.push(
          `${vec.id}: spec.tests[${ti}] expectation mismatch:\n  expected: ${JSON.stringify(tc.expect)}\n  actual:   ${JSON.stringify(simplified)}`
        );
      }
    }
  }

  return errors;
}

function isPlainObject(val) {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

function validateManifestShape(manifest) {
  const errors = [];
  if (!isPlainObject(manifest)) {
    return ["Manifest root must be a JSON object"];
  }
  const expectedRootKeys = [
    "schema_version",
    "description",
    "default_context",
    "total_vectors",
    "sql_supported_count",
    "sql_refused_count",
    "suites",
  ].sort();
  const actualRootKeys = Object.keys(manifest).sort();
  if (!deepEqual(actualRootKeys, expectedRootKeys)) {
    errors.push(
      `Manifest keys [${actualRootKeys.join(", ")}] do not match expected [${expectedRootKeys.join(", ")}]`
    );
  }
  if (manifest.schema_version !== 1) {
    errors.push(`Manifest schema_version must be 1, got ${JSON.stringify(manifest.schema_version)}`);
  }
  if (typeof manifest.description !== "string" || manifest.description.length === 0) {
    errors.push("Manifest description must be a non-empty string");
  }
  for (const key of ["total_vectors", "sql_supported_count", "sql_refused_count"]) {
    if (!Number.isInteger(manifest[key]) || manifest[key] < 0) {
      errors.push(`Manifest ${key} must be a non-negative integer`);
    }
  }

  const ctx = manifest.default_context;
  if (!isPlainObject(ctx)) {
    errors.push("Manifest default_context must be an object");
  } else {
    const ctxKeys = Object.keys(ctx).sort();
    if (!deepEqual(ctxKeys, ["hmac_keys", "reference_ts_ms"])) {
      errors.push(
        `Manifest default_context keys [${ctxKeys.join(", ")}] must be [hmac_keys, reference_ts_ms]`
      );
    }
    if (!isPlainObject(ctx.hmac_keys)) {
      errors.push("Manifest default_context.hmac_keys must be an object");
    } else {
      const keyNames = Object.keys(ctx.hmac_keys).sort();
      if (!deepEqual(keyNames, ["edge", "server"])) {
        errors.push(
          `Manifest default_context.hmac_keys keys [${keyNames.join(", ")}] must be [edge, server]`
        );
      }
      if (typeof ctx.hmac_keys.edge !== "string" || ctx.hmac_keys.edge.length === 0) {
        errors.push("Manifest default_context.hmac_keys.edge must be a non-empty string");
      }
      if (typeof ctx.hmac_keys.server !== "string" || ctx.hmac_keys.server.length === 0) {
        errors.push("Manifest default_context.hmac_keys.server must be a non-empty string");
      }
    }
    if (!Number.isSafeInteger(ctx.reference_ts_ms)) {
      errors.push("Manifest default_context.reference_ts_ms must be a safe integer");
    }
  }

  if (!Array.isArray(manifest.suites) || manifest.suites.length === 0) {
    errors.push("Manifest suites must be a non-empty array");
  } else {
    const expectedEntryKeys = [
      "suite",
      "file",
      "description",
      "count",
      "sql_supported_count",
      "sql_refused_count",
      "sha256",
    ].sort();
    for (let i = 0; i < manifest.suites.length; i += 1) {
      const entry = manifest.suites[i];
      if (!isPlainObject(entry)) {
        errors.push(`Manifest suites[${i}] must be an object`);
        continue;
      }
      const actualEntryKeys = Object.keys(entry).sort();
      if (!deepEqual(actualEntryKeys, expectedEntryKeys)) {
        errors.push(
          `Manifest suites[${i}] keys [${actualEntryKeys.join(", ")}] do not match expected [${expectedEntryKeys.join(", ")}]`
        );
      }
      if (typeof entry.suite !== "string" || !/^[0-9]{2}-[a-z0-9-]+$/.test(entry.suite)) {
        errors.push(`Manifest suites[${i}].suite is invalid: ${JSON.stringify(entry.suite)}`);
      }
      if (entry.file !== `suites/${entry.suite}.json`) {
        errors.push(
          `Manifest suites[${i}].file (${JSON.stringify(entry.file)}) must equal "suites/${entry.suite}.json"`
        );
      }
      if (typeof entry.description !== "string" || entry.description.length === 0) {
        errors.push(`Manifest suites[${i}].description must be a non-empty string`);
      }
      for (const k of ["count", "sql_supported_count", "sql_refused_count"]) {
        if (!Number.isInteger(entry[k]) || entry[k] < 0) {
          errors.push(`Manifest suites[${i}].${k} must be a non-negative integer`);
        }
      }
      if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
        errors.push(`Manifest suites[${i}].sha256 must be a 64-char lowercase hex digest`);
      }
    }
  }

  return errors;
}

export function validateAllVectors(options = {}) {
  const vectorsDir = options.vectorsDir ?? VECTORS_DIR;
  const suitesDir = options.suitesDir ?? path.join(vectorsDir, "suites");
  const manifestPath = options.manifestPath ?? path.join(vectorsDir, "manifest.json");
  const validator = createVectorValidator();
  const errors = [];

  if (!fs.existsSync(manifestPath)) {
    return { valid: false, errors: [`Missing manifest at ${manifestPath}`], stats: null };
  }
  const manifest = readJson(manifestPath);
  const manifestShapeErrors = validateManifestShape(manifest);
  errors.push(...manifestShapeErrors);
  if (!Array.isArray(manifest?.suites)) {
    return { valid: false, errors, stats: null, manifest };
  }

  const globalIds = new Set();
  const seenSuites = new Set();
  const listedSuiteFiles = new Set();

  const stats = {
    totalVectors: 0,
    sqlSupported: 0,
    sqlRefused: 0,
    matchedTrue: 0,
    matchedFalse: 0,
    matchKinds: new Set(),
    holeClasses: new Set(),
    transforms: new Set(),
    fieldTypes: new Set(),
    fieldStatuses: new Set(),
    timeUnits: new Set(),
    byteUnits: new Set(),
    parseTimeFormats: new Set(),
    castTargets: new Set(),
    tags: new Set(),
    maxRecordBytes: 0,
    suiteCounts: {},
  };

  for (const entry of manifest.suites) {
    if (!isPlainObject(entry) || typeof entry.file !== "string") {
      continue;
    }
    if (seenSuites.has(entry.suite)) {
      errors.push(`Duplicate manifest suite entry: ${entry.suite}`);
    }
    seenSuites.add(entry.suite);
    if (listedSuiteFiles.has(entry.file)) {
      errors.push(`Duplicate manifest suite file entry: ${entry.file}`);
    }
    listedSuiteFiles.add(entry.file);

    const suitePath = path.join(vectorsDir, entry.file);
    if (!fs.existsSync(suitePath)) {
      errors.push(`Manifest suite file missing: ${entry.file}`);
      continue;
    }
    const actualSha = sha256File(suitePath);
    if (actualSha !== entry.sha256) {
      errors.push(`Manifest SHA-256 mismatch for ${entry.file}: manifest=${entry.sha256}, actual=${actualSha}`);
    }

    const suiteDoc = readJson(suitePath);
    if (suiteDoc.suite !== entry.suite) {
      errors.push(`Suite name mismatch for ${entry.file}: manifest=${entry.suite}, file=${suiteDoc.suite}`);
    }
    if (suiteDoc.description !== entry.description) {
      errors.push(`Suite description mismatch for ${entry.file}: manifest description differs from suite file`);
    }
    if (!deepEqual(suiteDoc.context, manifest.default_context)) {
      errors.push(
        `Manifest default_context mismatch for ${entry.file}: manifest=${JSON.stringify(manifest.default_context)}, suite=${JSON.stringify(suiteDoc.context)}`
      );
    }
    if (!Array.isArray(suiteDoc.vectors)) {
      errors.push(`Suite ${entry.file} vectors must be an array`);
      continue;
    }
    if (suiteDoc.vectors.length !== entry.count) {
      errors.push(`Vector count mismatch for ${entry.file}: manifest=${entry.count}, file=${suiteDoc.vectors.length}`);
    }

    const suiteErrors = validateVectorSuiteDocument(suiteDoc, validator);
    errors.push(...suiteErrors);

    stats.suiteCounts[entry.suite] = suiteDoc.vectors.length;

    let suiteSqlSupported = 0;
    let suiteSqlRefused = 0;

    for (const vec of suiteDoc.vectors) {
      if (globalIds.has(vec.id)) {
        errors.push(`Duplicate global vector id "${vec.id}" across suites`);
      }
      globalIds.add(vec.id);

      stats.totalVectors += 1;
      if (vec.sql.supported) {
        stats.sqlSupported += 1;
        suiteSqlSupported += 1;
      } else {
        stats.sqlRefused += 1;
        suiteSqlRefused += 1;
      }
      if (vec.expected.matched) stats.matchedTrue += 1;
      else stats.matchedFalse += 1;

      stats.matchKinds.add(vec.spec.match.kind);
      for (const t of vec.tags) stats.tags.add(t);

      const segs =
        vec.spec.match.kind === "text"
          ? vec.spec.match.segments
          : vec.spec.match.kind === "object" && vec.spec.match.message
            ? vec.spec.match.message.segments
            : [];
      for (const s of segs) {
        if ("hole" in s) stats.holeClasses.add(s.class ?? "word");
      }

      for (const f of vec.spec.fields) {
        stats.fieldTypes.add(f.type);
        for (const tr of f.transforms ?? []) {
          stats.transforms.add(tr.op);
          if (tr.op === "unit") {
            if (tr.from in TIME_UNIT_NS) {
              stats.timeUnits.add(tr.from);
              stats.timeUnits.add(tr.to);
            } else {
              stats.byteUnits.add(tr.from);
              stats.byteUnits.add(tr.to);
            }
          }
          if (tr.op === "parse_time") {
            stats.parseTimeFormats.add(tr.format ?? "auto");
          }
          if (tr.op === "cast") {
            stats.castTargets.add(tr.to);
          }
        }
      }

      if (vec.expected.matched) {
        for (const res of Object.values(vec.expected.fields)) {
          stats.fieldStatuses.add(res.status);
        }
      }

      if (vec.input.kind === "text") {
        const byteLen = Buffer.byteLength(vec.input.line, "utf8");
        if (byteLen > stats.maxRecordBytes) stats.maxRecordBytes = byteLen;
      }
    }

    if (entry.sql_supported_count !== suiteSqlSupported) {
      errors.push(
        `Suite sql_supported_count mismatch for ${entry.file}: manifest=${entry.sql_supported_count}, actual=${suiteSqlSupported}`
      );
    }
    if (entry.sql_refused_count !== suiteSqlRefused) {
      errors.push(
        `Suite sql_refused_count mismatch for ${entry.file}: manifest=${entry.sql_refused_count}, actual=${suiteSqlRefused}`
      );
    }
  }

  // Detect any extra/unlisted files in the suites directory
  if (fs.existsSync(suitesDir)) {
    const diskEntries = fs.readdirSync(suitesDir).sort();
    for (const name of diskEntries) {
      const rel = `suites/${name}`;
      if (!listedSuiteFiles.has(rel)) {
        errors.push(`Unexpected extra file in suites directory not listed in manifest: ${rel}`);
      }
    }
  }

  // Verify manifest totals
  if (manifest.total_vectors !== stats.totalVectors) {
    errors.push(
      `Manifest total_vectors (${manifest.total_vectors}) != actual (${stats.totalVectors})`
    );
  }
  if (manifest.sql_supported_count !== stats.sqlSupported) {
    errors.push(
      `Manifest sql_supported_count (${manifest.sql_supported_count}) != actual (${stats.sqlSupported})`
    );
  }
  if (manifest.sql_refused_count !== stats.sqlRefused) {
    errors.push(
      `Manifest sql_refused_count (${manifest.sql_refused_count}) != actual (${stats.sqlRefused})`
    );
  }

  return { valid: errors.length === 0, errors, stats, manifest };
}

function runCli() {
  const res = validateAllVectors();
  if (!res.valid) {
    console.error(`Vector validation FAILED with ${res.errors.length} error(s):`);
    for (const err of res.errors.slice(0, 40)) {
      console.error(`  - ${err}`);
    }
    if (res.errors.length > 40) {
      console.error(`  ... and ${res.errors.length - 40} more`);
    }
    process.exit(1);
  }

  const s = res.stats;
  console.log(`PASS: ${s.totalVectors} golden vectors validated across ${Object.keys(s.suiteCounts).length} suites`);
  console.log(`  SQL supported: ${s.sqlSupported} | SQL refused (json hole): ${s.sqlRefused}`);
  console.log(`  Matched: ${s.matchedTrue} | Non-matched: ${s.matchedFalse}`);
  console.log(`  Match kinds (${s.matchKinds.size}/3): ${[...s.matchKinds].sort().join(", ")}`);
  console.log(`  Hole classes (${s.holeClasses.size}/11): ${[...s.holeClasses].sort().join(", ")}`);
  console.log(`  Transforms (${s.transforms.size}/9): ${[...s.transforms].sort().join(", ")}`);
  console.log(`  Field types (${s.fieldTypes.size}/7): ${[...s.fieldTypes].sort().join(", ")}`);
  console.log(`  Field statuses (${s.fieldStatuses.size}/5): ${[...s.fieldStatuses].sort().join(", ")}`);
  console.log(`  Max text record bytes: ${s.maxRecordBytes}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
