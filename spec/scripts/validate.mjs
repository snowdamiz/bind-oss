#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SPEC_ROOT = path.resolve(__dirname, "..");
export const SCHEMAS_DIR = path.join(SPEC_ROOT, "schemas");

export const SCHEMA_IDS = {
  common: "https://schemas.bind.dev/v1/common.schema.json",
  parserSpec: "https://schemas.bind.dev/v1/parser-spec.schema.json",
  eventType: "https://schemas.bind.dev/v1/event-type.schema.json",
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function loadDocument(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") {
    return JSON.parse(raw);
  }
  if (ext === ".yaml" || ext === ".yml") {
    return YAML.parse(raw);
  }
  throw new Error(`Unsupported file extension "${ext}" for ${filePath}`);
}

export function createValidator() {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);

  const commonSchema = readJson(path.join(SCHEMAS_DIR, "common.schema.json"));
  const parserSpecSchema = readJson(path.join(SCHEMAS_DIR, "parser-spec.schema.json"));
  const eventTypeSchema = readJson(path.join(SCHEMAS_DIR, "event-type.schema.json"));

  ajv.addSchema(commonSchema);
  const validateParserSpecFn = ajv.compile(parserSpecSchema);
  const validateEventTypeFn = ajv.compile(eventTypeSchema);

  return {
    ajv,
    schemas: {
      common: commonSchema,
      parserSpec: parserSpecSchema,
      eventType: eventTypeSchema,
    },
    validateParserSpec(doc) {
      const valid = validateParserSpecFn(doc);
      const errors = valid ? [] : (validateParserSpecFn.errors ?? []);
      return {
        valid,
        errors,
        formattedErrors: formatAjvErrors(errors, doc),
      };
    },
    validateEventType(doc) {
      const valid = validateEventTypeFn(doc);
      const errors = valid ? [] : (validateEventTypeFn.errors ?? []);
      return {
        valid,
        errors,
        formattedErrors: formatAjvErrors(errors, doc),
      };
    },
  };
}

