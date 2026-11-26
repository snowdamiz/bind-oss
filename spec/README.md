# Bind Parser Specification (`spec/`)

JSON Schema (Draft 2020-12) definitions and verification fixtures for Bind's declarative parser artifact (`ParserSpec`) and event registry entry (`EventType`).

## Schemas

| File | `$id` | Purpose |
| --- | --- | --- |
| [`schemas/common.schema.json`](./schemas/common.schema.json) | `https://schemas.bind.dev/v1/common.schema.json` | Shared identifier formats (`evt_`, `fld_`, `tpl_`, `ent_`), closed catalogs, text match segments, declared transforms, and ClickHouse storage slot families. |
| [`schemas/parser-spec.schema.json`](./schemas/parser-spec.schema.json) | `https://schemas.bind.dev/v1/parser-spec.schema.json` | Declarative, versioned `ParserSpec` covering `text`, `object` (with optional `message` sub-pattern), and `args` matchers, field bindings, transforms, provenance, and positive test cases. |
| [`schemas/event-type.schema.json`](./schemas/event-type.schema.json) | `https://schemas.bind.dev/v1/event-type.schema.json` | Typed `EventType` registry schema with ClickHouse storage slot type-compatibility checks and template membership. |

## Verification

```bash
npm --prefix spec install --ignore-scripts
npm --prefix spec test
```

Validate individual YAML or JSON files with the CLI:

```bash
node spec/scripts/validate.mjs --schema parser-spec spec/fixtures/valid/parser-spec-section5-text.yaml
node spec/scripts/validate.mjs --schema event-type spec/fixtures/valid/event-type-section5.yaml
```

## Scope Boundary: JSON Schema vs Runtime & Registry Invariants

JSON Schema enforces **static, single-document structural validity**. Cross-reference, lexer grammar, type-checking, execution, and historical/stateful invariants are owned by the parser runtimes and the registry publish gate.

### Enforced by JSON Schema (`spec/schemas/`)

- **Strict document shape**: required properties, `spec_version: 1`, `additionalProperties: false` across all objects.
- **Closed catalogs**:
  - Match kinds: `text`, `object`, `args`
  - Hole classes: `word`, `int`, `float`, `uuid`, `hex`, `ip`, `time`, `quoted`, `json`, `until`, `rest` (no free-form regexes)
  - Transforms: `cast`, `scale`, `unit`, `parse_time`, `lower`, `enum_map`, `hash`, `mask`, `drop`
  - Field types: `string`, `int`, `float`, `bool`, `timestamp`, `enum`, `json`
  - Field semantics: closed semantic catalog, `id.<entity>`, and `unknown`
  - PII classes: `none`, `pseudonymous_id`, `email`, `phone`, `ip`, `name`, `address`, `secret`, `free_text`
  - Storage slots: `actor`, `account`, `extra`, `s01`–`s24`, `i01`–`i12`, `f01`–`f12`, `b01`–`b04`, `t01`–`t04`
- **Single-document variant coherence**:
  - `match.kind: "text"` requires `segments`, binds fields via `from.hole`, and requires `tests[].line`.
  - `match.kind: "object"` requires unique `shape` key paths and `tests[].object`; binds fields via `from.path`, and allows `from.hole` only when `match.message` is declared.
  - `match.kind: "args"` requires `strings`, binds fields via `from.arg` (non-negative integer), and requires `tests[].args`.
  - `source.kind: "callsite"` requires `repo`, `path`, and `line`.
  - `scale` requires exactly one non-zero integer `mul` or `div` (never a fraction, never both).
  - `unit` requires `from` and `to` in the same dimension (time-to-time or bytes-to-bytes).
  - `EventType` field `type` must be compatible with its assigned `slot` family (`string` → `s01`–`s24`/`actor`/`account`/`extra`; `enum`/`json` → `s01`–`s24`/`extra`; `int` → `i01`–`i12`/`extra`; `float` → `f01`–`f12`/`extra`; `bool` → `b01`–`b04`/`extra`; `timestamp` → `t01`–`t04`/`extra`).

### Owned by Parser Runtimes & Registry (Out of Schema Scope)

- **Cross-references inside a `ParserSpec`**: every `from.hole` exists in `match.segments` or `match.message.segments`; hole names are unique; every `from.arg < match.strings.length - 1`; `match.message.path` and `from.path` align with `match.shape`; `fields[].id` and `fields[].name` are unique; `tests[].expect` keys match declared field names and types.
- **Lexer & segment grammar**: `until` must be followed by a literal segment; `rest` must be the final segment; adjacent literals coalesced in canonical form; prefix-tree tie-break ordering.
- **Transform pipeline semantics**: input/output type compatibility across chained transforms; single IEEE 754 double arithmetic for `scale`; Stage 3 default PII redaction transforms; replacement token handling across hole classes (`<email:tag>` vs mask tokens); SQL compiler refusal of `json` holes.
- **Registry & lifecycle state**: `EventType` slot uniqueness across live fields and no slot reuse within retention; `actor`/`account` assignment policy; field ID immutability on rename vs new field ID on type/unit change; monotonic `version` per template; `origin: user` edit locks; `valid_from_commit` ancestry resolution; publish-gate execution of `tests[]` in Mesh and ClickHouse SQL.
