import {
  argsInput,
  argsSpec,
  dropped,
  field,
  hmacTag,
  match,
  missing,
  noMatch,
  objectInput,
  objectSpec,
  okBool,
  okEnum,
  okFloat,
  okFloatHex,
  okInt,
  okJson,
  okStr,
  okTs,
  parseErr,
  redacted,
  vec,
} from "../lib/vector-builders.mjs";

export function buildSuite06() {
  const vectors = [];
  const T_BASE = Date.UTC(2026, 10, 26, 14, 0, 0, 0);

  // ==================== OBJECT MATCHER (30 vectors) ====================
  const pureObjSpec = objectSpec({
    template: "tpl_06OBJ0001",
    event: "http.request.completed",
    shape: ["req.method", "req.path", "res.statusCode", "latency_s"],
    fields: [
      field({
        id: "fld_06OBJ0001",
        name: "http_method",
        from: { path: "req.method" },
        type: "enum",
        semantic: "http.method",
        transforms: [
          { op: "lower" },
          { op: "enum_map", map: { get: "GET", post: "POST", put: "PUT", delete: "DELETE" }, default: "OTHER" },
        ],
      }),
      field({ id: "fld_06OBJ0002", name: "url_path", from: { path: "req.path" }, type: "string", semantic: "url.path" }),
      field({ id: "fld_06OBJ0003", name: "status_code", from: { path: "res.statusCode" }, type: "int", semantic: "http.status" }),
      field({
        id: "fld_06OBJ0004",
        name: "duration_ms",
        from: { path: "latency_s" },
        type: "float",
        semantic: "duration",
        unit: "ms",
        transforms: [{ op: "unit", from: "s", to: "ms" }],
      }),
    ],
    sampleObject: { req: { method: "post", path: "/v1/orders" }, res: { statusCode: 201 }, latency_s: 0.145 },
    sampleExpect: { http_method: "POST", url_path: "/v1/orders", status_code: 201, duration_ms: 0.145 * 1000 },
  });

  const objWithMsgSpec = objectSpec({
    template: "tpl_06OBJ0002",
    event: "http.request.completed",
    source: {
      kind: "callsite",
      repo: "github.com/acme/shop",
      path: "src/http/middleware.ts",
      line: 88,
      symbol: "logRequest",
      logger: "pino.info",
      valid_from_commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    },
    shape: ["msg", "req.method", "res.statusCode"],
    message: {
      path: "msg",
      segments: [
        { lit: "request " },
        { hole: "req_id", class: "uuid" },
        { lit: " completed" },
      ],
    },
    fields: [
      field({ id: "fld_06OBJ0011", name: "request_id", from: { hole: "req_id" }, type: "string", semantic: "id.request" }),
      field({ id: "fld_06OBJ0012", name: "http_method", from: { path: "req.method" }, type: "string", semantic: "http.method" }),
      field({ id: "fld_06OBJ0013", name: "status_code", from: { path: "res.statusCode" }, type: "int", semantic: "http.status" }),
    ],
    sampleObject: {
      msg: "request 550e8400-e29b-41d4-a716-446655440000 completed",
      req: { method: "GET" },
      res: { statusCode: 200 },
    },
    sampleExpect: {
      request_id: "550e8400-e29b-41d4-a716-446655440000",
      http_method: "GET",
      status_code: 200,
    },
  });

  const objMsgJsonHoleSpec = objectSpec({
    template: "tpl_06OBJ0003",
    event: "worker.payload.logged",
    shape: ["msg", "worker"],
    message: {
      path: "msg",
      segments: [{ lit: "payload=" }, { hole: "payload", class: "json" }],
    },
    fields: [
      field({ id: "fld_06OBJ0021", name: "worker", from: { path: "worker" }, type: "string", semantic: "text" }),
      field({ id: "fld_06OBJ0022", name: "payload", from: { hole: "payload" }, type: "json", semantic: "unknown" }),
    ],
    sampleObject: { worker: "w1", msg: 'payload={"ok":true}' },
    sampleExpect: { worker: "w1", payload: { ok: true } },
  });

  const objOptionalPathSpec = objectSpec({
    template: "tpl_06OBJ0004",
    event: "order.checked",
    shape: ["order.id"],
    fields: [
      field({ id: "fld_06OBJ0031", name: "order_id", from: { path: "order.id" }, type: "string", semantic: "id.order" }),
      field({
        id: "fld_06OBJ0032",
        name: "discount_usd",
        from: { path: "order.discount_cents" },
        type: "float",
        semantic: "money",
        transforms: [{ op: "scale", div: 100 }],
      }),
      field({
        id: "fld_06OBJ0033",
        name: "coupon",
        from: { path: "order.coupon" },
        type: "string",
        transforms: [{ op: "lower" }],
      }),
    ],
    sampleObject: { order: { id: "ord_1", discount_cents: 500, coupon: "SAVE5" } },
    sampleExpect: { order_id: "ord_1", discount_usd: 5, coupon: "save5" },
  });

  const objJsonPathSpec = objectSpec({
    template: "tpl_06OBJ0005",
    event: "audit.metadata",
    shape: ["meta", "items"],
    fields: [
      field({ id: "fld_06OBJ0041", name: "meta", from: { path: "meta" }, type: "json" }),
      field({ id: "fld_06OBJ0042", name: "items", from: { path: "items" }, type: "json" }),
    ],
    sampleObject: { meta: { a: 1 }, items: [1, 2] },
    sampleExpect: { meta: { a: 1 }, items: [1, 2] },
  });

  const objDeepPathSpec = objectSpec({
    template: "tpl_06OBJ0006",
    event: "http.header.seen",
    shape: ["req.headers.user-agent", "a.b.c.d"],
    fields: [
      field({ id: "fld_06OBJ0051", name: "ua", from: { path: "req.headers.user-agent" }, type: "string", semantic: "user_agent" }),
      field({ id: "fld_06OBJ0052", name: "depth_val", from: { path: "a.b.c.d" }, type: "int", semantic: "count" }),
    ],
    sampleObject: { req: { headers: { "user-agent": "bind/1.0" } }, a: { b: { c: { d: 7 } } } },
    sampleExpect: { ua: "bind/1.0", depth_val: 7 },
  });

  const objAllTypesSpec = objectSpec({
    template: "tpl_06OBJ0007",
    event: "conformance.obj.types",
    shape: ["s", "i", "f", "b", "ts", "j"],
    fields: [
      field({ id: "fld_06OBJ0061", name: "s", from: { path: "s" }, type: "string" }),
      field({ id: "fld_06OBJ0062", name: "i", from: { path: "i" }, type: "int" }),
      field({ id: "fld_06OBJ0063", name: "f", from: { path: "f" }, type: "float" }),
      field({ id: "fld_06OBJ0064", name: "b", from: { path: "b" }, type: "bool" }),
      field({ id: "fld_06OBJ0065", name: "ts", from: { path: "ts" }, type: "timestamp", transforms: [{ op: "parse_time", format: "unix_ms" }] }),
      field({ id: "fld_06OBJ0066", name: "j", from: { path: "j" }, type: "json" }),
    ],
    sampleObject: { s: "hi", i: 10, f: 2.5, b: true, ts: T_BASE, j: { k: "v" } },
    sampleExpect: { s: "hi", i: 10, f: 2.5, b: true, ts: T_BASE, j: { k: "v" } },
  });

  const objPrivacySpec = objectSpec({
    template: "tpl_06OBJ0008",
    event: "user.updated",
    shape: ["email", "ip", "name", "secret"],
    fields: [
      field({ id: "fld_06OBJ0071", name: "email", from: { path: "email" }, type: "string", pii: "email", transforms: [{ op: "lower" }, { op: "hash", kind: "email" }] }),
      field({ id: "fld_06OBJ0072", name: "ip", from: { path: "ip" }, type: "string", pii: "ip", transforms: [{ op: "mask", mode: "ip_prefix" }] }),
      field({ id: "fld_06OBJ0073", name: "name", from: { path: "name" }, type: "string", pii: "name", transforms: [{ op: "mask", mode: "token", kind: "name" }] }),
      field({ id: "fld_06OBJ0074", name: "secret", from: { path: "secret" }, type: "string", pii: "secret", transforms: [{ op: "drop" }] }),
    ],
    sampleObject: { email: "Alice@Example.COM", ip: "203.0.113.42", name: "Alice", secret: "tok_1" },
    sampleExpect: { email: `<email:${hmacTag("alice@example.com")}>`, ip: "203.0.113.0/24", name: null, secret: null },
  });

  const objZeroFieldsSpec = objectSpec({
    template: "tpl_06OBJ0009",
    event: "health.ping",
    shape: ["ok", "service"],
    fields: [],
    sampleObject: { ok: true, service: "api" },
    sampleExpect: {},
  });

  vectors.push(
    vec({
      id: "vec_obj_pure_exact_shape_001",
      description: "pure object spec extracts nested keys with transforms",
      tags: ["object:pure"],
      spec: pureObjSpec,
      input: objectInput({ req: { method: "POST", path: "/v1/checkout" }, res: { statusCode: 201 }, latency_s: 0.145 }),
      expected: match({
        http_method: okEnum("POST"),
        url_path: okStr("/v1/checkout"),
        status_code: okInt("201"),
        duration_ms: okFloat(0.145 * 1000),
      }),
    }),
    vec({
      id: "vec_obj_pure_extra_keys_allowed_002",
      description: "object spec matches when input carries extra unreferenced keys beyond required shape",
      tags: ["object:pure", "ambiguity:object_subset_shape"],
      spec: pureObjSpec,
      input: objectInput({
        req: { method: "get", path: "/health", extraHeader: "ignored" },
        res: { statusCode: 200 },
        latency_s: 0.01,
        pid: 1234,
        hostname: "node-01",
      }),
      expected: match({
        http_method: okEnum("GET"),
        url_path: okStr("/health"),
        status_code: okInt("200"),
        duration_ms: okFloat(0.01 * 1000),
      }),
    }),
    vec({
      id: "vec_obj_missing_required_top_key_003",
      description: "object spec fails match when top-level required shape key is missing",
      tags: ["object:pure", "no_match"],
      spec: pureObjSpec,
      input: objectInput({ req: { method: "get", path: "/v1" }, res: { statusCode: 200 } }),
      expected: noMatch(),
    }),
    vec({
      id: "vec_obj_missing_required_nested_key_004",
      description: "object spec fails match when nested required shape key is missing",
      tags: ["object:pure", "no_match"],
      spec: pureObjSpec,
      input: objectInput({ req: { method: "get" }, res: { statusCode: 200 }, latency_s: 0.1 }),
      expected: noMatch(),
    }),
    vec({
      id: "vec_obj_intermediate_primitive_005",
      description: "object spec fails match when intermediate path node is a primitive instead of object",
      tags: ["object:pure", "no_match"],
      spec: pureObjSpec,
      input: objectInput({ req: "not-an-object", res: { statusCode: 200 }, latency_s: 0.1 }),
      expected: noMatch(),
    }),
    vec({
      id: "vec_obj_intermediate_null_006",
      description: "object spec fails match when intermediate path node is null",
      tags: ["object:pure", "no_match"],
      spec: pureObjSpec,
      input: objectInput({ req: null, res: { statusCode: 200 }, latency_s: 0.1 }),
      expected: noMatch(),
    }),
    vec({
      id: "vec_obj_intermediate_array_007",
      description: "object spec fails match when intermediate path node is an array",
      tags: ["object:pure", "no_match"],
      spec: pureObjSpec,
      input: objectInput({ req: ["get", "/v1"], res: { statusCode: 200 }, latency_s: 0.1 }),
      expected: noMatch(),
    }),
    vec({
      id: "vec_obj_deep_hyphenated_path_008",
      description: "object spec traverses 4-level nested path and hyphenated key name",
      tags: ["object:pure", "object:nested"],
      spec: objDeepPathSpec,
      input: objectInput({ req: { headers: { "user-agent": "curl/8.6.0" } }, a: { b: { c: { d: 99 } } } }),
      expected: match({ ua: okStr("curl/8.6.0"), depth_val: okInt("99") }),
    }),
    vec({
      id: "vec_obj_optional_paths_absent_missing_009",
      description: "optional object field paths absent from input yield missing status and short-circuit transforms",
      tags: ["object:pure", "missing"],
      spec: objOptionalPathSpec,
      input: objectInput({ order: { id: "ord_99" } }),
      expected: match({ order_id: okStr("ord_99"), discount_usd: missing(), coupon: missing() }),
    }),
    vec({
      id: "vec_obj_required_key_null_missing_010",
      description: "present object key with JSON null value matches shape and yields missing status",
      tags: ["object:pure", "missing"],
      spec: objOptionalPathSpec,
      input: objectInput({ order: { id: null, discount_cents: null, coupon: null } }),
      expected: match({ order_id: missing(), discount_usd: missing(), coupon: missing() }),
    }),
    vec({
      id: "vec_obj_with_message_subpattern_011",
      description: "object spec with message sub-pattern extracts both from.path and from.hole fields",
      tags: ["object:message", "hole:uuid"],
      spec: objWithMsgSpec,
      input: objectInput({
        msg: "request 01936a8b-7c4d-7e20-9a1b-3c4d5e6f7081 completed",
        req: { method: "DELETE" },
        res: { statusCode: 204 },
      }),
      expected: match({
        request_id: okStr("01936a8b-7c4d-7e20-9a1b-3c4d5e6f7081"),
        http_method: okStr("DELETE"),
        status_code: okInt("204"),
      }),
    }),
    vec({
      id: "vec_obj_with_message_text_mismatch_012",
      description: "object spec fails match when message sub-pattern does not match msg text",
      tags: ["object:message", "no_match"],
      spec: objWithMsgSpec,
      input: objectInput({ msg: "request not-a-uuid completed", req: { method: "GET" }, res: { statusCode: 200 } }),
      expected: noMatch(),
    }),
    vec({
      id: "vec_obj_with_message_non_string_number_013",
      description: "object spec fails match when message sub-pattern path holds a number",
      tags: ["object:message", "no_match"],
      spec: objWithMsgSpec,
      input: objectInput({ msg: 12345, req: { method: "GET" }, res: { statusCode: 200 } }),
      expected: noMatch(),
    }),
    vec({
      id: "vec_obj_with_message_non_string_null_014",
      description: "object spec fails match when message sub-pattern path holds null",
      tags: ["object:message", "no_match"],
      spec: objWithMsgSpec,
      input: objectInput({ msg: null, req: { method: "GET" }, res: { statusCode: 200 } }),
      expected: noMatch(),
    }),
    vec({
      id: "vec_obj_with_message_json_hole_sql_refused_015",
      description: "object spec whose message sub-pattern contains a json hole is SQL-refused",
      tags: ["object:message", "hole:json", "type:json"],
      spec: objMsgJsonHoleSpec,
      input: objectInput({ worker: "w-eu-1", msg: 'payload={"nested":[1,{"x":true}]}' }),
      expected: match({ worker: okStr("w-eu-1"), payload: okJson({ nested: [1, { x: true }] }) }),
    }),
    vec({
      id: "vec_obj_with_message_json_hole_nonmatch_sql_refused_016",
      description: "object spec with message json hole fails match on invalid JSON in msg (still SQL-refused)",
      tags: ["object:message", "hole:json", "no_match"],
      spec: objMsgJsonHoleSpec,
      input: objectInput({ worker: "w-eu-1", msg: "payload={unclosed" }),
      expected: noMatch(),
    }),
    vec({
      id: "vec_obj_from_path_json_field_sql_supported_017",
      description: "object spec reading type:json via from.path (no json hole) IS SQL-supported",
      tags: ["object:pure", "type:json", "sql:supported_json_path"],
      spec: objJsonPathSpec,
      input: objectInput({ meta: { region: "us-east", retries: 2 }, items: ["sku_1", { qty: 3 }] }),
      expected: match({ meta: okJson({ region: "us-east", retries: 2 }), items: okJson(["sku_1", { qty: 3 }]) }),
    }),
    vec({
      id: "vec_obj_all_field_types_018",
      description: "object spec extracts string, int, float, bool, timestamp, and json fields together",
      tags: ["object:pure", "type:string", "type:int", "type:float", "type:bool", "type:timestamp", "type:json"],
      spec: objAllTypesSpec,
      input: objectInput({ s: "ok", i: -42, f: 0.25, b: false, ts: T_BASE + 500, j: [1, true, null] }),
      expected: match({
        s: okStr("ok"),
        i: okInt("-42"),
        f: okFloat(0.25),
        b: okBool(false),
        ts: okTs(T_BASE + 500),
        j: okJson([1, true, null]),
      }),
    }),
    vec({
      id: "vec_obj_type_mismatch_string_for_int_019",
      description: "object field expecting int produces type_mismatch parse_error on string value without cast",
      tags: ["object:pure", "parse_error"],
      spec: pureObjSpec,
      input: objectInput({ req: { method: "get", path: "/v1" }, res: { statusCode: "200" }, latency_s: 0.5 }),
      expected: match({
        http_method: okEnum("GET"),
        url_path: okStr("/v1"),
        status_code: parseErr("type_mismatch"),
        duration_ms: okFloat(500),
      }),
    }),
    vec({
      id: "vec_obj_type_mismatch_float_for_int_020",
      description: "object field expecting int rejects fractional float 3.5 with type_mismatch",
      tags: ["object:pure", "parse_error"],
      spec: pureObjSpec,
      input: objectInput({ req: { method: "get", path: "/v1" }, res: { statusCode: 3.5 }, latency_s: 0.5 }),
      expected: match({
        http_method: okEnum("GET"),
        url_path: okStr("/v1"),
        status_code: parseErr("type_mismatch"),
        duration_ms: okFloat(500),
      }),
    }),
    vec({
      id: "vec_obj_type_mismatch_object_for_string_021",
      description: "object field expecting string rejects nested object value with type_mismatch",
      tags: ["object:pure", "parse_error"],
      spec: pureObjSpec,
      input: objectInput({ req: { method: "get", path: { raw: "/v1" } }, res: { statusCode: 200 }, latency_s: 0.5 }),
      expected: match({
        http_method: okEnum("GET"),
        url_path: parseErr("type_mismatch"),
        status_code: okInt("200"),
        duration_ms: okFloat(500),
      }),
    }),
    vec({
      id: "vec_obj_type_mismatch_string_for_bool_022",
      description: "object field expecting bool rejects string 'true' without cast transform",
      tags: ["object:pure", "parse_error"],
      spec: objAllTypesSpec,
      input: objectInput({ s: "ok", i: 1, f: 1.0, b: "true", ts: T_BASE, j: {} }),
      expected: match({
        s: okStr("ok"),
        i: okInt("1"),
        f: okFloat(1),
        b: parseErr("type_mismatch"),
        ts: okTs(T_BASE),
        j: okJson({}),
      }),
    }),
    vec({
      id: "vec_obj_privacy_transforms_023",
      description: "object spec applies hash, ip_prefix mask, token mask, and drop across fields",
      tags: ["object:pure", "transform:hash", "transform:mask", "transform:drop"],
      spec: objPrivacySpec,
      input: objectInput({ email: "Bob@Example.COM", ip: "2001:db8::1", name: "Bob", secret: "sk_live_123" }),
      expected: match({
        email: okStr(`<email:${hmacTag("bob@example.com")}>`),
        ip: okStr("2001:db8::/48"),
        name: redacted("<name>"),
        secret: dropped(),
      }),
    }),
    vec({
      id: "vec_obj_redaction_tokens_in_leaves_024",
      description: "pre-scrubbed redaction tokens inside object string leaves follow pseudonym and mask rules",
      tags: ["object:pure", "redaction:mask", "redaction:pseudonym"],
      spec: objAllTypesSpec,
      input: objectInput({
        s: "<email:9f2c41d07a3b55e1>",
        i: "<card>",
        f: "<email:9f2c41d07a3b55e1>",
        b: "<secret:kv>",
        ts: "<card>",
        j: "<secret:jwt>",
      }),
      expected: match({
        s: okStr("<email:9f2c41d07a3b55e1>"),
        i: redacted("<card>"),
        f: redacted("<email:9f2c41d07a3b55e1>"),
        b: redacted("<secret:kv>"),
        ts: redacted("<card>"),
        j: redacted("<secret:jwt>"),
      }),
    }),
    vec({
      id: "vec_obj_zero_fields_match_025",
      description: "zero-field pure object spec matches required shape and returns empty fields map",
      tags: ["object:pure", "boundary:zero_fields"],
      spec: objZeroFieldsSpec,
      input: objectInput({ ok: true, service: "gateway" }),
      expected: match({}),
    }),
    vec({
      id: "vec_obj_zero_fields_mismatch_026",
      description: "zero-field pure object spec rejects object missing required shape key",
      tags: ["object:pure", "boundary:zero_fields", "no_match"],
      spec: objZeroFieldsSpec,
      input: objectInput({ ok: true }),
      expected: noMatch(),
    }),
    vec({
      id: "vec_obj_scale_ieee754_027",
      description: "object spec scale div:100 pins exact IEEE-754 double 1999/100",
      tags: ["object:pure", "transform:scale", "ieee754"],
      spec: objOptionalPathSpec,
      input: objectInput({ order: { id: "ord_2", discount_cents: 1999, coupon: "VIP" } }),
      expected: match({
        order_id: okStr("ord_2"),
        discount_usd: okFloatHex("4033fd70a3d70a3d"),
        coupon: okStr("vip"),
      }),
    }),
    vec({
      id: "vec_obj_cast_string_int64_028",
      description: "object spec uses cast(to:int) to parse string-encoded 64-bit integer without JSON precision loss",
      tags: ["object:pure", "transform:cast", "boundary:int64"],
      spec: objectSpec({
        template: "tpl_06OBJ0028",
        event: "ledger.entry",
        shape: ["seq"],
        fields: [
          field({ id: "fld_06OBJ0081", name: "seq", from: { path: "seq" }, type: "int", transforms: [{ op: "cast", to: "int" }] }),
        ],
        sampleObject: { seq: "42" },
        sampleExpect: { seq: 42 },
      }),
      input: objectInput({ seq: "9223372036854775807" }),
      expected: match({ seq: okInt("9223372036854775807") }),
    }),
    vec({
      id: "vec_obj_message_redaction_token_in_uuid_hole_029",
      description: "object message sub-pattern accepts mask token inside uuid hole",
      tags: ["object:message", "hole:uuid", "redaction:mask"],
      spec: objWithMsgSpec,
      input: objectInput({ msg: "request <secret:kv> completed", req: { method: "GET" }, res: { statusCode: 200 } }),
      expected: match({
        request_id: redacted("<secret:kv>"),
        http_method: okStr("GET"),
        status_code: okInt("200"),
      }),
    }),
    vec({
      id: "vec_obj_unicode_values_030",
      description: "object spec preserves UTF-8 emoji, combining marks, and U+00A0 in string values",
      tags: ["object:pure", "unicode:nbsp", "unicode:combining", "unicode:emoji"],
      spec: objOptionalPathSpec,
      input: objectInput({ order: { id: "ord_cafe\u0301\u00a0\u{1F680}", discount_cents: 100, coupon: "OK" } }),
      expected: match({
        order_id: okStr("ord_cafe\u0301\u00a0\u{1F680}"),
        discount_usd: okFloat(1),
        coupon: okStr("ok"),
      }),
    })
  );

  // ==================== ARGS MATCHER (25 vectors) ====================
  const orderArgsSpec = argsSpec({
    template: "tpl_06ARG0001",
    event: "order.paid",
    source: { kind: "sdk_template", repo: "github.com/acme/shop", path: "src/orders/checkout.ts", line: 142, logger: "bind.log" },
    strings: ["", " paid ", " in ", "ms"],
    fields: [
      field({ id: "fld_06ARG0001", name: "order_id", from: { arg: 0 }, type: "string", semantic: "id.order", entity: "order" }),
      field({ id: "fld_06ARG0002", name: "amount_usd", from: { arg: 1 }, type: "float", semantic: "money", unit: "USD", transforms: [{ op: "scale", div: 100 }] }),
      field({ id: "fld_06ARG0003", name: "duration_ms", from: { arg: 2 }, type: "int", semantic: "duration", unit: "ms" }),
    ],
    sampleArgs: ["ord_8f2a", 1999, 212],
    sampleExpect: { order_id: "ord_8f2a", amount_usd: 19.99, duration_ms: 212 },
  });

  const adjacentEmptyArgsSpec = argsSpec({
    template: "tpl_06ARG0002",
    event: "sdk.adjacent",
    strings: ["", "", ""],
    fields: [
      field({ id: "fld_06ARG0011", name: "first", from: { arg: 0 }, type: "string" }),
      field({ id: "fld_06ARG0012", name: "second", from: { arg: 1 }, type: "int" }),
    ],
    sampleArgs: ["a", 1],
    sampleExpect: { first: "a", second: 1 },
  });

  const zeroArgSpec = argsSpec({
    template: "tpl_06ARG0003",
    event: "service.started",
    strings: ["server ready"],
    fields: [],
    sampleArgs: [],
    sampleExpect: {},
  });

  const argsAllTypesSpec = argsSpec({
    template: "tpl_06ARG0004",
    event: "conformance.args.types",
    strings: ["s=", " i=", " f=", " b=", " ts=", " j=", ""],
    fields: [
      field({ id: "fld_06ARG0021", name: "s", from: { arg: 0 }, type: "string" }),
      field({ id: "fld_06ARG0022", name: "i", from: { arg: 1 }, type: "int" }),
      field({ id: "fld_06ARG0023", name: "f", from: { arg: 2 }, type: "float" }),
      field({ id: "fld_06ARG0024", name: "b", from: { arg: 3 }, type: "bool" }),
      field({ id: "fld_06ARG0025", name: "ts", from: { arg: 4 }, type: "timestamp", transforms: [{ op: "parse_time", format: "unix_s" }] }),
      field({ id: "fld_06ARG0026", name: "j", from: { arg: 5 }, type: "json" }),
    ],
    sampleArgs: ["ok", 7, 1.5, true, 1795701600, { a: [1, 2] }],
    sampleExpect: { s: "ok", i: 7, f: 1.5, b: true, ts: T_BASE, j: { a: [1, 2] } },
  });

  const argsPrivacySpec = argsSpec({
    template: "tpl_06ARG0005",
    event: "user.login",
    strings: ["email=", " ip=", " name=", " token=", ""],
    fields: [
      field({ id: "fld_06ARG0031", name: "email", from: { arg: 0 }, type: "string", pii: "email", transforms: [{ op: "lower" }, { op: "hash", kind: "email" }] }),
      field({ id: "fld_06ARG0032", name: "ip", from: { arg: 1 }, type: "string", pii: "ip", transforms: [{ op: "mask", mode: "ip_prefix" }] }),
      field({ id: "fld_06ARG0033", name: "name", from: { arg: 2 }, type: "string", pii: "name", transforms: [{ op: "mask", mode: "token", kind: "name" }] }),
      field({ id: "fld_06ARG0034", name: "token", from: { arg: 3 }, type: "string", pii: "secret", transforms: [{ op: "drop" }] }),
    ],
    sampleArgs: ["Alice@Example.COM", "203.0.113.42", "Alice", "tok_abc"],
    sampleExpect: { email: `<email:${hmacTag("alice@example.com")}>`, ip: "203.0.113.0/24", name: null, token: null },
  });

  const argsSubsetBindSpec = argsSpec({
    template: "tpl_06ARG0006",
    event: "job.step",
    strings: ["job ", " step ", " took ", "s"],
    fields: [
      field({ id: "fld_06ARG0041", name: "job_id", from: { arg: 0 }, type: "string" }),
      field({ id: "fld_06ARG0042", name: "duration_ms", from: { arg: 2 }, type: "float", unit: "ms", transforms: [{ op: "unit", from: "s", to: "ms" }] }),
    ],
    sampleArgs: ["j1", "ignored_middle", 1.25],
    sampleExpect: { job_id: "j1", duration_ms: 1250 },
  });

  vectors.push(
    vec({
      id: "vec_args_order_paid_canonical_001",
      description: "args matcher extracts canonical order.paid SDK template with exact IEEE-754 scale",
      tags: ["args:basic", "transform:scale", "ieee754"],
      spec: orderArgsSpec,
      input: argsInput(["", " paid ", " in ", "ms"], ["ord_8f2a", 1999, 212]),
      expected: match({
        order_id: okStr("ord_8f2a"),
        amount_usd: okFloatHex("4033fd70a3d70a3d"),
        duration_ms: okInt("212"),
      }),
    }),
    vec({
      id: "vec_args_adjacent_empty_strings_002",
      description: "args matcher permits adjacent empty string literals ['', '', '']",
      tags: ["args:empty_strings"],
      spec: adjacentEmptyArgsSpec,
      input: argsInput(["", "", ""], ["hello", 99]),
      expected: match({ first: okStr("hello"), second: okInt("99") }),
    }),
    vec({
      id: "vec_args_zero_args_match_003",
      description: "zero-argument SDK template matches empty args array",
      tags: ["args:zero_args", "boundary:zero_fields"],
      spec: zeroArgSpec,
      input: argsInput(["server ready"], []),
      expected: match({}),
    }),
    vec({
      id: "vec_args_reject_strings_text_mismatch_004",
      description: "args matcher rejects differing literal template string",
      tags: ["args:basic", "no_match"],
      spec: orderArgsSpec,
      input: argsInput(["", " refunded ", " in ", "ms"], ["ord_8f2a", 1999, 212]),
      expected: noMatch(),
    }),
    vec({
      id: "vec_args_reject_strings_length_mismatch_005",
      description: "args matcher rejects strings array with wrong length",
      tags: ["args:basic", "no_match"],
      spec: orderArgsSpec,
      input: argsInput(["", " paid ", "ms"], ["ord_8f2a", 1999]),
      expected: noMatch(),
    }),
    vec({
      id: "vec_args_reject_too_few_args_006",
      description: "args matcher rejects args.length < strings.length - 1",
      tags: ["args:arity", "no_match"],
      spec: orderArgsSpec,
      input: argsInput(["", " paid ", " in ", "ms"], ["ord_8f2a", 1999]),
      expected: noMatch(),
    }),
    vec({
      id: "vec_args_reject_too_many_args_007",
      description: "args matcher rejects args.length > strings.length - 1",
      tags: ["args:arity", "no_match"],
      spec: orderArgsSpec,
      input: argsInput(["", " paid ", " in ", "ms"], ["ord_8f2a", 1999, 212, "extra"]),
      expected: noMatch(),
    }),
    vec({
      id: "vec_args_zero_args_reject_nonempty_args_008",
      description: "zero-argument template rejects non-empty args array",
      tags: ["args:arity", "no_match"],
      spec: zeroArgSpec,
      input: argsInput(["server ready"], ["unexpected"]),
      expected: noMatch(),
    }),
    vec({
      id: "vec_args_all_field_types_sql_supported_009",
      description: "args matcher extracts string, int, float, bool, timestamp, and json (SQL-supported)",
      tags: ["args:types", "type:json", "sql:supported_json_arg"],
      spec: argsAllTypesSpec,
      input: argsInput(
        ["s=", " i=", " f=", " b=", " ts=", " j=", ""],
        ["hi", -12, 3.25, false, "1795701600.5", { ok: true, n: [1, 2] }]
      ),
      expected: match({
        s: okStr("hi"),
        i: okInt("-12"),
        f: okFloat(3.25),
        b: okBool(false),
        ts: okTs(T_BASE + 500),
        j: okJson({ ok: true, n: [1, 2] }),
      }),
    }),
    vec({
      id: "vec_args_null_values_yield_missing_010",
      description: "null args elements yield missing status and short-circuit transforms",
      tags: ["args:missing", "missing"],
      spec: orderArgsSpec,
      input: argsInput(["", " paid ", " in ", "ms"], [null, null, null]),
      expected: match({
        order_id: missing(),
        amount_usd: missing(),
        duration_ms: missing(),
      }),
    }),
    vec({
      id: "vec_args_type_mismatch_string_for_int_011",
      description: "args field expecting int reports type_mismatch on string arg without cast",
      tags: ["args:error", "parse_error"],
      spec: orderArgsSpec,
      input: argsInput(["", " paid ", " in ", "ms"], ["ord_1", 100, "two-hundred"]),
      expected: match({
        order_id: okStr("ord_1"),
        amount_usd: okFloat(1),
        duration_ms: parseErr("type_mismatch"),
      }),
    }),
    vec({
      id: "vec_args_type_mismatch_float_for_int_012",
      description: "args field expecting int reports type_mismatch on non-integer float 2.5",
      tags: ["args:error", "parse_error"],
      spec: orderArgsSpec,
      input: argsInput(["", " paid ", " in ", "ms"], ["ord_1", 100, 2.5]),
      expected: match({
        order_id: okStr("ord_1"),
        amount_usd: okFloat(1),
        duration_ms: parseErr("type_mismatch"),
      }),
    }),
    vec({
      id: "vec_args_type_mismatch_object_for_string_013",
      description: "args field expecting string reports type_mismatch on object arg",
      tags: ["args:error", "parse_error"],
      spec: orderArgsSpec,
      input: argsInput(["", " paid ", " in ", "ms"], [{ id: "ord_1" }, 100, 50]),
      expected: match({
        order_id: parseErr("type_mismatch"),
        amount_usd: okFloat(1),
        duration_ms: okInt("50"),
      }),
    }),
    vec({
      id: "vec_args_scale_non_numeric_error_014",
      description: "args scale transform on non-numeric string reports type_mismatch",
      tags: ["args:error", "transform:scale", "parse_error"],
      spec: orderArgsSpec,
      input: argsInput(["", " paid ", " in ", "ms"], ["ord_1", "nineteen", 50]),
      expected: match({
        order_id: okStr("ord_1"),
        amount_usd: parseErr("type_mismatch"),
        duration_ms: okInt("50"),
      }),
    }),
    vec({
      id: "vec_args_redaction_mask_and_pseudonym_015",
      description: "args matcher honors mask tokens and pseudonym tokens across field types",
      tags: ["args:redaction", "redaction:mask", "redaction:pseudonym"],
      spec: orderArgsSpec,
      input: argsInput(["", " paid ", " in ", "ms"], ["<email:9f2c41d07a3b55e1>", "<card>", "<email:9f2c41d07a3b55e1>"]),
      expected: match({
        order_id: okStr("<email:9f2c41d07a3b55e1>"),
        amount_usd: redacted("<card>"),
        duration_ms: redacted("<email:9f2c41d07a3b55e1>"),
      }),
    }),
    vec({
      id: "vec_args_privacy_transforms_016",
      description: "args matcher applies lower+hash, ip_prefix, token mask, and drop",
      tags: ["args:privacy", "transform:hash", "transform:mask", "transform:drop"],
      spec: argsPrivacySpec,
      input: argsInput(
        ["email=", " ip=", " name=", " token=", ""],
        ["Carol@Example.COM", "10.0.5.99", "Carol", "ghp_secret"]
      ),
      expected: match({
        email: okStr(`<email:${hmacTag("carol@example.com")}>`),
        ip: okStr("10.0.5.0/24"),
        name: redacted("<name>"),
        token: dropped(),
      }),
    }),
    vec({
      id: "vec_args_subset_bindings_skip_middle_arg_017",
      description: "args spec may bind a subset of argument indices (0 and 2, ignoring 1)",
      tags: ["args:subset", "transform:unit"],
      spec: argsSubsetBindSpec,
      input: argsInput(["job ", " step ", " took ", "s"], ["job_77", { debug: true }, 0.25]),
      expected: match({
        job_id: okStr("job_77"),
        duration_ms: okFloat(250),
      }),
    }),
    vec({
      id: "vec_args_cast_string_to_int64_018",
      description: "args spec casts string-encoded INT64_MIN to int without precision loss",
      tags: ["args:cast", "transform:cast", "boundary:int64"],
      spec: argsSpec({
        template: "tpl_06ARG0018",
        event: "counter.delta",
        strings: ["delta=", ""],
        fields: [
          field({ id: "fld_06ARG0051", name: "delta", from: { arg: 0 }, type: "int", transforms: [{ op: "cast", to: "int" }] }),
        ],
        sampleArgs: ["-10"],
        sampleExpect: { delta: -10 },
      }),
      input: argsInput(["delta=", ""], ["-9223372036854775808"]),
      expected: match({ delta: okInt("-9223372036854775808") }),
    }),
    vec({
      id: "vec_args_cast_string_to_bool_019",
      description: "args spec casts string '0' to boolean false",
      tags: ["args:cast", "transform:cast", "type:bool"],
      spec: argsSpec({
        template: "tpl_06ARG0019",
        event: "flag.eval",
        strings: ["enabled=", ""],
        fields: [
          field({ id: "fld_06ARG0052", name: "enabled", from: { arg: 0 }, type: "bool", transforms: [{ op: "cast", to: "bool" }] }),
        ],
        sampleArgs: ["1"],
        sampleExpect: { enabled: true },
      }),
      input: argsInput(["enabled=", ""], ["0"]),
      expected: match({ enabled: okBool(false) }),
    }),
    vec({
      id: "vec_args_parse_time_iso_020",
      description: "args spec parses ISO 8601 string argument into timestamp ms",
      tags: ["args:time", "transform:parse_time", "type:timestamp"],
      spec: argsSpec({
        template: "tpl_06ARG0020",
        event: "job.scheduled",
        strings: ["run_at=", ""],
        fields: [
          field({ id: "fld_06ARG0053", name: "run_at", from: { arg: 0 }, type: "timestamp", transforms: [{ op: "parse_time", format: "iso8601" }] }),
        ],
        sampleArgs: ["2026-11-26T14:00:00Z"],
        sampleExpect: { run_at: T_BASE },
      }),
      input: argsInput(["run_at=", ""], ["2026-11-26T09:00:00.250-05:00"]),
      expected: match({ run_at: okTs(T_BASE + 250) }),
    }),
    vec({
      id: "vec_args_parse_time_invalid_021",
      description: "args spec reports invalid_time on malformed timestamp arg",
      tags: ["args:time", "transform:parse_time", "parse_error"],
      spec: argsAllTypesSpec,
      input: argsInput(["s=", " i=", " f=", " b=", " ts=", " j=", ""], ["a", 1, 1.0, true, "not-unix", {}]),
      expected: match({
        s: okStr("a"),
        i: okInt("1"),
        f: okFloat(1),
        b: okBool(true),
        ts: parseErr("invalid_time"),
        j: okJson({}),
      }),
    }),
    vec({
      id: "vec_args_unicode_preserved_022",
      description: "args matcher preserves U+00A0, U+3000, combining marks, and ZWJ emoji verbatim",
      tags: ["args:unicode", "unicode:nbsp", "unicode:ideographic_space", "unicode:combining", "unicode:emoji"],
      spec: adjacentEmptyArgsSpec,
      input: argsInput(["", "", ""], ["cafe\u0301\u00a0\u3000\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}", 7]),
      expected: match({
        first: okStr("cafe\u0301\u00a0\u3000\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}"),
        second: okInt("7"),
      }),
    }),
    vec({
      id: "vec_args_cast_json_string_023",
      description: "args spec parses JSON string arg via cast(to:json)",
      tags: ["args:cast", "transform:cast", "type:json"],
      spec: argsSpec({
        template: "tpl_06ARG0023",
        event: "webhook.recv",
        strings: ["body=", ""],
        fields: [
          field({ id: "fld_06ARG0054", name: "body", from: { arg: 0 }, type: "json", transforms: [{ op: "cast", to: "json" }] }),
        ],
        sampleArgs: ['{"ev":"paid"}'],
        sampleExpect: { body: { ev: "paid" } },
      }),
      input: argsInput(["body=", ""], ['{"ev":"refund","cents":500}']),
      expected: match({ body: okJson({ ev: "refund", cents: 500 }) }),
    }),
    vec({
      id: "vec_args_string_with_spaces_and_newlines_024",
      description: "args matcher captures strings containing spaces and newlines without scanning",
      tags: ["args:basic", "boundary:multiline"],
      spec: adjacentEmptyArgsSpec,
      input: argsInput(["", "", ""], ["line one\nline two\ttab", 0]),
      expected: match({ first: okStr("line one\nline two\ttab"), second: okInt("0") }),
    }),
    vec({
      id: "vec_args_negative_scale_025",
      description: "args matcher handles negative integer in scale div:100 with exact IEEE-754 bits",
      tags: ["args:basic", "transform:scale", "ieee754", "boundary:negative"],
      spec: orderArgsSpec,
      input: argsInput(["", " paid ", " in ", "ms"], ["ord_neg", -1999, 5]),
      expected: match({
        order_id: okStr("ord_neg"),
        amount_usd: okFloatHex("c033fd70a3d70a3d"),
        duration_ms: okInt("5"),
      }),
    })
  );

  return {
    suite: "06-matchers-object-and-args",
    description: "Golden conformance vectors covering object (pure, nested, optional paths, message sub-patterns, SQL-refused message json holes) and args matchers.",
    vectors,
  };
}
