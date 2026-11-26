# Bind Parser Conformance Golden Vectors (`spec/vectors/`)

Self-contained, deterministic golden conformance vectors for Bind's four parser runtimes (Mesh loader runtime, TypeScript `runtime-ts`, ClickHouse SQL compiler, and Swift runtime).

## Layout

| File | Purpose |
| --- | --- |
| [`vector.schema.json`](./vector.schema.json) | Draft 2020-12 JSON Schema validating every golden vector suite and transitively validating every embedded `ParserSpec` against `https://schemas.bind.dev/v1/parser-spec.schema.json`. |
| [`manifest.json`](./manifest.json) | Suite index, vector counts (total, SQL-supported, SQL-refused), default deterministic execution context (`hmac_keys`, `reference_ts_ms`), and SHA-256 checksums for every suite file. |
| [`suites/01-holes-word-int-float.json`](./suites/01-holes-word-int-float.json) | `word` (explicit and omitted default), `int` (int64 bounds, signs, overflow), and `float` (scientific notation, IEEE-754 hex, overflow, NaN/Inf rejection), plus overlapping-literal boundary cases. |
| [`suites/02-holes-uuid-hex-ip-time.json`](./suites/02-holes-uuid-hex-ip-time.json) | `uuid`, `hex`, `ip` (IPv4 & IPv6), and `time` (ISO 8601, Apache, syslog) hole lexers, including overlapping-literal boundary cases and offset-less timestamp rejection. |
| [`suites/03-holes-quoted-json-until-rest.json`](./suites/03-holes-quoted-json-until-rest.json) | `quoted` (single/double, escapes, next-literal inside), `json` (all SQL-refused), `until` (single-char, multi-char, regex metacharacters, Unicode, empty, leftmost), and `rest` (empty, multiline, Unicode). |
| [`suites/04-transforms-core.json`](./suites/04-transforms-core.json) | `cast` (all 5 targets), `scale` (single-op IEEE-754 double bit patterns), `unit` (all 7 time units and all 9 byte units), `parse_time` (all 10 formats including exact decimal `unix_s`), `lower` (locale-independent UTF-8), and `enum_map`. |
| [`suites/05-transforms-privacy-and-redaction.json`](./suites/05-transforms-privacy-and-redaction.json) | `hash`, `mask` (`token` and `ip_prefix` IPv4 `/24` & IPv6 `/48`), `drop`, pre-scrubbed redaction tokens (`<card>`, `<secret:jwt>`, `<email:9f2c41d07a3b55e1>`) across all 11 hole classes and all 7 field types, neutral unknown angle-bracket strings (`<nil>`, `<b>bold`), and explicit `pii` metadata placement. |
| [`suites/06-matchers-object-and-args.json`](./suites/06-matchers-object-and-args.json) | `object` matcher (pure, nested paths, optional/missing paths, `message` sub-pattern, SQL-refused `message` `json` holes, SQL-supported `from.path` `json` fields) and `args` matcher (empty strings, arity/strings mismatches, typed args, nulls, transforms, redaction tokens). |
| [`suites/07-boundaries-unicode-adjacent-large.json`](./suites/07-boundaries-unicode-adjacent-large.json) | Canonical `order.paid` example, zero-field static text, regex metacharacter literals, adjacent holes (including non-backtracking overlap cases), UTF-8 non-ASCII cases (`U+00A0`, `U+3000`, combining marks, emoji, ZWJ clusters), exact 65,536-byte (64 KiB) records, and multi-field isolation. |

## Canonical Result Encoding

Every vector's `expected` result is either:
- `{ "matched": false }`, or
- `{ "matched": true, "fields": { "<field_name>": <FieldResult> } }` containing exactly one entry per declared field in `spec.fields`.

`<FieldResult>` uses five discriminated `status` variants:

