# `@bind/node`

Core Node.js transport and client baseline for Bind (`POST /v1/batch`).

## Highlights

- Zero runtime dependencies; dual ESM and CommonJS builds for Node 20+, Bun, and Deno.
- Non-blocking, never-throwing `enqueue()` into a byte-bounded queue with oldest-debug-first eviction and drop-count reporting.
- Automatic flush at 500 records, 256 KiB compressed, or 5 seconds, whichever comes first, with gzip compression (`Content-Encoding: gzip`) or uncompressed JSON (`compression: "none"`).
- Strict retryable status handling (`429`, `502`, `503`, `504`), `Retry-After` (delay-seconds and HTTP-date), exponential backoff with jitter, per-request timeouts, and byte-identical batch payloads and `batch_id` across retries.
- BigInt epoch nanosecond timestamps with zero JavaScript floating-point arithmetic.

## Scripts

```bash
npm run typecheck
npm run build
npm test
```
