# Bind Parser Conformance Golden Vectors (`spec/vectors/`)

Deterministic golden conformance vectors for Bind's four parser runtimes (Mesh loader runtime, TypeScript `runtime-ts`, ClickHouse SQL compiler, and Swift runtime) against §5, §14, and §17.

## Layout

| File | Purpose |
| --- | --- |
| [`vector.schema.json`](./vector.schema.json) | Draft 2020-12 JSON Schema validating every golden vector suite and transitively validating every embedded `ParserSpec` against `https://schemas.bind.dev/v1/parser-spec.schema.json`. |
| [`manifest.json`](./manifest.json) | Suite index, vector counts (total, SQL-supported, SQL-refused), default deterministic execution context (`hmac_keys`, `reference_ts_ms`), and SHA-256 checksums for every suite file. |
| [`suites/01-holes-word-int-float.json`](./suites/01-holes-word-int-float.json) | `word` (explicit and omitted default), `int` (int64 bounds, signs, overflow), and `float` (scientific notation, IEEE-754 hex, overflow, NaN/Inf rejection). |
| [`suites/02-holes-uuid-hex-ip-time.json`](./suites/02-holes-uuid-hex-ip-time.json) | `uuid`, `hex`, `ip` (IPv4 & IPv6), and `time` (ISO 8601, Apache, syslog) hole lexers. |
| [`suites/03-holes-quoted-json-until-rest.json`](./suites/03-holes-quoted-json-until-rest.json) | `quoted` (single/double, escapes, next-literal inside), `json` (all SQL-refused), `until` (single-char, multi-char, regex metacharacters, Unicode, empty, leftmost), and `rest` (empty, multiline, Unicode). |
| [`suites/04-transforms-core.json`](./suites/04-transforms-core.json) | `cast` (all 5 targets), `scale` (single-op IEEE-754 double bit patterns), `unit` (all 7 time units and all 9 byte units), `parse_time` (all 10 formats), `lower`, and `enum_map`. |
| [`suites/05-transforms-privacy-and-redaction.json`](./suites/05-transforms-privacy-and-redaction.json) | `hash`, `mask` (`token` and `ip_prefix` IPv4 `/24` & IPv6 `/48`), `drop`, and Stage 2/3 redaction tokens (`<card>`, `<secret:jwt>`, `<email:9f2c41d07a3b55e1>`) across all 11 hole classes and all 7 field types. |
| [`suites/06-matchers-object-and-args.json`](./suites/06-matchers-object-and-args.json) | `object` matcher (pure, nested paths, optional/missing paths, `message` sub-pattern, SQL-refused `message` `json` holes, SQL-supported `from.path` `json` fields) and `args` matcher (empty strings, arity/strings mismatches, typed args, nulls, transforms, redaction tokens). |
| [`suites/07-boundaries-unicode-adjacent-large.json`](./suites/07-boundaries-unicode-adjacent-large.json) | §5 canonical `order.paid` example, zero-field static text, RE2 metacharacter literals, adjacent holes, UTF-8 non-ASCII cases (`U+00A0`, `U+3000`, combining marks, emoji, ZWJ clusters), exact 65,536-byte (64 KiB) records, and multi-field isolation. |

## Canonical Result Encoding (§17)

Every vector's `expected` result is either:
- `{ "matched": false }`, or
- `{ "matched": true, "fields": { "<field_name>": <FieldResult> } }` containing exactly one entry per declared field in `spec.fields`.

`<FieldResult>` uses five discriminated `status` variants:

| `status` | Shape | Semantics |
| --- | --- | --- |
| `ok` | `{ "status": "ok", "type": "<FieldType>", "value": <canonical> }` | Typed value extracted and transformed cleanly. |
| `redacted` | `{ "status": "redacted", "token": "<kind[:tag]>" }` | No value stored; masked by a redaction token, a pseudonym token in a non-`string` field, or `mask(mode: "token")` (§5). |
| `dropped` | `{ "status": "dropped" }` | Discarded by `{ "op": "drop" }`. |
| `missing` | `{ "status": "missing" }` | Absent optional object key path or `null` value in `object` / `args` input (transforms short-circuit). |
| `parse_error` | `{ "status": "parse_error", "code": "<reason>" }` | Record matched the template, but parsing/casting/transforming this field failed (`int_overflow`, `float_overflow`, `cast_failed`, `invalid_time`, `unmapped_enum`, `invalid_ip`, `type_mismatch`, `invalid_json`). Comparers enforce `status === "parse_error"`; `code` is diagnostic. |