| `status` | Shape | Semantics |
| --- | --- | --- |
| `ok` | `{ "status": "ok", "type": "<FieldType>", "value": <canonical> }` | Typed value extracted and transformed cleanly. |
| `redacted` | `{ "status": "redacted", "token": "<kind[:tag]>" }` | No value stored; masked by a known redaction token, a pseudonym token in a non-`string` field, or `mask(mode: "token")`. |
| `dropped` | `{ "status": "dropped" }` | Discarded by `{ "op": "drop" }`. |
| `missing` | `{ "status": "missing" }` | Absent optional object key path or `null` value in `object` / `args` input (transforms short-circuit). |
| `parse_error` | `{ "status": "parse_error", "code": "<reason>" }` | Record matched the template, but parsing/casting/transforming this field failed (`int_overflow`, `float_overflow`, `cast_failed`, `invalid_time`, `unmapped_enum`, `invalid_ip`, `type_mismatch`, `invalid_json`). Comparers enforce `status === "parse_error"`; `code` is diagnostic. |

Canonical value encoding for `status: "ok"`:
- **`string` / `enum`**: exact UTF-8 bytes (no Unicode NFC/NFD normalization).
- **`int`**: signed 64-bit integer encoded as a canonical base-10 decimal string (`"-9223372036854775808"` .. `"9223372036854775807"`).
- **`float`**: finite IEEE 754 binary64 big-endian bit pattern as 16 lowercase hex characters (e.g. `1999 / 100` = `"4033fd70a3d70a3d"`, distinct from `1999 * 0.01` = `"4033fd70a3d70a3e"`).
- **`bool`**: JSON boolean (`true` or `false`).
- **`timestamp`**: integer milliseconds since Unix epoch (`1970-01-01T00:00:00.000Z`), matching `events.ts` (`DateTime64(3)`).
- **`json`**: parsed JSON value compared structurally.

## Text Scanner & Hole Boundary Semantics

Text matching (`match.kind: "text"` and `object` `match.message`) runs linearly from start to end of the UTF-8 byte string with **no backtracking** and full-line anchoring (the final segment must end at the exact end of the input):

- **Literals (`lit`)**: matched as exact UTF-8 byte sequences. Regex metacharacters are matched literally.
- **ASCII whitespace**: only `0x20` (space), `0x09` (`\t`), `0x0A` (`\n`), and `0x0D` (`\r`) count as whitespace. Non-ASCII spaces such as `U+00A0` (NO-BREAK SPACE) and `U+3000` (IDEOGRAPHIC SPACE) are ordinary non-whitespace bytes.
- **Variable-width scalar classes (`word`, `int`, `float`, `hex`, `ip`)**:
  - When **immediately followed by a literal segment**, the hole's scan window is bounded at the **leftmost occurrence** of that following literal starting at the current cursor. The hole must match a non-empty valid lexeme inside that window and consume all bytes up to the following literal. There is **no backtracking** to a later occurrence of the literal:
    - Example (`word` + `",id="`): `"tok=ord_8f2a,id=42"` captures `"ord_8f2a"`, while `"tok=a,id=b,id=42"` stops at the first `",id="` and fails to match the trailing `int`.
    - Example (`int` + `"0"`): `"n=120"` captures `12`, while `"n=1020"` stops at the first `"0"` and fails to match.
    - Example (`hex` + `"f"`): `"h=deadbeef"` captures `"deadbee"`, while `"h=afbf"` stops at the first `"f"` and fails to match.
    - Example (`float` + `"e1"` / `".0"`): `"v=1.5e1"` captures `1.5`, `"v=42.0"` captures `42.0`, while `"v=4.0.0"` stops at the first `".0"` and fails to match.
    - Example (`ip` + `":8080"` / `".1"`): `"addr=2001:db8::1:8080"` captures `"2001:db8::1"` and `"addr=10.20.30.40.1"` captures `"10.20.30.40"`, while `"addr=2001:8080::1:8080"` and `"addr=10.1.2.3.1"` fail without backtracking.
  - When **not followed by a literal** (end of line or directly followed by another hole), the lexer scans maximally according to its own class grammar with **no backtracking** across adjacent holes:
    - Example (`int` + `word`): `"t=212ms"` splits into `212` and `"ms"`, while `"t=212345"` consumes all digits in `int` leaving nothing for `word` (`matched: false`).
    - Example (`float` + `word`): `"sz=1.5ex"` splits into `1.5` and `"ex"` (since `ex` is not a valid exponent), while `"sz=1.5e2"` consumes `1.5e2` in `float` leaving nothing for `word` (`matched: false`).
