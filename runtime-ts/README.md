# `@bind/runtime-ts`

Dependency-free, hand-written TypeScript parser runtime for Bind `ParserSpec` artifacts (section 5 & section 17).

## Design invariants

- **Zero runtime dependencies**: Core modules (`src/index.ts` and everything it exports) use only standard ES2022 globals (`Uint8Array`, `DataView`, `BigInt`, `TextEncoder`, `TextDecoder`) with zero external packages and zero Node built-ins.
- **Deterministic hand-written UTF-8 byte scanners**: Zero `RegExp` usage. All 11 hole classes (`word`, `int`, `float`, `uuid`, `hex`, `ip`, `time`, `quoted`, `json`, `until`, `rest`) scan UTF-8 bytes directly in guaranteed linear time `O(n + m)` using KMP literal search and an iterative RFC 8259 JSON scanner.
- **UTF-8 byte bounds**: Every matched hole reports exact `[start, end)` UTF-8 byte offsets so body span rewriting and cross-runtime comparison agree across Mesh, ClickHouse SQL, TypeScript, and Swift—even with multi-byte Unicode, combining marks, emoji, `U+00A0`, and `U+3000`.
- **All 3 match kinds**: `text`, `object` (required key-path `shape` + optional `message` text sub-pattern), and `args` (SDK template literal parts + positional arguments).
- **All 9 transforms & fail-closed redaction**: `cast`, `scale` (single IEEE 754 binary64 op), `unit` (time & SI/IEC bytes), `parse_time` (all 10 formats to exact Int64 ms), `lower`, `enum_map`, `hash` (pure-TS two-key HMAC-SHA256 pseudonymization, fail-closed when keys are absent), `mask` (`token` and `ip_prefix` `/24` IPv4 & `/48` RFC 5952 IPv6), and `drop`.

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

The CLI reads `spec/vectors/suites/*.json` conformance suites (matching `spec/vectors/vector.schema.json`), JSON/NDJSON vector suites, or standalone `ParserSpec` JSON files, and emits either section 17 canonical results or exact conformance vector results:

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