function getValueAtPointer(doc, pointer) {
  if (!pointer) return doc;
  const parts = pointer
    .split("/")
    .slice(1)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current = doc;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function isTransformPath(instancePath) {
  return /\/transforms\/\d+$/.test(instancePath);
}

function isScaleOneOf(err, val) {
  return (
    err.keyword === "oneOf" &&
    isTransformPath(err.instancePath) &&
    val &&
    typeof val === "object" &&
    val.op === "scale"
  );
}

function isUnitOneOf(err, val) {
  return (
    err.keyword === "oneOf" &&
    isTransformPath(err.instancePath) &&
    val &&
    typeof val === "object" &&
    val.op === "unit"
  );
}

function isSemanticOneOf(err) {
  return (
    err.keyword === "oneOf" &&
    (err.schemaPath.includes("/FieldSemantic/oneOf") ||
      err.instancePath.endsWith("/semantic"))
  );
}

function isSlotTypeCompatAnyOf(err) {
  return (
    err.keyword === "anyOf" &&
    err.instancePath.endsWith("/slot") &&
    err.schemaPath.includes("/then/properties/slot/anyOf")
  );
}

function formatSingleError(err, doc) {
  const loc = err.instancePath || "<root>";
  const val = getValueAtPointer(doc, err.instancePath);

  switch (err.keyword) {
    case "enum": {
      const allowed = err.params.allowedValues.join(", ");
      return `${loc}: invalid value ${JSON.stringify(val)}; expected one of [${allowed}]`;
    }
    case "const": {
      return `${loc}: invalid value ${JSON.stringify(val)}; expected ${JSON.stringify(err.params.allowedValue)}`;
    }
    case "required": {
      return `${loc}: missing required property "${err.params.missingProperty}"`;
    }
    case "additionalProperties": {
      return `${loc}: unexpected property "${err.params.additionalProperty}" is not allowed`;
    }
    case "type": {
      return `${loc}: expected type ${err.params.type}, got ${JSON.stringify(val)}`;
    }
    case "pattern": {
      return `${loc}: value ${JSON.stringify(val)} does not match pattern ${err.params.pattern}`;
    }
    case "not": {
      if (err.instancePath.endsWith("/div") && err.schemaPath.includes("/properties/div/not")) {
        return `${loc}: scale divisor must not be 0`;
      }
      if (err.instancePath.endsWith("/mul") && err.schemaPath.includes("/properties/mul/not")) {
        return `${loc}: scale multiplier must not be 0`;
      }
      return `${loc}: disallowed value ${JSON.stringify(val)}`;
    }
    case "minItems": {
      return `${loc}: must contain at least ${err.params.limit} item(s)`;
    }
    case "uniqueItems": {
      return `${loc}: must not contain duplicate items (duplicates at indices ${err.params.j} and ${err.params.i})`;
    }
    case "minimum":
    case "maximum": {
      return `${loc}: value ${JSON.stringify(val)} ${err.message}`;
    }
    case "oneOf": {
      if (isScaleOneOf(err, val)) {
        return `${loc}: scale transform must specify exactly one of "mul" or "div" (not both, not neither)`;
      }
      if (isUnitOneOf(err, val)) {
        return `${loc}: unit transform "from" (${JSON.stringify(val.from)}) and "to" (${JSON.stringify(val.to)}) must belong to the same dimension (both time units or both byte units)`;
      }
      if (isSemanticOneOf(err)) {
        return `${loc}: invalid semantic ${JSON.stringify(val)}; expected a closed catalog semantic or "id.<entity>"`;
      }
      if (/\/segments\/\d+$/.test(err.instancePath)) {
        return `${loc}: text segment must specify exactly one of "lit" or "hole"`;
      }
      return `${loc}: value does not match exactly one allowed variant (${err.message})`;
    }
    case "anyOf": {
      if (isSlotTypeCompatAnyOf(err)) {
        const parentPath = err.instancePath.replace(/\/slot$/, "");
        const field = getValueAtPointer(doc, parentPath);
        const typeDesc = field && typeof field === "object" ? ` (${JSON.stringify(field.type)})` : "";
        return `${loc}: slot ${JSON.stringify(val)} is incompatible with the field's declared type${typeDesc}`;
      }
      return `${loc}: value ${JSON.stringify(val)} does not match any allowed schema`;
    }
    default:
      return `${loc}: ${err.message}`;
  }
}

export function formatAjvErrors(errors, doc) {
  if (!errors || errors.length === 0) return [];

  // Filter out pure `if` wrapper errors when more specific `then` errors exist.
  const withoutIfWrappers = errors.filter((e) => e.keyword !== "if");
  const candidate = withoutIfWrappers.length > 0 ? withoutIfWrappers : errors;

  const semanticPaths = new Set();
  const unitPaths = new Set();
  const scalePaths = new Set();
  const slotCompatPaths = new Set();
  const invalidStorageSlotPaths = new Set();

  for (const e of candidate) {
    const val = getValueAtPointer(doc, e.instancePath);
    if (isSemanticOneOf(e)) semanticPaths.add(e.instancePath);
    if (isUnitOneOf(e, val)) unitPaths.add(e.instancePath);
    if (isScaleOneOf(e, val)) scalePaths.add(e.instancePath);
    if (isSlotTypeCompatAnyOf(e)) slotCompatPaths.add(e.instancePath);
    if (e.schemaPath.includes("StorageSlot")) invalidStorageSlotPaths.add(e.instancePath);
  }

  const filtered = candidate.filter((e) => {
    // Suppress noisy sub-branch enum/pattern errors under FieldSemantic oneOf
    if (semanticPaths.has(e.instancePath) && e.keyword !== "oneOf") {
      return false;
    }
    // Suppress noisy TimeUnit/ByteUnit sub-branch errors under UnitTransform oneOf
    for (const uPath of unitPaths) {
      if (
        (e.instancePath === `${uPath}/from` || e.instancePath === `${uPath}/to`) &&
        (e.schemaPath.includes("TimeUnit") || e.schemaPath.includes("ByteUnit"))
      ) {
        return false;
      }
    }
    // Suppress noisy required sub-branch errors under ScaleTransform oneOf; keep type/not errors
    for (const sPath of scalePaths) {
      if (e.instancePath === sPath && e.keyword === "required") {
        return false;
      }
    }
    // If ScaleTransform already has a concrete `mul` or `div` type/not error, suppress redundant oneOf
    if (
      scalePaths.has(e.instancePath) &&
      e.keyword === "oneOf" &&
      candidate.some(
        (other) =>
          other.instancePath.startsWith(`${e.instancePath}/`) &&
          (other.keyword === "type" || other.keyword === "not")
      )
    ) {
      return false;
    }
    // If the slot value is not even in StorageSlot, suppress secondary type-compatibility errors
    if (
      invalidStorageSlotPaths.has(e.instancePath) &&
      !e.schemaPath.includes("StorageSlot")
    ) {
      return false;
    }
    // Suppress noisy Slot/OverflowSlot sub-branch errors under EventTypeField type-slot compatibility anyOf
    if (
      slotCompatPaths.has(e.instancePath) &&
      e.keyword !== "anyOf" &&
      !e.schemaPath.includes("StorageSlot")
    ) {
      return false;
    }
    return true;
  });

  const messages = [];
  const seen = new Set();
  for (const err of filtered) {
    const msg = formatSingleError(err, doc);
    if (!seen.has(msg)) {
      seen.add(msg);
      messages.push(msg);
    }
  }
  return messages;
}

function runCli(argv) {
  const args = argv.slice(2);
  let schemaKind = null;
  const files = [];

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--schema" && i + 1 < args.length) {
      schemaKind = args[i + 1];
      i += 1;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(
        "Usage: node scripts/validate.mjs --schema <parser-spec|event-type> <file...>"
      );
      process.exit(0);
    } else {
      files.push(args[i]);
    }
  }

  if (!schemaKind || !["parser-spec", "event-type"].includes(schemaKind) || files.length === 0) {
    console.error(
      "Usage: node scripts/validate.mjs --schema <parser-spec|event-type> <file...>"
    );
    process.exit(2);
  }

  const validator = createValidator();
  let failed = 0;

  for (const file of files) {
    const doc = loadDocument(file);
    const result =
      schemaKind === "parser-spec"
        ? validator.validateParserSpec(doc)
        : validator.validateEventType(doc);

    if (result.valid) {
      console.log(`PASS ${file}`);
    } else {
      failed += 1;
      console.error(`FAIL ${file}`);
      for (const msg of result.formattedErrors) {
        console.error(`  - ${msg}`);
      }
    }
  }

  if (failed > 0) {
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv);
}