- **Self-delimited & fixed-syntax classes (`uuid`, `time`, `quoted`, `json`)**:
  - Lex strictly by their own grammar and are **not** truncated by a following literal:
    - `uuid`: fixed 36-character `8-4-4-4-12` hex format (so `uuid` followed by `"f"` matches `"550e8400-e29b-41d4-a716-446655440000f"`).
    - `time`: matches a complete ISO 8601/RFC 3339 timestamp with explicit offset (`Z`, `±HH:MM`, or compact `±HHMM`), Apache access-log timestamp (`DD/Mon/YYYY:HH:MM:SS ±HHMM`), or RFC 3164 syslog timestamp (`Mon DD HH:MM:SS`). A following literal such as `"Z"`, `":ok"`, or `"00"` is matched immediately after the full timestamp lexeme.
    - `quoted`: balanced single- or double-quoted string with backslash escapes (`\\`, `\"`, `\'`, `\n`, `\r`, `\t`), stripping outer quotes and unescaping. An occurrence of the following literal inside quotes does not terminate the hole.
    - `json`: balanced JSON object (`{...}`) or array (`[...]`) parsed as valid JSON. An occurrence of the following literal inside JSON strings does not terminate the hole.
- **`until` and `rest`**:
  - `until`: requires an immediately following literal segment; captures everything up to the leftmost occurrence of that literal (may be empty).
  - `rest`: must be the final segment; captures all remaining bytes to the end of the line (may be empty).

## Known Redaction Tokens & Neutral Angle-Bracket Text

Pre-scrubbed replacement tokens emitted by upstream edge/ingest redaction take the form `<kind>` or `<kind:tag>`, where `kind` belongs to the closed redaction kind catalog:

`secret`, `private_key`, `jwt`, `auth_header`, `vendor_token`, `kv_secret`, `url_credentials`, `high_entropy`, `card`, `us_ssn`, `email`, `phone`, `ip`, `long_digits`, `name`, `address`, `free_text`, `pseudonymous_id`, `hash`, `redacted`.

