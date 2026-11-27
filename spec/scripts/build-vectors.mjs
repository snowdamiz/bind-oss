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
export const VECTORS_DIR = path.resolve(__dirname, "..", "vectors");
export const SUITES_DIR = path.join(VECTORS_DIR, "suites");
export const MANIFEST_PATH = path.join(VECTORS_DIR, "manifest.json");

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
      "Deterministic golden conformance vector manifest for Bind ParserSpec runtimes (Mesh, TypeScript, ClickHouse SQL, Swift).",
    default_context: DEFAULT_CONTEXT,
    total_vectors: totalVectors,
    sql_supported_count: sqlSupportedCount,
    sql_refused_count: sqlRefusedCount,
    suites: manifestSuites,
  };
  const manifestText = `${JSON.stringify(manifestDoc, null, 2)}\n`;

  return { suiteFiles, manifestText, manifestDoc };
}

export function findExtraSuiteFiles(suitesDir, expectedRelFiles) {
  if (!fs.existsSync(suitesDir)) return [];
  const expectedNames = new Set(expectedRelFiles.map((rel) => path.basename(rel)));
  return fs
    .readdirSync(suitesDir)
    .filter((name) => !expectedNames.has(name))
    .sort();
}

export function checkAllArtifacts(options = {}) {
  const vectorsDir = options.vectorsDir ?? VECTORS_DIR;
  const suitesDir = options.suitesDir ?? path.join(vectorsDir, "suites");
  const manifestPath = options.manifestPath ?? path.join(vectorsDir, "manifest.json");
  const built = options.built ?? buildAllArtifacts();
  const mismatches = [];

  for (const f of built.suiteFiles) {
    const targetPath = path.join(vectorsDir, f.relFile);
    if (!fs.existsSync(targetPath)) {
      mismatches.push(`missing ${f.relFile}`);
    } else if (fs.readFileSync(targetPath, "utf8") !== f.jsonText) {
      mismatches.push(`drift in ${f.relFile}`);
    }
  }

  const extraFiles = findExtraSuiteFiles(
    suitesDir,
    built.suiteFiles.map((f) => f.relFile)
  );
  for (const extra of extraFiles) {
    mismatches.push(`extra unlisted file in suites/: ${extra}`);
  }

  if (!fs.existsSync(manifestPath)) {
    mismatches.push("missing manifest.json");
  } else if (fs.readFileSync(manifestPath, "utf8") !== built.manifestText) {
    mismatches.push("drift in manifest.json");
  }

  return {
    ok: mismatches.length === 0,
    mismatches,
    manifestDoc: built.manifestDoc,
    suiteCount: built.suiteFiles.length,
  };
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const built = buildAllArtifacts();

  if (checkOnly) {
    const res = checkAllArtifacts({ built });
    if (!res.ok) {
      console.error("Determinism check FAILED:\n  - " + res.mismatches.join("\n  - "));
      process.exit(1);
    }
    console.log(
      `OK: ${res.manifestDoc.total_vectors} vectors across ${res.suiteCount} suites match byte-for-byte.`
    );
    return;
  }

  const extraFiles = findExtraSuiteFiles(
    SUITES_DIR,
    built.suiteFiles.map((f) => f.relFile)
  );
  if (extraFiles.length > 0) {
    console.error(
      "Regeneration FAILED: unexpected extra file(s) in spec/vectors/suites/:\n  - " +
        extraFiles.join("\n  - ")
    );
    process.exit(1);
  }

  fs.mkdirSync(SUITES_DIR, { recursive: true });
  for (const f of built.suiteFiles) {
    fs.writeFileSync(f.absPath, f.jsonText, "utf8");
  }
  fs.writeFileSync(MANIFEST_PATH, built.manifestText, "utf8");
  console.log(
    `Generated ${built.manifestDoc.total_vectors} golden vectors (${built.manifestDoc.sql_supported_count} SQL-supported, ${built.manifestDoc.sql_refused_count} SQL-refused) across ${built.suiteFiles.length} suites.`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