Canonical value encoding for `status: "ok"` (§17):
- **`string` / `enum`**: exact UTF-8 bytes (no Unicode NFC/NFD normalization).
- **`int`**: signed 64-bit integer encoded as a canonical base-10 decimal string (`"-9223372036854775808"` .. `"9223372036854775807"`).
- **`float`**: finite IEEE 754 binary64 big-endian bit pattern as 16 lowercase hex characters (e.g. `1999 / 100` = `"4033fd70a3d70a3d"`, distinct from `1999 * 0.01` = `"4033fd70a3d70a3e"`).
- **`bool`**: JSON boolean (`true` or `false`).
- **`timestamp`**: integer milliseconds since Unix epoch (`1970-01-01T00:00:00.000Z`), matching `events.ts` (`DateTime64(3)`).
- **`json`**: parsed JSON value compared structurally.

## SQL Compiler Refusal Representation (§5, T2.1.5)

Every vector carries an explicit `sql` contract object and matching tags:
- **Supported** (all `text` specs without a `json` hole, all `object` specs whose optional `message` sub-pattern has no `json` hole, and all `args` specs — including `type: "json"` fields read via `from.path` or `from.arg`):
  ```json
  "sql": { "supported": true }
  ```
- **Refused** (any `text` spec or `object` `message` sub-pattern containing a `class: "json"` hole, because ClickHouse RE2 `extractGroups` cannot match balanced brackets):
  ```json
  "sql": {
    "supported": false,
    "refusal_code": "unsupported_json_hole",
    "reason": "Specs containing a json hole cannot be compiled to ClickHouse RE2 extractGroups because RE2 cannot match balanced brackets (§5, T2.1.5)."
  }
  ```
  Refused vectors also carry both `"sql:refuse"` and `"sql:refuse:json_hole"` in `tags`.

## Deterministic Execution Context

Each suite (and optionally individual vectors) provides a deterministic `context`:
- `hmac_keys`: `{ "edge": "bind-conformance-edge-key-v1", "server": "bind-conformance-server-key-v1" }` for keyed nested `HMAC-SHA256` in `hash` transforms.
- `reference_ts_ms`: `1795701600000` (`2026-11-26T14:00:00.000Z`) for resolving yearless RFC 3164 `syslog` timestamps in `parse_time`.

## Verification

```bash
npm --prefix spec run validate:vectors
node spec/scripts/build-vectors.mjs --check
npm --prefix spec test
```

## Pinned Semantics & Tagged Ambiguities

Vectors whose semantics resolve an under-specified area of §5/§14 carry an `ambiguity:*` tag so runtime authors and reviewers can track them directly:
- `ambiguity:mask_token_storage`: `mask(mode: "token")` yields `status: "redacted"` (`null` in `spec.tests[].expect`) per §5 and T2.1.1's `parser-spec-all-transforms.yaml`, rather than a literal string `"<name>"` from §14's summary table.
- `ambiguity:hmac_inner_encoding` / `ambiguity:hash_default_kind`: outer `HMAC-SHA256(k_server, inner)` hashes the 32 raw bytes of `HMAC-SHA256(k_edge, UTF8(value))`; omitted `hash.kind` defaults to `field.pii` (when non-`none`) or `"hash"`.
- `ambiguity:quoted_unquote`: `quoted` strips outer quotes and unescapes `\\`, `\"`, `\'`, `\n`, `\r`, `\t`.
- `ambiguity:syslog_rfc3164_year`: yearless RFC 3164 syslog timestamps resolve year in UTC from `context.reference_ts_ms`.
- `ambiguity:lower_unicode`: `lower` performs UTF-8 Unicode lowercasing (`CAFÉ` → `café`, ClickHouse `lowerUTF8()`).
- `ambiguity:object_subset_shape`: single-spec `object` evaluation treats `match.shape` as required key paths (extra unreferenced keys permitted).
- `ambiguity:enum_map_no_default`: unmapped value in `enum_map` without `default` yields `parse_error` (`unmapped_enum`).
- `ambiguity:subms_truncation`: `parse_time` truncates sub-millisecond fractional digits toward zero to integer milliseconds.
- `ambiguity:unit_cross_base`: cross-base byte conversions (`KiB -> KB`) reduce `gcd(from, to)` and apply `(val * mul) / div` in binary64.