- **Final pseudonym token**: `<kind:16-lowercase-hex>` (final hosted keyed HMAC tag).
- **Unexpected inner edge token**: `<kind:~64-lowercase-hex>` (inner edge HMAC tag emitted in SDK edge mode before gateway outer-HMAC upgrade). In hosted conformance evaluation, an unexpected inner edge token always fails closed as `{ "status": "redacted", "token": "<redacted>" }` on both `string` and non-`string` fields, never exposing plaintext or the 64-hex inner digest in the field value or redacted marker. Separate explicit SDK edge-mode implementations remain free to emit and handle inner edge tokens in edge-only flows.
- **Mask marker token**: `<kind>` or `<kind:descriptor>` for any known kind whose tag is neither a 16-hex final pseudonym nor a `~64-hex` inner edge tag (e.g. `<card>`, `<secret:jwt>`, `<name>`).
- **Unknown angle-bracket text**: strings whose angle-bracket name is NOT in the known kind catalog (such as `<nil>` or `<b>bold`) are **ordinary literal text**, never redaction tokens. A `word` hole captures `<nil>` and `<b>bold` verbatim as `status: "ok", type: "string"`; typed holes such as `int` reject `<nil>` (`matched: false`).
- **Word-boundary and overlapping-literal rule for known tokens**: in a `word` hole, a leading known redaction token is classified as a redaction token only when it spans the entire word up to the hole boundary (following literal, ASCII whitespace, or end of line); otherwise the hole scans as an ordinary word. Known tokens containing `:` (such as `<email:9f2c41d07a3b55e1>` or `<secret:jwt>`) match intact before an immediately following `:` literal (e.g. `v=<email:9f2c41d07a3b55e1>:200`).
- **Quoted capture token classification**: after a `quoted` hole strips its outer quotes and unescapes backslash sequences, the unescaped value is classified with the exact same recognized incoming token rules as `until`, `rest`, `object` paths, and `args` (e.g. `user="<card>"` redacts as `<card>`, `user="<email:9f2c41d07a3b55e1>"` preserves the final pseudonym on `string` fields and redacts on non-`string` fields, `user="<email:~64-hex>"` redacts as `<redacted>`, and `user="<nil>"` stays an ordinary string).
- **Field & transform behavior for pre-scrubbed tokens vs newly generated tags**:
  - Any hole class matches a known redaction token occupying that hole (for `rest`, only when the token spans the entire remaining line).
  - Unexpected inner edge tokens (`<kind:~64-lowercase-hex>`) always short-circuit transforms and yield `{ "status": "redacted", "token": "<redacted>" }` in hosted conformance.
  - Mask tokens always short-circuit transforms and yield `{ "status": "redacted", "token": "<...>" }`.
  - Incoming final pseudonym tokens (`<kind:16-lowercase-hex>`) short-circuit transforms and yield `{ "status": "ok", "type": "string", "value": "<kind:tag>" }` on `string` fields (preserved unchanged without double-hashing, masking, or dropping) and `{ "status": "redacted", "token": "<kind:tag>" }` on non-`string` fields.
  - A tag newly generated by a `hash` transform within the current pipeline (including custom `kind` labels outside the incoming redaction catalog) carries its generated-tag identity through identity-preserving string transforms (`cast` to `string`, `lower`), skips double-hashing on a subsequent `hash` transform, finalizes as `{ "status": "redacted", "token": "<kind:tag>" }` when the declared field type is not `string`, and still allows later explicit `drop` or `mask` transforms to apply.

## SQL Compiler Refusal Contract

Every vector carries an explicit `sql` contract object and matching tags:
- **Supported** (all `text` specs without a `json` hole, all `object` specs whose optional `message` sub-pattern has no `json` hole, and all `args` specs — including `type: "json"` fields read via `from.path` or `from.arg`):
  ```json
  "sql": { "supported": true }
  ```
- **Refused** (any `text` spec or `object` `message` sub-pattern containing a `class: "json"` hole, because balanced JSON text scanning is not supported by the ClickHouse SQL compiler):
  ```json
  "sql": {
    "supported": false,
    "refusal_code": "unsupported_json_hole",
    "reason": "Specs containing a text json hole are refused by the ClickHouse SQL compiler because balanced JSON text scanning is not supported in SQL compilation."
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
npm --prefix spec run check:vectors
npm --prefix spec test
```

Regenerating vectors (`npm --prefix spec run build:vectors`), checking determinism (`--check`), and validating (`validate:vectors`) all fail if any extra unlisted file is present in `spec/vectors/suites/`.

## Pinned Semantics & Tagged Ambiguities

Vectors whose semantics resolve a subtle or potentially ambiguous edge of the contract carry an `ambiguity:*` tag so runtime authors and reviewers can track them directly:

