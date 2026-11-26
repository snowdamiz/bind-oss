# `@bind/node`

Node.js SDK transport and structured/tagged-template logging client for Bind (`POST /v1/batch`).

## Highlights

- Zero runtime dependencies; dual ESM and CommonJS builds for Node 20+, Bun, and Deno.
- Tagged-template capture (`log.info\`order ${id} paid ${cents}\``) preserving literal parts (`tpl.strings`) and typed values (`tpl.args`) separately alongside a searchable rendered `body`.
- Structured event capture (`log.info("order.paid", { orderId, cents })`) preserving event names and typed fields without key collisions, plus `.child(...)` bound context (`attrs`, `trace_id`, `span_id`, default `fields`).
- Source-mapped call-site capture via Node's built-in `node:module` source-map support (`findSourceMap` and `SourceMap`), cached once per tagged-template call site (`WeakMap`) and sampled for the first few calls per structured shape key. Omits `callsite` cleanly when source maps are not deployed.
- Non-blocking, never-throwing capture and `enqueue()` into a byte-bounded queue with oldest-debug-first eviction, drop-count reporting, and diagnostic `onError` surfacing (no silent failures).
- Automatic flush at 500 records, 256 KiB compressed, or 5 seconds, whichever comes first, with gzip compression (`Content-Encoding: gzip`) or uncompressed JSON (`compression: "none"`).
- Strict retryable status handling (`429`, `502`, `503`, `504`), `Retry-After` (delay-seconds and HTTP-date), exponential backoff with jitter, per-request timeouts, and byte-identical batch payloads and `batch_id` across retries.
- BigInt epoch nanosecond timestamps with zero JavaScript floating-point arithmetic.

## Usage

```ts
import { init, log } from "@bind/node";

init({ key: process.env.BIND_KEY, service: "checkout" });

log.info`order ${orderId} paid ${cents} in ${ms}ms`;
log.info("order.paid", { orderId, cents, currency: "USD" });
```

## Scripts

```bash
npm run typecheck
npm run build
npm test
```
