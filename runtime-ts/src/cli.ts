#!/usr/bin/env node
/**
 * Cross-runtime conformance fixture runner CLI for `@bind/runtime-ts`.
 * Reads a JSON/NDJSON vector suite or ParserSpec JSON file and emits section 17
 * canonical results so a comparer can diff TypeScript, Mesh, SQL, and Swift runtimes.
 */

import * as fs from "node:fs";
import process from "node:process";
import type { HashKeys, RuntimeOptions } from "./types.js";
import {
  formatCanonicalResults,
  parseFixturePayload,
  runVectorCases,
} from "./runner.js";
import { fromHex } from "./utf8.js";

function printHelp(): void {
  process.stderr.write(
    [
      "Usage: bind-runtime-ts-runner --input <path|-> [options]",
      "",
      "Options:",
      "  -i, --input <path|->        Input JSON/NDJSON vector file or ParserSpec JSON (or '-' for stdin)",
      "  -o, --output <path>         Output file path for canonical results (default: stdout)",
      "  -f, --format <json|ndjson>  Output format (default: json)",
      "      --check                 Verify results against each case's `expect` and exit 1 on mismatch",
      "      --edge-key <utf8>       Default k_edge UTF-8 key for hash transforms",
      "      --server-key <utf8>     Default k_server UTF-8 key for hash transforms",
      "      --edge-key-hex <hex>    Default k_edge hex-encoded key for hash transforms",
      "      --server-key-hex <hex>  Default k_server hex-encoded key for hash transforms",
      "      --reference-year <int>  Default reference year for yearless syslog timestamps (default: 1970)",
      "  -h, --help                  Show this help message",
      "",
    ].join("\n"),
  );
}

function main(argv: readonly string[]): number {
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  let format: "json" | "ndjson" = "json";
  let check = false;
  let edgeKey: Uint8Array | string | undefined;
  let serverKey: Uint8Array | string | undefined;
  let referenceYear: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        printHelp();
        return 0;
      case "-i":
      case "--input":
        inputPath = argv[++i];
        break;
      case "-o":
      case "--output":
        outputPath = argv[++i];
        break;
      case "-f":
      case "--format": {
        const val = argv[++i];
        if (val !== "json" && val !== "ndjson") {
          process.stderr.write(`Invalid format "${String(val)}": expected "json" or "ndjson"\n`);
          return 2;
        }
        format = val;
        break;
      }
      case "--check":
        check = true;
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
      default:
        if (!arg.startsWith("-") && inputPath === undefined) {
          inputPath = arg;
        } else {
          process.stderr.write(`Unknown argument: ${arg}\n`);
          printHelp();
          return 2;
        }
    }
  }

  if (inputPath === undefined) {
    process.stderr.write("Error: --input <path|-> is required\n");
    printHelp();
    return 2;
  }

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
  };

  let report;
  try {
    const cases = parseFixturePayload(rawText, inputPath);
    report = runVectorCases(cases, options);
  } catch (err) {
    process.stderr.write(`Failed to parse or run fixtures: ${String(err)}\n`);
    return 2;
  }

  const serialized = formatCanonicalResults(report.results, format);
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
