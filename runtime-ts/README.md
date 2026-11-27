# `@bind/runtime-ts`

Dependency-free, hand-written TypeScript parser runtime for Bind `ParserSpec` artifacts.

## Design invariants

- **Zero runtime dependencies**: Core modules (`src/index.ts` and everything it exports) use only standard ES2022 globals (`Uint8Array`, `DataView`, `BigInt`, `TextEncoder`, `TextDecoder`) with zero external packages and zero Node built-ins.
- **Deterministic hand-written UTF-8 byte scanners**: Zero `RegExp` usage. All 11 hole classes (`word`, `int`, `float`, `uuid`, `hex`, `ip`, `time`, `quoted`, `json`, `until`, `rest`) scan UTF-8 bytes directly in guaranteed linear time `O(n + m)` using KMP literal search and an iterative RFC 8259 JSON scanner.
- **UTF-8 byte bounds**: Every matched hole reports exact `[start, end)` UTF-8 byte offsets so body span rewriting and cross-runtime comparison agree across Mesh, ClickHouse SQL, TypeScript, and Swift—even with multi-byte Unicode, combining marks, emoji, `U+00A0`, and `U+3000`.
- **All 3 match kinds**: `text`, `object` (required key-path `shape` + optional `message` text sub-pattern), and `args` (SDK template literal parts + positional arguments).
- **All 9 transforms & fail-closed redaction**: `cast`, `scale` (single IEEE 754 binary64 op), `unit` (time & SI/IEC bytes), `parse_time` (all 10 formats to exact Int64 ms), `lower`, `enum_map`, `hash` (pure-TS two-key HMAC-SHA256 pseudonymization, fail-closed when keys are absent; default `hashMode: "hosted"`, explicit `hashMode: "edge"` / `"gateway"` for edge-only inner tokens), `mask` (`token` and `ip_prefix` `/24` IPv4 & `/48` RFC 5952 IPv6), and `drop`.

## Node.js support

- **Installed runtime consumers**: Built artifacts (`dist/`), root export (`@bind/runtime-ts`), runner subpath (`@bind/runtime-ts/runner`), and CLI (`bind-runtime-ts-runner`) have zero runtime dependencies and support **Node.js `>=20.0.0`** (`engines.node`). `prepack` runs `npm run build` so `npm pack` always ships compiled `dist/` files.
- **Development & test suite**: Running `npm ci` / `npm test` installs `vitest@5.1.2`, whose engine requirement is **Node.js `^22.12.0 || ^24.0.0 || >=26.0.0`** (with transitive `vite`/`rolldown` requiring `^20.19.0 || >=22.12.0`). Installing devDependencies with `--engine-strict` fails on Node 20.0; use Node 22.12+ (or 24+) for local development and running Vitest.

## Vector timestamp precision note

- `toVectorFieldResult` returns a JS `number` for safe integer timestamps (`±(2^53 - 1)`) and preserves exact `bigint` for non-safe Int64 millisecond values; `formatVectorResults` / `stringifyVectorJson` serialize `bigint` timestamps as exact unquoted RFC 8259 JSON integers (Node 20 compatible, no `JSON.rawJSON`), and `parseFixturePayload` + `compareVectorResults` preserve exact Int64 equality under `--check`.
- External JS consumers parsing `vector` / `vector-ndjson` output with plain `JSON.parse()` will still round JSON integers outside `±(2^53 - 1)` to IEEE-754 doubles; use `--format ndjson` (canonical decimal string timestamps) or a BigInt-capable JSON parser when consuming non-safe Int64 timestamps across runtimes.

## Usage

```ts
import {
  compileParser,
  parseRecord,
  toCanonicalResult,
  toVectorResult,
} from "@bind/runtime-ts";

const parser = compileParser(spec);
const result = parser.parse("order ord_8f2a paid 1999 in 212ms", {
  hashKeys: { edgeKey: "...", serverKey: "..." },
  referenceTsMs: 1795651200000,
});
const canonical = toCanonicalResult("case-1", result);
const vectorResult = toVectorResult(result);
```

## Cross-runtime conformance fixture runner

The CLI reads `spec/vectors/suites/*.json` conformance suites (matching `spec/vectors/vector.schema.json`), JSON/NDJSON vector suites, or standalone `ParserSpec` JSON files, and emits either canonical results or exact conformance vector results:

```bash
npm run build
node dist/cli.js --format vector-ndjson --check --strict-error-codes ../spec/vectors/suites/*.json
node dist/cli.js --input ../spec/fixtures/valid/parser-spec-section5-text.json --check
node dist/cli.js --input vectors.jsonl --output results.jsonl --format ndjson --check
```

## Development

```bash
npm run typecheck
npm test
npm run test:vectors
```
