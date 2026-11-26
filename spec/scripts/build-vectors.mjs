#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONTEXT } from "./lib/vector-builders.mjs";
import { buildSuite01 } from "./suites/01-holes-word-int-float.mjs";
import { buildSuite02 } from "./suites/02-holes-uuid-hex-ip-time.mjs";
import { buildSuite03 } from "./suites/03-holes-quoted-json-until-rest.mjs";
import { buildSuite04 } from "./suites/04-transforms-core.mjs";
import { buildSuite05 } from "./suites/05-transforms-privacy-and-redaction.mjs";
import { buildSuite06 } from "./suites/06-matchers-object-and-args.mjs";
import { buildSuite07 } from "./suites/07-boundaries-unicode-adjacent-large.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VECTORS_DIR = path.resolve(__dirname, "..", "vectors");
const SUITES_DIR = path.join(VECTORS_DIR, "suites");
const MANIFEST_PATH = path.join(VECTORS_DIR, "manifest.json");

function sha256Text(text) {
  return crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

export function buildAllArtifacts() {
  const builders = [
    buildSuite01,
    buildSuite02,
    buildSuite03,
    buildSuite04,
    buildSuite05,
    buildSuite06,
    buildSuite07,
  ];

  const suiteFiles = [];
  const manifestSuites = [];
  let totalVectors = 0;
  let sqlSupportedCount = 0;
  let sqlRefusedCount = 0;

  for (const build of builders) {
    const raw = build();
    const doc = {
      schema_version: 1,
      suite: raw.suite,
      description: raw.description,
      context: DEFAULT_CONTEXT,
      vectors: raw.vectors,
    };
    const jsonText = `${JSON.stringify(doc, null, 2)}\n`;
    const relFile = `suites/${raw.suite}.json`;
    const absPath = path.join(VECTORS_DIR, relFile);

    let supportedInSuite = 0;
    let refusedInSuite = 0;
    for (const v of raw.vectors) {
      if (v.sql.supported) supportedInSuite += 1;
      else refusedInSuite += 1;
    }

    totalVectors += raw.vectors.length;
    sqlSupportedCount += supportedInSuite;
    sqlRefusedCount += refusedInSuite;

    suiteFiles.push({ absPath, relFile, jsonText });
    manifestSuites.push({
      suite: raw.suite,
      file: relFile,
      description: raw.description,
      count: raw.vectors.length,
      sql_supported_count: supportedInSuite,
      sql_refused_count: refusedInSuite,
      sha256: sha256Text(jsonText),
    });
  }

  const manifestDoc = {
    schema_version: 1,
    description:
      "Deterministic golden conformance vector manifest for Bind ParserSpec runtimes (Mesh, TypeScript, ClickHouse SQL, Swift) per §5, §14, and §17.",
    default_context: DEFAULT_CONTEXT,
    total_vectors: totalVectors,
    sql_supported_count: sqlSupportedCount,
    sql_refused_count: sqlRefusedCount,
    suites: manifestSuites,
  };
  const manifestText = `${JSON.stringify(manifestDoc, null, 2)}\n`;

  return { suiteFiles, manifestText, manifestDoc };
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const { suiteFiles, manifestText, manifestDoc } = buildAllArtifacts();

  if (checkOnly) {
    const mismatches = [];
    for (const f of suiteFiles) {
      if (!fs.existsSync(f.absPath)) {
        mismatches.push(`missing ${f.relFile}`);
      } else if (fs.readFileSync(f.absPath, "utf8") !== f.jsonText) {
        mismatches.push(`drift in ${f.relFile}`);
      }
    }
    if (!fs.existsSync(MANIFEST_PATH)) {
      mismatches.push("missing manifest.json");
    } else if (fs.readFileSync(MANIFEST_PATH, "utf8") !== manifestText) {
      mismatches.push("drift in manifest.json");
    }
    if (mismatches.length > 0) {
      console.error("Determinism check FAILED:\n  - " + mismatches.join("\n  - "));
      process.exit(1);
    }
    console.log(`OK: ${manifestDoc.total_vectors} vectors across ${suiteFiles.length} suites match byte-for-byte.`);
    return;
  }

  fs.mkdirSync(SUITES_DIR, { recursive: true });
  for (const f of suiteFiles) {
    fs.writeFileSync(f.absPath, f.jsonText, "utf8");
  }
  fs.writeFileSync(MANIFEST_PATH, manifestText, "utf8");
  console.log(
    `Generated ${manifestDoc.total_vectors} golden vectors (${manifestDoc.sql_supported_count} SQL-supported, ${manifestDoc.sql_refused_count} SQL-refused) across ${suiteFiles.length} suites.`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
