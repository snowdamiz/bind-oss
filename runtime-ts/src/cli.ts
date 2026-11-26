#!/usr/bin/env node
/**
 * Cross-runtime conformance fixture runner CLI for `@bind/runtime-ts`.
 * Reads one or more JSON/NDJSON golden vector suites (`spec/vectors/vector.schema.json`)
 * or ParserSpec JSON files and emits section 17 canonical results so a comparer can diff
 * TypeScript, Mesh, SQL, and Swift runtimes.
 */

import * as fs from "node:fs";
import process from "node:process";
import type { HashKeys, RuntimeOptions } from "./types.js";
import {
  formatCanonicalResults,
  formatVectorResults,
  parseFixturePayload,
  runVectorCases,
  type VectorCase,
} from "./runner.js";
import { fromHex } from "./utf8.js";

type OutputFormat = "json" | "ndjson" | "vector" | "vector-ndjson";

function printHelp(): void {
  process.stderr.write(
    [
      "Usage: bind-runtime-ts-runner --input <path|-> [options]",
      "",
      "Options:",
      "  -i, --input <path|->           Input JSON/NDJSON vector suite or ParserSpec JSON (repeatable; '-' for stdin)",
      "  -o, --output <path>            Output file path for results (default: stdout)",
      "  -f, --format <fmt>             Output format: json | ndjson | vector | vector-ndjson (default: json)",
      "      --check                    Verify results against each case's `expect`/`expected` and exit 1 on mismatch",
      "      --strict-error-codes       Also enforce diagnostic parse_error.code equality under --check",
      "      --edge-key <utf8>          Default k_edge UTF-8 key for hash transforms",
      "      --server-key <utf8>        Default k_server UTF-8 key for hash transforms",
      "      --edge-key-hex <hex>       Default k_edge hex-encoded key for hash transforms",
      "      --server-key-hex <hex>     Default k_server hex-encoded key for hash transforms",
      "      --reference-year <int>     Default reference year for yearless syslog timestamps (default: 1970)",
      "      --reference-ts-ms <int>    Default UTC epoch ms reference timestamp for yearless formats",
      "  -h, --help                     Show this help message",
      "",
    ].join("\n"),
  );
}

function main(argv: readonly string[]): number {
  const inputPaths: string[] = [];
  let outputPath: string | undefined;
  let format: OutputFormat = "json";
  let check = false;
  let strictErrorCodes = false;
  let edgeKey: Uint8Array | string | undefined;
  let serverKey: Uint8Array | string | undefined;
  let referenceYear: number | undefined;
  let referenceTsMs: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        printHelp();
        return 0;
      case "-i":
      case "--input": {
        const next = argv[++i];
        if (next === undefined) {
          process.stderr.write("Error: --input requires a path\n");
          return 2;
        }
        inputPaths.push(next);
        break;
      }
      case "-o":
      case "--output":
        outputPath = argv[++i];
        break;
      case "-f":
      case "--format": {
        const val = argv[++i];
        if (val !== "json" && val !== "ndjson" && val !== "vector" && val !== "vector-ndjson") {
          process.stderr.write(
            `Invalid format "${String(val)}": expected "json", "ndjson", "vector", or "vector-ndjson"\n`,
          );
          return 2;
        }
        format = val;
        break;
      }
      case "--check":
        check = true;
        break;
      case "--strict-error-codes":
        strictErrorCodes = true;
        break;
      case "--edge-key":
        edgeKey = argv[++i];
        break;
      case "--server-key":
        serverKey = argv[++i];
        break;
      case "--edge-key-hex": {
        const hex = argv[++i] ?? "";
        const bytes = fromHex(hex);
        if (bytes === null) {
          process.stderr.write(`Invalid hex for --edge-key-hex: "${hex}"\n`);
          return 2;
        }
        edgeKey = bytes;
        break;
      }
      case "--server-key-hex": {
        const hex = argv[++i] ?? "";
        const bytes = fromHex(hex);
        if (bytes === null) {
          process.stderr.write(`Invalid hex for --server-key-hex: "${hex}"\n`);
          return 2;
        }
        serverKey = bytes;
        break;
      }
      case "--reference-year": {
        const raw = argv[++i] ?? "";
        const parsed = Number(raw);
        if (!Number.isInteger(parsed)) {
          process.stderr.write(`Invalid integer for --reference-year: "${raw}"\n`);
          return 2;
        }
        referenceYear = parsed;
        break;
      }
      case "--reference-ts-ms": {
        const raw = argv[++i] ?? "";
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          process.stderr.write(`Invalid number for --reference-ts-ms: "${raw}"\n`);
          return 2;
        }
        referenceTsMs = parsed;
        break;
      }
      default:
        if (!arg.startsWith("-")) {
          inputPaths.push(arg);
        } else {
          process.stderr.write(`Unknown argument: ${arg}\n`);
          printHelp();
          return 2;
        }
    }
  }

  if (inputPaths.length === 0) {
    process.stderr.write("Error: --input <path|-> is required\n");
    printHelp();
    return 2;
  }

  const allCases: VectorCase[] = [];
  for (const inputPath of inputPaths) {
    let rawText: string;
    try {
      rawText =
        inputPath === "-"
          ? fs.readFileSync(0, "utf8")
          : fs.readFileSync(inputPath, "utf8");
    } catch (err) {
      process.stderr.write(`Failed to read input "${inputPath}": ${String(err)}\n`);
      return 2;
    }

    try {
      const cases = parseFixturePayload(rawText, inputPath);
      allCases.push(...cases);
    } catch (err) {
      process.stderr.write(`Failed to parse fixtures from "${inputPath}": ${String(err)}\n`);
      return 2;
    }
  }

  const hashKeys: HashKeys | undefined =
    edgeKey !== undefined || serverKey !== undefined
      ? {
          ...(edgeKey !== undefined ? { edgeKey } : {}),
          ...(serverKey !== undefined ? { serverKey } : {}),
        }
      : undefined;

  const options: RuntimeOptions = {
    ...(hashKeys !== undefined ? { hashKeys } : {}),
    ...(referenceYear !== undefined ? { referenceYear } : {}),
    ...(referenceTsMs !== undefined ? { referenceTsMs } : {}),
  };

  let report;
  try {
    report = runVectorCases(allCases, options, { checkErrorCode: strictErrorCodes });
  } catch (err) {
    process.stderr.write(`Failed to run fixtures: ${String(err)}\n`);
    return 2;
  }

  const serialized =
    format === "vector"
      ? formatVectorResults(report.vectorResults, "json")
      : format === "vector-ndjson"
        ? formatVectorResults(report.vectorResults, "ndjson")
        : formatCanonicalResults(report.results, format);

  if (outputPath !== undefined) {
    fs.writeFileSync(outputPath, serialized, "utf8");
  } else {
    process.stdout.write(serialized);
  }

  if (check) {
    if (report.failed > 0) {
      for (const c of report.checks) {
        if (!c.passed) {
          process.stderr.write(`FAIL ${c.id}:\n`);
          for (const d of c.diffs) {
            process.stderr.write(`  - ${d}\n`);
          }
        }
      }
      process.stderr.write(
        `Summary: ${report.passed}/${report.checked} checked passed, ${report.failed} failed (total=${report.total})\n`,
      );
      return 1;
    }
    process.stderr.write(
      `PASS: ${report.passed}/${report.checked} checked cases passed (total=${report.total})\n`,
    );
  }

  return 0;
}

process.exitCode = main(process.argv.slice(2));