- `ambiguity:scanner_hole_boundary`: variable-width scalar holes (`word`, `int`, `float`, `hex`, `ip`) bound at the leftmost occurrence of an immediately following literal and never backtrack; adjacent holes scan maximally without backtracking; self-delimited/fixed-syntax holes (`uuid`, `time`, `quoted`, `json`) lex strictly by their own grammar.
- `ambiguity:prescrubbed_token_transforms`: a field that already holds a pre-scrubbed pseudonym token (`<email:9f2c41d07a3b55e1>`) short-circuits all declared transforms on `string` fields (including `hash`, `mask`, `lower`, and `drop`) and is stored unchanged. Note that this favors preserving already-tokenized values over re-applying a `drop` transform; callers that want a field dropped unconditionally even after upstream tokenization must enforce that at ingestion policy level.
- `ambiguity:pii_default_transform_placement`: pure `ParserSpec` runtimes execute only the transforms explicitly listed in `field.transforms` (reading `field.pii` only as the fallback `kind` for `{ "op": "hash" }`). Setting `pii: "email"` without `transforms` leaves the field value raw rather than silently injecting a hidden runtime default, because default redaction policies are materialized into explicit `field.transforms` upstream so per-project overrides remain representable in the declarative spec.
- `ambiguity:offsetless_time`: ISO 8601 timestamps without an explicit timezone suffix (`Z` or `±HH:MM`, e.g. `2026-11-26T14:00:00`) are rejected by both the `time` hole (`matched: false`) and `parse_time` (`parse_error: "invalid_time"`). Requiring an explicit offset avoids host-local timezone drift across runtimes.
- `ambiguity:quoted_token_classification`: a `quoted` hole classifies its unescaped string content using the exact recognized incoming token rules after stripping quotes and unescaping.
- `ambiguity:hosted_inner_edge_token`: in hosted conformance evaluation, an unexpected inner edge token (`<kind:~64-lowercase-hex>`) fails closed as `{ "status": "redacted", "token": "<redacted>" }` across all field types and matchers without exposing plaintext or the inner digest.
- `ambiguity:generated_tag_identity`: a tag newly generated by `hash` in the current transform pipeline carries its generated-tag identity across custom labels, identity-preserving transforms (`cast` to `string`, `lower`), repeated `hash`, and non-`string` finalization (`status: "redacted"`), while keeping later explicit `drop` and `mask` transforms active.
- `ambiguity:unix_s_exact_decimal`: `parse_time(format: "unix_s")` parses fractional epoch seconds using exact base-10 decimal arithmetic truncating sub-millisecond digits toward zero (`"1.001"` → `1001`, `"-1.0019"` → `-1001`), never IEEE-754 `seconds * 1000.0` (which would drift `"1.001"` to `1000`). Direct `float` holes feeding `parse_time(format: "unix_s")` preserve their original decimal lexeme (so `1795701600.12399999` truncates to `1795701600123` rather than rounding through binary64 to `1795701600124`) and handle bounded zero-padded exponents (`1e+000000002`, `1e-000000002`, `1.25e000000000`) accurately.
- `ambiguity:lower_unicode`: `lower` performs locale-independent Unicode root-locale lowercasing (`CAFÉ` → `café`, `İSTANBUL I` → `i\u0307stanbul i`; ASCII `I` always folds to `i`, never Turkish dotless `ı`). Context-sensitive Unicode SpecialCasing (such as Greek final sigma `Σ` → `ς` vs `σ`) is not required by the simple per-codepoint `lowerUTF8` baseline and is intentionally excluded from conformance pinning.
- `ambiguity:mask_token_storage`: `mask(mode: "token")` yields `status: "redacted"` (`null` in `spec.tests[].expect`) rather than storing a literal string token.
- `ambiguity:hmac_inner_encoding` / `ambiguity:hash_default_kind`: outer `HMAC-SHA256(k_server, inner)` hashes the 32 raw bytes of `HMAC-SHA256(k_edge, UTF8(value))`; omitted `hash.kind` defaults to `field.pii` (when non-`none`) or `"hash"`.
- `ambiguity:quoted_unquote`: `quoted` strips outer quotes and unescapes `\\`, `\"`, `\'`, `\n`, `\r`, `\t`.
- `ambiguity:syslog_rfc3164_year`: yearless RFC 3164 syslog timestamps resolve year in UTC from `context.reference_ts_ms`.
- `ambiguity:object_subset_shape`: single-spec `object` evaluation treats `match.shape` as required key paths (extra unreferenced keys permitted).
- `ambiguity:enum_map_no_default`: unmapped value in `enum_map` without `default` yields `parse_error` (`unmapped_enum`).
- `ambiguity:subms_truncation`: `parse_time` truncates sub-millisecond fractional digits toward zero to integer milliseconds.
- `ambiguity:unit_cross_base`: cross-base byte conversions (`KiB -> KB`) reduce `gcd(from, to)` and apply `(val * mul) / div` in binary64.
