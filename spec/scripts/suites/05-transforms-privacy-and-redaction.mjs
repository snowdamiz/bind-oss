import {
  argsInput,
  argsSpec,
  DEFAULT_CONTEXT,
  dropped,
  field,
  hmacTag,
  match,
  noMatch,
  objectInput,
  objectSpec,
  okInt,
  okStr,
  parseErr,
  redacted,
  textInput,
  textSpec,
  vec,
} from "../lib/vector-builders.mjs";

export function buildSuite05() {
  const vectors = [];

  // ---- HASH (8 vectors) ----
  const emailHashSpec = textSpec({
    template: "tpl_05HASH001",
    event: "test.transform.hash",
    segments: [{ lit: "email=" }, { hole: "e", class: "word" }],
    fields: [
      field({
        id: "fld_05HASH0001",
        name: "email",
        from: { hole: "e" },
        type: "string",
        semantic: "email",
        pii: "email",
        transforms: [{ op: "hash", kind: "email" }],
      }),
    ],
    sampleLine: "email=alice@example.com",
    sampleExpect: { email: `<email:${hmacTag("alice@example.com")}>` },
  });

  const lowerEmailHashSpec = textSpec({
    template: "tpl_05HASH002",
    event: "test.transform.lower_hash",
    segments: [{ lit: "email=" }, { hole: "e", class: "word" }],
    fields: [
      field({
        id: "fld_05HASH0002",
        name: "email",
        from: { hole: "e" },
        type: "string",
        semantic: "email",
        pii: "email",
        transforms: [{ op: "lower" }, { op: "hash", kind: "email" }],
      }),
    ],
    sampleLine: "email=Alice@Example.COM",
    sampleExpect: { email: `<email:${hmacTag("alice@example.com")}>` },
  });

  const phoneHashSpec = textSpec({
    template: "tpl_05HASH003",
    event: "test.transform.hash_phone",
    segments: [{ lit: "phone=" }, { hole: "p", class: "word" }],
    fields: [
      field({
        id: "fld_05HASH0003",
        name: "phone",
        from: { hole: "p" },
        type: "string",
        semantic: "unknown",
        pii: "phone",
        transforms: [{ op: "hash", kind: "phone" }],
      }),
    ],
    sampleLine: "phone=+14155550199",
    sampleExpect: { phone: `<phone:${hmacTag("+14155550199")}>` },
  });

  const hashDefaultKindPiiSpec = textSpec({
    template: "tpl_05HASH004",
    event: "test.transform.hash_default_pii",
    segments: [{ lit: "email=" }, { hole: "e", class: "word" }],
    fields: [
      field({
        id: "fld_05HASH0004",
        name: "email",
        from: { hole: "e" },
        type: "string",
        semantic: "email",
        pii: "email",
        transforms: [{ op: "hash" }],
      }),
    ],
    sampleLine: "email=bob@example.com",
    sampleExpect: { email: `<email:${hmacTag("bob@example.com")}>` },
  });

  const hashDefaultKindNoneSpec = textSpec({
    template: "tpl_05HASH005",
    event: "test.transform.hash_default_none",
    segments: [{ lit: "uid=" }, { hole: "u", class: "word" }],
    fields: [
      field({
        id: "fld_05HASH0005",
        name: "uid",
        from: { hole: "u" },
        type: "string",
        semantic: "id.user",
        pii: "none",
        transforms: [{ op: "hash" }],
      }),
    ],
    sampleLine: "uid=usr_123",
    sampleExpect: { uid: `<hash:${hmacTag("usr_123")}>` },
  });

  const customKeys = {
    edge: "alt-edge-key-99",
    server: "alt-server-key-99",
  };
  const customHashSpec = textSpec({
    template: "tpl_05HASH006",
    event: "test.transform.hash_custom_key",
    segments: [{ lit: "email=" }, { hole: "e", class: "word" }],
    fields: [
      field({
        id: "fld_05HASH0006",
        name: "email",
        from: { hole: "e" },
        type: "string",
        semantic: "email",
        pii: "email",
        transforms: [{ op: "hash", kind: "email" }],
      }),
    ],
    sampleLine: "email=alice@example.com",
    sampleExpect: { email: `<email:${hmacTag("alice@example.com", customKeys)}>` },
  });

  vectors.push(
    vec({
      id: "vec_tr_hash_email_001",
      description: "hash transform computes keyed nested HMAC-SHA256 pseudonym token",
      tags: ["transform:hash", "ambiguity:hmac_inner_encoding"],
      spec: emailHashSpec,
      input: textInput("email=alice@example.com"),
      expected: match({ email: okStr(`<email:${hmacTag("alice@example.com")}>`) }),
    }),
    vec({
      id: "vec_tr_hash_lower_chained_002",
      description: "lower + hash produces identical pseudonym tag for mixed-case email",
      tags: ["transform:lower", "transform:hash", "transform:chain", "ambiguity:hmac_inner_encoding"],
      spec: lowerEmailHashSpec,
      input: textInput("email=Alice@Example.COM"),
      expected: match({ email: okStr(`<email:${hmacTag("alice@example.com")}>`) }),
    }),
    vec({
      id: "vec_tr_hash_phone_003",
      description: "hash transform with kind:phone tags E.164 phone number",
      tags: ["transform:hash"],
      spec: phoneHashSpec,
      input: textInput("phone=+14155550199"),
      expected: match({ phone: okStr(`<phone:${hmacTag("+14155550199")}>`) }),
    }),
    vec({
      id: "vec_tr_hash_omitted_kind_uses_pii_004",
      description: "hash transform without explicit kind uses field pii class as token kind",
      tags: ["transform:hash", "ambiguity:hash_default_kind"],
      spec: hashDefaultKindPiiSpec,
      input: textInput("email=bob@example.com"),
      expected: match({ email: okStr(`<email:${hmacTag("bob@example.com")}>`) }),
    }),
    vec({
      id: "vec_tr_hash_omitted_kind_pii_none_005",
      description: "hash transform without kind on pii:none falls back to <hash:tag>",
      tags: ["transform:hash", "ambiguity:hash_default_kind"],
      spec: hashDefaultKindNoneSpec,
      input: textInput("uid=usr_123"),
      expected: match({ uid: okStr(`<hash:${hmacTag("usr_123")}>`) }),
    }),
    vec({
      id: "vec_tr_hash_custom_project_keys_006",
      description: "hash transform tag changes deterministically with project HMAC keys",
      tags: ["transform:hash"],
      context: { hmac_keys: customKeys },
      spec: customHashSpec,
      input: textInput("email=alice@example.com"),
      expected: match({ email: okStr(`<email:${hmacTag("alice@example.com", customKeys)}>`) }),
    }),
    vec({
      id: "vec_tr_hash_already_tokenized_passthrough_007",
      description: "hash transform leaves pre-existing pseudonym token unchanged (no double hashing)",
      tags: ["transform:hash", "redaction:pseudonym"],
      spec: emailHashSpec,
      input: textInput("email=<email:9f2c41d07a3b55e1>"),
      expected: match({ email: okStr("<email:9f2c41d07a3b55e1>") }),
    }),
    vec({
      id: "vec_tr_hash_pre_masked_token_stays_redacted_008",
      description: "pre-existing mask token <card> short-circuits hash transform and stays redacted",
      tags: ["transform:hash", "redaction:mask"],
      spec: emailHashSpec,
      input: textInput("email=<card>"),
      expected: match({ email: redacted("<card>") }),
    })
  );

  // ---- MASK (12 vectors: token mode + ip_prefix IPv4/IPv6 + error) ----
  const maskTokenNameSpec = textSpec({
    template: "tpl_05MASK001",
    event: "test.transform.mask_token",
    segments: [{ lit: "name=" }, { hole: "n", class: "quoted" }],
    fields: [
      field({
        id: "fld_05MASK0001",
        name: "customer_name",
        from: { hole: "n" },
        type: "string",
        pii: "name",
        transforms: [{ op: "mask", mode: "token", kind: "name" }],
      }),
    ],
    sampleLine: 'name="Alice Smith"',
    sampleExpect: { customer_name: null },
  });

  const maskDefaultModeSpec = textSpec({
    template: "tpl_05MASK002",
    event: "test.transform.mask_default_mode",
    segments: [{ lit: "addr=" }, { hole: "a", class: "quoted" }],
    fields: [
      field({
        id: "fld_05MASK0002",
        name: "address",
        from: { hole: "a" },
        type: "string",
        pii: "address",
        transforms: [{ op: "mask", kind: "address" }],
      }),
    ],
    sampleLine: 'addr="123 Main St"',
    sampleExpect: { address: null },
  });

  const maskDefaultKindSpec = textSpec({
    template: "tpl_05MASK003",
    event: "test.transform.mask_default_kind",
    segments: [{ lit: "v=" }, { hole: "v", class: "word" }],
    fields: [
      field({
        id: "fld_05MASK0003",
        name: "v",
        from: { hole: "v" },
        type: "string",
        transforms: [{ op: "mask" }],
      }),
    ],
    sampleLine: "v=sensitive",
    sampleExpect: { v: null },
  });

  const maskIpSpec = textSpec({
    template: "tpl_05MASK004",
    event: "test.transform.mask_ip",
    segments: [{ lit: "ip=" }, { hole: "ip", class: "ip" }],
    fields: [
      field({
        id: "fld_05MASK0004",
        name: "client_ip",
        from: { hole: "ip" },
        type: "string",
        semantic: "ip",
        pii: "ip",
        transforms: [{ op: "mask", mode: "ip_prefix" }],
      }),
    ],
    sampleLine: "ip=203.0.113.42",
    sampleExpect: { client_ip: "203.0.113.0/24" },
  });

  const maskIpWordSpec = textSpec({
    template: "tpl_05MASK005",
    event: "test.transform.mask_ip_word",
    segments: [{ lit: "ip=" }, { hole: "ip", class: "word" }],
    fields: [
      field({
        id: "fld_05MASK0005",
        name: "client_ip",
        from: { hole: "ip" },
        type: "string",
        semantic: "ip",
        pii: "ip",
        transforms: [{ op: "mask", mode: "ip_prefix" }],
      }),
    ],
    sampleLine: "ip=10.20.30.40",
    sampleExpect: { client_ip: "10.20.30.0/24" },
  });

  vectors.push(
    vec({
      id: "vec_tr_mask_token_name_001",
      description: "mask mode:token kind:name yields redacted status with <name> marker",
      tags: ["transform:mask", "mask:token", "redacted", "ambiguity:mask_token_storage"],
      spec: maskTokenNameSpec,
      input: textInput('name="Alice Smith"'),
      expected: match({ customer_name: redacted("<name>") }),
    }),
    vec({
      id: "vec_tr_mask_default_mode_address_002",
      description: "mask with omitted mode defaults to token mode",
      tags: ["transform:mask", "mask:token", "redacted", "ambiguity:mask_token_storage"],
      spec: maskDefaultModeSpec,
      input: textInput('addr="742 Evergreen Terrace"'),
      expected: match({ address: redacted("<address>") }),
    }),
    vec({
      id: "vec_tr_mask_default_kind_003",
      description: "mask with omitted mode and kind yields <redacted> marker",
      tags: ["transform:mask", "mask:token", "redacted", "ambiguity:mask_token_storage"],
      spec: maskDefaultKindSpec,
      input: textInput("v=secret_value"),
      expected: match({ v: redacted("<redacted>") }),
    }),
    vec({
      id: "vec_tr_mask_ip_prefix_v4_doc_004",
      description: "mask mode:ip_prefix truncates IPv4 to /24 prefix",
      tags: ["transform:mask", "mask:ip_prefix", "ip:v4"],
      spec: maskIpSpec,
      input: textInput("ip=203.0.113.42"),
      expected: match({ client_ip: okStr("203.0.113.0/24") }),
    }),
    vec({
      id: "vec_tr_mask_ip_prefix_v4_255_005",
      description: "mask mode:ip_prefix zeroes last octet of 10.20.30.255",
      tags: ["transform:mask", "mask:ip_prefix", "ip:v4"],
      spec: maskIpSpec,
      input: textInput("ip=10.20.30.255"),
      expected: match({ client_ip: okStr("10.20.30.0/24") }),
    }),
    vec({
      id: "vec_tr_mask_ip_prefix_v4_zero_006",
      description: "mask mode:ip_prefix masks 0.0.0.1 to 0.0.0.0/24",
      tags: ["transform:mask", "mask:ip_prefix", "ip:v4"],
      spec: maskIpSpec,
      input: textInput("ip=0.0.0.1"),
      expected: match({ client_ip: okStr("0.0.0.0/24") }),
    }),
    vec({
      id: "vec_tr_mask_ip_prefix_v6_full_007",
      description: "mask mode:ip_prefix truncates full IPv6 to canonical RFC 5952 /48",
      tags: ["transform:mask", "mask:ip_prefix", "ip:v6"],
      spec: maskIpSpec,
      input: textInput("ip=2001:0db8:85a3:0000:0000:8a2e:0370:7334"),
      expected: match({ client_ip: okStr("2001:db8:85a3::/48") }),
    }),
    vec({
      id: "vec_tr_mask_ip_prefix_v6_compressed_008",
      description: "mask mode:ip_prefix truncates compressed IPv6 2001:db8::1 to 2001:db8::/48",
      tags: ["transform:mask", "mask:ip_prefix", "ip:v6"],
      spec: maskIpSpec,
      input: textInput("ip=2001:db8::1"),
      expected: match({ client_ip: okStr("2001:db8::/48") }),
    }),
    vec({
      id: "vec_tr_mask_ip_prefix_v6_loopback_009",
      description: "mask mode:ip_prefix truncates ::1 to ::/48",
      tags: ["transform:mask", "mask:ip_prefix", "ip:v6"],
      spec: maskIpSpec,
      input: textInput("ip=::1"),
      expected: match({ client_ip: okStr("::/48") }),
    }),
    vec({
      id: "vec_tr_mask_ip_prefix_v6_link_local_010",
      description: "mask mode:ip_prefix truncates fe80::1234:5678 to fe80::/48",
      tags: ["transform:mask", "mask:ip_prefix", "ip:v6"],
      spec: maskIpSpec,
      input: textInput("ip=fe80::1234:5678"),
      expected: match({ client_ip: okStr("fe80::/48") }),
    }),
    vec({
      id: "vec_tr_mask_ip_prefix_invalid_ip_011",
      description: "mask mode:ip_prefix reports invalid_ip parse_error on non-IP word",
      tags: ["transform:mask", "mask:ip_prefix", "parse_error"],
      spec: maskIpWordSpec,
      input: textInput("ip=not-an-ip"),
      expected: match({ client_ip: parseErr("invalid_ip") }),
    }),
    vec({
      id: "vec_tr_mask_ip_prefix_pre_masked_token_012",
      description: "pre-masked token <ip> short-circuits ip_prefix mask and remains redacted",
      tags: ["transform:mask", "mask:ip_prefix", "redaction:mask"],
      spec: maskIpSpec,
      input: textInput("ip=<ip>"),
      expected: match({ client_ip: redacted("<ip>") }),
    })
  );

  // ---- DROP (4 vectors across text, object, args, chained) ----
  const dropTextSpec = textSpec({
    template: "tpl_05DROP001",
    event: "test.transform.drop",
    segments: [{ lit: "secret=" }, { hole: "s", class: "word" }],
    fields: [
      field({
        id: "fld_05DROP0001",
        name: "secret",
        from: { hole: "s" },
        type: "string",
        pii: "secret",
        transforms: [{ op: "drop" }],
      }),
    ],
    sampleLine: "secret=fixture",
    sampleExpect: { secret: null },
  });

  vectors.push(
    vec({
      id: "vec_tr_drop_text_001",
      description: "drop transform discards secret text field value",
      tags: ["transform:drop", "dropped"],
      spec: dropTextSpec,
      input: textInput("secret=fixture"),
      expected: match({ secret: dropped() }),
    }),
    vec({
      id: "vec_tr_drop_object_002",
      description: "drop transform discards free_text object field value",
      tags: ["transform:drop", "dropped"],
      spec: objectSpec({
        template: "tpl_05DROP002",
        event: "test.transform.drop_obj",
        shape: ["note"],
        fields: [
          field({
            id: "fld_05DROP0002",
            name: "note",
            from: { path: "note" },
            type: "string",
            pii: "free_text",
            transforms: [{ op: "drop" }],
          }),
        ],
        sampleObject: { note: "customer typed notes" },
        sampleExpect: { note: null },
      }),
      input: objectInput({ note: "customer typed notes" }),
      expected: match({ note: dropped() }),
    }),
    vec({
      id: "vec_tr_drop_args_003",
      description: "drop transform discards args field value",
      tags: ["transform:drop", "dropped"],
      spec: argsSpec({
        template: "tpl_05DROP003",
        event: "test.transform.drop_args",
        strings: ["token=", ""],
        fields: [
          field({
            id: "fld_05DROP0003",
            name: "token",
            from: { arg: 0 },
            type: "string",
            pii: "secret",
            transforms: [{ op: "drop" }],
          }),
        ],
        sampleArgs: ["tok_live_abc"],
        sampleExpect: { token: null },
      }),
      input: argsInput(["token=", ""], ["tok_live_abc"]),
      expected: match({ token: dropped() }),
    }),
    vec({
      id: "vec_tr_drop_after_lower_004",
      description: "drop at end of transform chain yields dropped status",
      tags: ["transform:drop", "transform:lower", "transform:chain", "dropped"],
      spec: textSpec({
        template: "tpl_05DROP004",
        event: "test.transform.drop_chain",
        segments: [{ lit: "pw=" }, { hole: "pw", class: "word" }],
        fields: [
          field({
            id: "fld_05DROP0004",
            name: "pw",
            from: { hole: "pw" },
            type: "string",
            pii: "secret",
            transforms: [{ op: "lower" }, { op: "drop" }],
          }),
        ],
        sampleLine: "pw=Secret123",
        sampleExpect: { pw: null },
      }),
      input: textInput("pw=Secret123"),
      expected: match({ pw: dropped() }),
    })
  );

  // ---- REDACTION TOKENS ACROSS ALL 11 HOLE CLASSES ----
  const holeMaskConfigs = [
    { cls: "word", fieldType: "string", sample: "abc", segs: [{ lit: "v=" }, { hole: "v", class: "word" }], token: "<card>", sampleExpectVal: "abc" },
    { cls: "int", fieldType: "int", sample: "42", segs: [{ lit: "v=" }, { hole: "v", class: "int" }], token: "<card>", sampleExpectVal: 42 },
    { cls: "float", fieldType: "float", sample: "1.5", segs: [{ lit: "v=" }, { hole: "v", class: "float" }], token: "<secret:jwt>", sampleExpectVal: 1.5 },
    { cls: "uuid", fieldType: "string", sample: "550e8400-e29b-41d4-a716-446655440000", segs: [{ lit: "v=" }, { hole: "v", class: "uuid" }], token: "<secret:kv>", sampleExpectVal: "550e8400-e29b-41d4-a716-446655440000" },
    { cls: "hex", fieldType: "string", sample: "deadbeef", segs: [{ lit: "v=" }, { hole: "v", class: "hex" }], token: "<secret:jwt>", sampleExpectVal: "deadbeef" },
    { cls: "ip", fieldType: "string", sample: "203.0.113.42", segs: [{ lit: "v=" }, { hole: "v", class: "ip" }], token: "<card>", sampleExpectVal: "203.0.113.42" },
    { cls: "time", fieldType: "string", sample: "2026-11-26T14:00:00Z", segs: [{ lit: "v=" }, { hole: "v", class: "time" }], token: "<us_ssn>", sampleExpectVal: "2026-11-26T14:00:00Z" },
    { cls: "quoted", fieldType: "string", sample: '"hello"', segs: [{ lit: "v=" }, { hole: "v", class: "quoted" }], token: "<name>", sampleExpectVal: "hello" },
    { cls: "json", fieldType: "json", sample: '{"a":1}', segs: [{ lit: "v=" }, { hole: "v", class: "json" }], token: "<secret:kv>", sampleExpectVal: { a: 1 } },
    { cls: "until", fieldType: "string", sample: "abc", segs: [{ lit: "v=" }, { hole: "v", class: "until" }, { lit: ";" }], token: "<card>", sampleExpectVal: "abc", suffix: ";" },
    { cls: "rest", fieldType: "string", sample: "abc", segs: [{ lit: "v=" }, { hole: "v", class: "rest" }], token: "<secret:jwt>", sampleExpectVal: "abc" },
  ];

  holeMaskConfigs.forEach((cfg, idx) => {
    const n = String(idx + 1).padStart(3, "0");
    const suffix = cfg.suffix ?? "";
    vectors.push(
      vec({
        id: `vec_redact_mask_in_${cfg.cls}_${n}`,
        description: `mask token ${cfg.token} matches ${cfg.cls} hole and produces redacted marker`,
        tags: [`hole:${cfg.cls}`, "redaction:mask", "redacted"],
        spec: textSpec({
          template: `tpl_05REDM${n}`,
          event: "test.redaction.mask_hole",
          segments: cfg.segs,
          fields: [
            field({
              id: `fld_05REDM${n}`,
              name: "v",
              from: { hole: "v" },
              type: cfg.fieldType,
            }),
          ],
          sampleLine: `v=${cfg.sample}${suffix}`,
          sampleExpect: { v: cfg.sampleExpectVal },
        }),
        input: textInput(`v=${cfg.token}${suffix}`),
        expected: match({ v: redacted(cfg.token) }),
      })
    );
  });

  // Pseudonym token in string fields (6 vectors)
  const PSEUDO = "<email:9f2c41d07a3b55e1>";
  const pseudoStringHoles = [
    { cls: "word", segs: [{ lit: "v=" }, { hole: "v", class: "word" }], sample: "alice", suffix: "" },
    { cls: "quoted", segs: [{ lit: "v=" }, { hole: "v", class: "quoted" }], sample: '"alice"', sampleExpect: "alice", suffix: "" },
    { cls: "uuid", segs: [{ lit: "v=" }, { hole: "v", class: "uuid" }], sample: "550e8400-e29b-41d4-a716-446655440000", suffix: "" },
    { cls: "ip", segs: [{ lit: "v=" }, { hole: "v", class: "ip" }], sample: "203.0.113.42", suffix: "" },
    { cls: "until", segs: [{ lit: "v=" }, { hole: "v", class: "until" }, { lit: ";" }], sample: "alice", suffix: ";" },
    { cls: "rest", segs: [{ lit: "v=" }, { hole: "v", class: "rest" }], sample: "alice", suffix: "" },
  ];

  pseudoStringHoles.forEach((cfg, idx) => {
    const n = String(idx + 1).padStart(3, "0");
    vectors.push(
      vec({
        id: `vec_redact_pseudonym_string_${cfg.cls}_${n}`,
        description: `pseudonym token matches ${cfg.cls} hole and is stored as value of string field`,
        tags: [`hole:${cfg.cls}`, "redaction:pseudonym", "type:string"],
        spec: textSpec({
          template: `tpl_05REDS${n}`,
          event: "test.redaction.pseudo_str",
          segments: cfg.segs,
          fields: [field({ id: `fld_05REDS${n}`, name: "v", from: { hole: "v" }, type: "string" })],
          sampleLine: `v=${cfg.sample}${cfg.suffix}`,
          sampleExpect: { v: cfg.sampleExpect ?? cfg.sample },
        }),
        input: textInput(`v=${PSEUDO}${cfg.suffix}`),
        expected: match({ v: okStr(PSEUDO) }),
      })
    );
  });

  // Pseudonym token in ALL 6 non-string field types -> treated as mask
  const pseudoNonStringTypes = [
    { type: "int", cls: "int", sample: "42", sampleExpect: 42 },
    { type: "float", cls: "float", sample: "3.5", sampleExpect: 3.5 },
    { type: "bool", cls: "word", sample: "true", sampleExpect: true, transforms: [{ op: "cast", to: "bool" }] },
    { type: "timestamp", cls: "time", sample: "2026-11-26T14:00:00Z", sampleExpect: DEFAULT_CONTEXT.reference_ts_ms, transforms: [{ op: "parse_time" }] },
    { type: "enum", cls: "word", sample: "get", sampleExpect: "GET", transforms: [{ op: "enum_map", map: { get: "GET" } }] },
    { type: "json", cls: "json", sample: '{"a":1}', sampleExpect: { a: 1 } },
  ];

  pseudoNonStringTypes.forEach((cfg, idx) => {
    const n = String(idx + 1).padStart(3, "0");
    vectors.push(
      vec({
        id: `vec_redact_pseudonym_nonstring_${cfg.type}_${n}`,
        description: `pseudonym token in non-string (${cfg.type}) field is treated as a mask`,
        tags: [`hole:${cfg.cls}`, `type:${cfg.type}`, "redaction:pseudonym_as_mask", "redacted"],
        spec: textSpec({
          template: `tpl_05REDN${n}`,
          event: "test.redaction.pseudo_nonstring",
          segments: [{ lit: "v=" }, { hole: "v", class: cfg.cls }],
          fields: [
            field({
              id: `fld_05REDN${n}`,
              name: "v",
              from: { hole: "v" },
              type: cfg.type,
              transforms: cfg.transforms,
            }),
          ],
          sampleLine: `v=${cfg.sample}`,
          sampleExpect: { v: cfg.sampleExpect },
        }),
        input: textInput(`v=${PSEUDO}`),
        expected: match({ v: redacted(PSEUDO) }),
      })
    );
  });

  // Pre-scrubbed pseudonym short-circuiting drop & mask, neutral unknown angle-bracket strings, and PII placement (10 vectors)
  const intScaleSpec = textSpec({
    template: "tpl_05REDSC1",
    event: "test.redaction.scale",
    segments: [{ lit: "amt=" }, { hole: "a", class: "int" }],
    fields: [
      field({
        id: "fld_05REDSC1",
        name: "usd",
        from: { hole: "a" },
        type: "float",
        transforms: [{ op: "scale", div: 100 }],
      }),
    ],
    sampleLine: "amt=1999",
    sampleExpect: { usd: 19.99 },
  });

  const wordNeutralSpec = textSpec({
    template: "tpl_05REDW01",
    event: "test.redaction.neutral_word",
    segments: [{ lit: "tok=" }, { hole: "val", class: "word" }],
    fields: [field({ id: "fld_05REDW01", name: "val", from: { hole: "val" }, type: "string", semantic: "text" })],
    sampleLine: "tok=ok",
    sampleExpect: { val: "ok" },
  });

  const maskEmailWordSpec = textSpec({
    template: "tpl_05REDM99",
    event: "test.redaction.pseudo_mask",
    segments: [{ lit: "email=" }, { hole: "e", class: "word" }],
    fields: [
      field({
        id: "fld_05REDM99",
        name: "email",
        from: { hole: "e" },
        type: "string",
        semantic: "email",
        pii: "email",
        transforms: [{ op: "mask", mode: "token", kind: "email" }],
      }),
    ],
    sampleLine: "email=alice@example.com",
    sampleExpect: { email: null },
  });

  const piiNoTransformSpec = textSpec({
    template: "tpl_05PII001",
    event: "test.pii.metadata_only",
    segments: [{ lit: "email=" }, { hole: "e", class: "word" }],
    fields: [
      field({
        id: "fld_05PII001",
        name: "email",
        from: { hole: "e" },
        type: "string",
        semantic: "email",
        pii: "email",
      }),
    ],
    sampleLine: "email=alice@example.com",
    sampleExpect: { email: "alice@example.com" },
  });

  vectors.push(
    vec({
      id: "vec_redact_mask_short_circuits_scale_001",
      description: "mask token in int hole short-circuits scale transform without parse_error",
      tags: ["hole:int", "transform:scale", "redaction:mask", "redacted"],
      spec: intScaleSpec,
      input: textInput("amt=<card>"),
      expected: match({ usd: redacted("<card>") }),
    }),
    vec({
      id: "vec_redact_reject_angle_with_space_002",
      description: "angle brackets containing whitespace are NOT a redaction token and fail int hole",
      tags: ["hole:int", "redaction:negative", "no_match"],
      spec: intScaleSpec,
      input: textInput("amt=<not a token>"),
      expected: noMatch(),
    }),
    vec({
      id: "vec_redact_reject_empty_angle_003",
      description: "empty angle brackets <> are NOT a redaction token and fail int hole",
      tags: ["hole:int", "redaction:negative", "no_match"],
      spec: intScaleSpec,
      input: textInput("amt=<>"),
      expected: noMatch(),
    }),
    vec({
      id: "vec_redact_reject_uppercase_kind_004",
      description: "uppercase <CARD> is NOT a valid lowercase redaction token and fails int hole",
      tags: ["hole:int", "redaction:negative", "no_match"],
      spec: intScaleSpec,
      input: textInput("amt=<CARD>"),
      expected: noMatch(),
    }),
    vec({
      id: "vec_redact_pseudonym_string_short_circuits_drop_001",
      description: "pre-scrubbed pseudonym token on string field short-circuits drop transform and is stored unchanged",
      tags: ["hole:word", "transform:drop", "redaction:pseudonym", "ambiguity:prescrubbed_token_transforms"],
      spec: dropTextSpec,
      input: textInput(`secret=${PSEUDO}`),
      expected: match({ secret: okStr(PSEUDO) }),
    }),
    vec({
      id: "vec_redact_pseudonym_string_short_circuits_mask_002",
      description: "pre-scrubbed pseudonym token on string field short-circuits mask transform and is stored unchanged",
      tags: ["hole:word", "transform:mask", "redaction:pseudonym", "ambiguity:prescrubbed_token_transforms"],
      spec: maskEmailWordSpec,
      input: textInput(`email=${PSEUDO}`),
      expected: match({ email: okStr(PSEUDO) }),
    }),
    vec({
      id: "vec_redact_neutral_unknown_nil_in_word_005",
      description: "unknown angle-bracket token <nil> is NOT a known redaction kind and stays an ordinary string in word hole",
      tags: ["hole:word", "redaction:neutral", "type:string"],
      spec: wordNeutralSpec,
      input: textInput("tok=<nil>"),
      expected: match({ val: okStr("<nil>") }),
    }),
    vec({
      id: "vec_redact_neutral_html_tag_prefix_in_word_006",
      description: "HTML-like token <b>bold is NOT a known redaction kind and scans cleanly as a single word",
      tags: ["hole:word", "redaction:neutral", "type:string"],
      spec: wordNeutralSpec,
      input: textInput("tok=<b>bold"),
      expected: match({ val: okStr("<b>bold") }),
    }),
    vec({
      id: "vec_redact_reject_unknown_nil_in_int_007",
      description: "unknown angle-bracket token <nil> is NOT accepted as a redaction token by typed int hole",
      tags: ["hole:int", "redaction:neutral", "no_match"],
      spec: intScaleSpec,
      input: textInput("amt=<nil>"),
      expected: noMatch(),
    }),
    vec({
      id: "vec_pii_metadata_without_transforms_raw_001",
      description: "field pii metadata alone without explicit transforms leaves raw string value unchanged in pure ParserSpec execution",
      tags: ["hole:word", "type:string", "ambiguity:pii_default_transform_placement"],
      spec: piiNoTransformSpec,
      input: textInput("email=alice@example.com"),
      expected: match({ email: okStr("alice@example.com") }),
    })
  );

  // ---- QUOTED CAPTURES AFTER UNESCAPING ALIGNED WITH RECOGNIZED INCOMING TOKENS ----
  const quotedUserStrSpec = textSpec({
    template: "tpl_05QTOK01",
    event: "test.redaction.quoted_string",
    segments: [{ lit: "user=" }, { hole: "u", class: "quoted" }],
    fields: [
      field({
        id: "fld_05QTOK01",
        name: "user",
        from: { hole: "u" },
        type: "string",
      }),
    ],
    sampleLine: 'user="alice"',
    sampleExpect: { user: "alice" },
  });

  const quotedUserIntSpec = textSpec({
    template: "tpl_05QTOK02",
    event: "test.redaction.quoted_int",
    segments: [{ lit: "user=" }, { hole: "u", class: "quoted" }],
    fields: [
      field({
        id: "fld_05QTOK02",
        name: "user",
        from: { hole: "u" },
        type: "int",
      }),
    ],
    sampleLine: 'user="<card>"',
    sampleExpect: { user: null },
  });

  const quotedUserDropSpec = textSpec({
    template: "tpl_05QTOK03",
    event: "test.redaction.quoted_drop",
    segments: [{ lit: "user=" }, { hole: "u", class: "quoted" }],
    fields: [
      field({
        id: "fld_05QTOK03",
        name: "user",
        from: { hole: "u" },
        type: "string",
        pii: "secret",
        transforms: [{ op: "drop" }],
      }),
    ],
    sampleLine: 'user="alice"',
    sampleExpect: { user: null },
  });

  const quotedUserMaskSpec = textSpec({
    template: "tpl_05QTOK04",
    event: "test.redaction.quoted_mask",
    segments: [{ lit: "user=" }, { hole: "u", class: "quoted" }],
    fields: [
      field({
        id: "fld_05QTOK04",
        name: "user",
        from: { hole: "u" },
        type: "string",
        pii: "email",
        transforms: [{ op: "mask", mode: "token", kind: "email" }],
      }),
    ],
    sampleLine: 'user="alice@example.com"',
    sampleExpect: { user: null },
  });

  vectors.push(
    vec({
      id: "vec_redact_quoted_mask_string_001",
      description: "quoted capture user=\"<card>\" on string field is recognized after unquoting and redacted as <card>",
      tags: ["hole:quoted", "type:string", "redaction:mask", "redacted", "ambiguity:quoted_token_classification"],
      spec: quotedUserStrSpec,
      input: textInput('user="<card>"'),
      expected: match({ user: redacted("<card>") }),
    }),
    vec({
      id: "vec_redact_quoted_mask_int_002",
      description: "quoted capture user=\"<card>\" on int field is recognized after unquoting and redacted as <card>",
      tags: ["hole:quoted", "type:int", "redaction:mask", "redacted", "ambiguity:quoted_token_classification"],
      spec: quotedUserIntSpec,
      input: textInput('user="<card>"'),
      expected: match({ user: redacted("<card>") }),
    }),
    vec({
      id: "vec_redact_quoted_pseudonym_short_circuits_drop_003",
      description: "quoted final pseudonym user=\"<email:9f2c41d07a3b55e1>\" on string field short-circuits drop transform",
      tags: [
        "hole:quoted",
        "type:string",
        "transform:drop",
        "redaction:pseudonym",
        "ambiguity:prescrubbed_token_transforms",
        "ambiguity:quoted_token_classification",
      ],
      spec: quotedUserDropSpec,
      input: textInput(`user="${PSEUDO}"`),
      expected: match({ user: okStr(PSEUDO) }),
    }),
    vec({
      id: "vec_redact_quoted_pseudonym_short_circuits_mask_004",
      description: "quoted final pseudonym user=\"<email:9f2c41d07a3b55e1>\" on string field short-circuits mask transform",
      tags: [
        "hole:quoted",
        "type:string",
        "transform:mask",
        "redaction:pseudonym",
        "ambiguity:prescrubbed_token_transforms",
        "ambiguity:quoted_token_classification",
      ],
      spec: quotedUserMaskSpec,
      input: textInput(`user="${PSEUDO}"`),
      expected: match({ user: okStr(PSEUDO) }),
    }),
    vec({
      id: "vec_redact_quoted_pseudonym_nonstring_int_005",
      description: "quoted final pseudonym user=\"<email:9f2c41d07a3b55e1>\" on int field is redacted as <email:9f2c41d07a3b55e1>",
      tags: ["hole:quoted", "type:int", "redaction:pseudonym_as_mask", "redacted", "ambiguity:quoted_token_classification"],
      spec: quotedUserIntSpec,
      input: textInput(`user="${PSEUDO}"`),
      expected: match({ user: redacted(PSEUDO) }),
    }),
    vec({
      id: "vec_redact_quoted_escaped_token_unescaped_006",
      description: "quoted capture unescaping to recognized mask token <secret:a\"b> is classified after unescaping",
      tags: ["hole:quoted", "type:string", "redaction:mask", "redacted", "ambiguity:quoted_token_classification"],
      spec: quotedUserStrSpec,
      input: textInput('user="<secret:a\\"b>"'),
      expected: match({ user: redacted('<secret:a"b>') }),
    }),
    vec({
      id: "vec_redact_quoted_neutral_unknown_nil_007",
      description: "quoted capture user=\"<nil>\" with unknown angle-bracket name stays an ordinary string after unescaping",
      tags: ["hole:quoted", "type:string", "redaction:neutral", "ambiguity:quoted_token_classification"],
      spec: quotedUserStrSpec,
      input: textInput('user="<nil>"'),
      expected: match({ user: okStr("<nil>") }),
    })
  );

  // ---- HOSTED UNEXPECTED INNER EDGE TOKENS (<kind:~64hex> -> fixed <redacted>) ----
  const INNER_EDGE =
    "<email:~0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef>";

  const innerEdgeObjSpec = objectSpec({
    template: "tpl_05INED01",
    event: "test.redaction.inner_edge_obj",
    shape: ["email"],
    fields: [
      field({
        id: "fld_05INED01",
        name: "email",
        from: { path: "email" },
        type: "string",
        semantic: "email",
        pii: "email",
        transforms: [{ op: "hash", kind: "email" }],
      }),
    ],
    sampleObject: { email: "alice@example.com" },
    sampleExpect: { email: `<email:${hmacTag("alice@example.com")}>` },
  });

  vectors.push(
    vec({
      id: "vec_redact_inner_edge_string_raw_001",
      description: "hosted conformance fails closed on unexpected inner edge token in string field using fixed <redacted> marker without exposing inner digest",
      tags: ["hole:word", "type:string", "redaction:inner_edge", "redacted", "ambiguity:hosted_inner_edge_token"],
      spec: piiNoTransformSpec,
      input: textInput(`email=${INNER_EDGE}`),
      expected: match({ email: redacted("<redacted>") }),
    }),
    vec({
      id: "vec_redact_inner_edge_string_with_hash_002",
      description: "hosted conformance fails closed on unexpected inner edge token even when hash transform is declared",
      tags: ["hole:word", "type:string", "transform:hash", "redaction:inner_edge", "redacted", "ambiguity:hosted_inner_edge_token"],
      spec: emailHashSpec,
      input: textInput(`email=${INNER_EDGE}`),
      expected: match({ email: redacted("<redacted>") }),
    }),
    vec({
      id: "vec_redact_inner_edge_nonstring_int_003",
      description: "hosted conformance redacts unexpected inner edge token on non-string field with fixed <redacted> marker without exposing inner digest",
      tags: ["hole:int", "type:float", "transform:scale", "redaction:inner_edge", "redacted", "ambiguity:hosted_inner_edge_token"],
      spec: intScaleSpec,
      input: textInput(`amt=${INNER_EDGE}`),
      expected: match({ usd: redacted("<redacted>") }),
    }),
    vec({
      id: "vec_redact_inner_edge_quoted_004",
      description: "quoted capture containing unexpected inner edge token fails closed as fixed <redacted> marker",
      tags: [
        "hole:quoted",
        "type:string",
        "redaction:inner_edge",
        "redacted",
        "ambiguity:hosted_inner_edge_token",
        "ambiguity:quoted_token_classification",
      ],
      spec: quotedUserStrSpec,
      input: textInput(`user="${INNER_EDGE}"`),
      expected: match({ user: redacted("<redacted>") }),
    }),
    vec({
      id: "vec_redact_inner_edge_object_path_005",
      description: "object path containing unexpected inner edge token fails closed as fixed <redacted> marker in hosted conformance",
      tags: ["type:string", "transform:hash", "redaction:inner_edge", "redacted", "ambiguity:hosted_inner_edge_token"],
      spec: innerEdgeObjSpec,
      input: objectInput({ email: INNER_EDGE }),
      expected: match({ email: redacted("<redacted>") }),
    })
  );

  // ---- NEWLY GENERATED TAG IDENTITY THROUGH TRANSFORMS ----
  const customRepeatedHashSpec = textSpec({
    template: "tpl_05HASH009",
    event: "test.transform.hash_custom_repeat",
    segments: [{ lit: "email=" }, { hole: "e", class: "word" }],
    fields: [
      field({
        id: "fld_05HASH0009",
        name: "email",
        from: { hole: "e" },
        type: "string",
        pii: "email",
        transforms: [
          { op: "hash", kind: "customer_email" },
          { op: "hash", kind: "email" },
        ],
      }),
    ],
    sampleLine: "email=alice@example.com",
    sampleExpect: { email: `<customer_email:${hmacTag("alice@example.com")}>` },
  });

  const customHashThroughCastLowerRepeatSpec = textSpec({
    template: "tpl_05HASH010",
    event: "test.transform.hash_custom_chain",
    segments: [{ lit: "email=" }, { hole: "e", class: "word" }],
    fields: [
      field({
        id: "fld_05HASH0010",
        name: "email",
        from: { hole: "e" },
        type: "string",
        pii: "email",
        transforms: [
          { op: "hash", kind: "customer_email" },
          { op: "cast", to: "string" },
          { op: "lower" },
          { op: "hash", kind: "email" },
        ],
      }),
    ],
    sampleLine: "email=alice@example.com",
    sampleExpect: { email: `<customer_email:${hmacTag("alice@example.com")}>` },
  });

  const customHashNonStringIntSpec = textSpec({
    template: "tpl_05HASH011",
    event: "test.transform.hash_nonstring_int",
    segments: [{ lit: "uid=" }, { hole: "u", class: "int" }],
    fields: [
      field({
        id: "fld_05HASH0011",
        name: "uid",
        from: { hole: "u" },
        type: "int",
        transforms: [{ op: "hash", kind: "customer_id" }],
      }),
    ],
    sampleLine: "uid=42",
    sampleExpect: { uid: null },
  });

  const customHashNonStringEnumLowerSpec = textSpec({
    template: "tpl_05HASH012",
    event: "test.transform.hash_nonstring_enum",
    segments: [{ lit: "role=" }, { hole: "r", class: "word" }],
    fields: [
      field({
        id: "fld_05HASH0012",
        name: "role",
        from: { hole: "r" },
        type: "enum",
        transforms: [{ op: "hash", kind: "customer_role" }, { op: "lower" }],
      }),
    ],
    sampleLine: "role=admin",
    sampleExpect: { role: null },
  });

  const customHashThenDropSpec = textSpec({
    template: "tpl_05HASH013",
    event: "test.transform.hash_then_drop",
    segments: [{ lit: "email=" }, { hole: "e", class: "word" }],
    fields: [
      field({
        id: "fld_05HASH0013",
        name: "email",
        from: { hole: "e" },
        type: "string",
        pii: "email",
        transforms: [{ op: "hash", kind: "customer_email" }, { op: "drop" }],
      }),
    ],
    sampleLine: "email=alice@example.com",
    sampleExpect: { email: null },
  });

  const customHashThenMaskSpec = textSpec({
    template: "tpl_05HASH014",
    event: "test.transform.hash_then_mask",
    segments: [{ lit: "email=" }, { hole: "e", class: "word" }],
    fields: [
      field({
        id: "fld_05HASH0014",
        name: "email",
        from: { hole: "e" },
        type: "string",
        pii: "email",
        transforms: [
          { op: "hash", kind: "customer_email" },
          { op: "mask", mode: "token", kind: "secret" },
        ],
      }),
    ],
    sampleLine: "email=alice@example.com",
    sampleExpect: { email: null },
  });

  vectors.push(
    vec({
      id: "vec_tr_hash_custom_label_repeated_hash_009",
      description: "repeated hash preserves newly generated tag with custom label without double hashing",
      tags: ["transform:hash", "transform:chain", "ambiguity:generated_tag_identity"],
      spec: customRepeatedHashSpec,
      input: textInput("email=alice@example.com"),
      expected: match({ email: okStr(`<customer_email:${hmacTag("alice@example.com")}>`) }),
    }),
    vec({
      id: "vec_tr_hash_custom_label_cast_lower_repeated_hash_010",
      description: "newly generated tag identity carries through cast(string) and lower into a later repeated hash",
      tags: ["transform:hash", "transform:cast", "transform:lower", "transform:chain", "ambiguity:generated_tag_identity"],
      spec: customHashThroughCastLowerRepeatSpec,
      input: textInput("email=alice@example.com"),
      expected: match({ email: okStr(`<customer_email:${hmacTag("alice@example.com")}>`) }),
    }),
    vec({
      id: "vec_tr_hash_custom_label_nonstring_int_redacted_011",
      description: "newly generated tag with custom label on non-string int field finalizes as redacted marker",
      tags: ["hole:int", "type:int", "transform:hash", "redacted", "ambiguity:generated_tag_identity"],
      spec: customHashNonStringIntSpec,
      input: textInput("uid=42"),
      expected: match({ uid: redacted(`<customer_id:${hmacTag("42")}>`) }),
    }),
    vec({
      id: "vec_tr_hash_custom_label_nonstring_enum_after_lower_redacted_012",
      description: "newly generated tag identity carried through lower on non-string enum field finalizes as redacted marker",
      tags: ["hole:word", "type:enum", "transform:hash", "transform:lower", "transform:chain", "redacted", "ambiguity:generated_tag_identity"],
      spec: customHashNonStringEnumLowerSpec,
      input: textInput("role=admin"),
      expected: match({ role: redacted(`<customer_role:${hmacTag("admin")}>`) }),
    }),
    vec({
      id: "vec_tr_hash_followed_by_explicit_drop_013",
      description: "explicit drop after hash still drops the newly generated tag",
      tags: ["transform:hash", "transform:drop", "transform:chain", "dropped", "ambiguity:generated_tag_identity"],
      spec: customHashThenDropSpec,
      input: textInput("email=alice@example.com"),
      expected: match({ email: dropped() }),
    }),
    vec({
      id: "vec_tr_hash_followed_by_explicit_mask_014",
      description: "explicit mask after hash still replaces the newly generated tag with the requested mask marker",
      tags: ["transform:hash", "transform:mask", "transform:chain", "redacted", "ambiguity:generated_tag_identity"],
      spec: customHashThenMaskSpec,
      input: textInput("email=alice@example.com"),
      expected: match({ email: redacted("<secret>") }),
    })
  );

  // ---- KNOWN REDACTION TOKEN BEFORE OVERLAPPING ':' LITERAL ----
  const tokenBeforeColonSpec = textSpec({
    template: "tpl_05COL001",
    event: "test.redaction.token_before_colon",
    segments: [
      { lit: "v=" },
      { hole: "v", class: "word" },
      { lit: ":" },
      { hole: "code", class: "int" },
    ],
    fields: [
      field({ id: "fld_05COL001", name: "v", from: { hole: "v" }, type: "string" }),
      field({ id: "fld_05COL002", name: "code", from: { hole: "code" }, type: "int" }),
    ],
    sampleLine: "v=alice:200",
    sampleExpect: { v: "alice", code: 200 },
  });

  vectors.push(
    vec({
      id: "vec_redact_token_before_colon_literal_pseudonym_001",
      description: "known pseudonym token containing ':' matches intact before following ':' literal",
      tags: [
        "hole:word",
        "hole:int",
        "redaction:pseudonym",
        "boundary:following_literal",
        "ambiguity:scanner_hole_boundary",
      ],
      spec: tokenBeforeColonSpec,
      input: textInput(`v=${PSEUDO}:200`),
      expected: match({ v: okStr(PSEUDO), code: okInt("200") }),
    }),
    vec({
      id: "vec_redact_token_before_colon_literal_mask_002",
      description: "known mask token <secret:jwt> containing ':' matches intact before following ':' literal",
      tags: [
        "hole:word",
        "hole:int",
        "redaction:mask",
        "redacted",
        "boundary:following_literal",
        "ambiguity:scanner_hole_boundary",
      ],
      spec: tokenBeforeColonSpec,
      input: textInput("v=<secret:jwt>:200"),
      expected: match({ v: redacted("<secret:jwt>"), code: okInt("200") }),
    })
  );

  // ---- SCHEMA-VALID cast(int) -> hash PIPELINE ----
  const castIntThenHashStrSpec = textSpec({
    template: "tpl_05HASH015",
    event: "test.transform.cast_int_hash_str",
    segments: [{ lit: "uid=" }, { hole: "u", class: "word" }],
    fields: [
      field({
        id: "fld_05HASH0015",
        name: "uid",
        from: { hole: "u" },
        type: "string",
        transforms: [
          { op: "cast", to: "int" },
          { op: "hash", kind: "uid" },
        ],
      }),
    ],
    sampleLine: "uid=0042",
    sampleExpect: { uid: `<uid:${hmacTag("42")}>` },
  });

  const castIntThenHashIntSpec = textSpec({
    template: "tpl_05HASH016",
    event: "test.transform.cast_int_hash_int",
    segments: [{ lit: "uid=" }, { hole: "u", class: "word" }],
    fields: [
      field({
        id: "fld_05HASH0016",
        name: "uid",
        from: { hole: "u" },
        type: "int",
        transforms: [
          { op: "cast", to: "int" },
          { op: "hash", kind: "uid" },
        ],
      }),
    ],
    sampleLine: "uid=0042",
    sampleExpect: { uid: null },
  });

  vectors.push(
    vec({
      id: "vec_tr_cast_int_then_hash_string_015",
      description: "schema-valid cast(int) followed by hash normalizes integer text and hashes its canonical decimal form",
      tags: ["transform:cast", "cast:int", "transform:hash", "transform:chain", "type:string"],
      spec: castIntThenHashStrSpec,
      input: textInput("uid=0042"),
      expected: match({ uid: okStr(`<uid:${hmacTag("42")}>`) }),
    }),
    vec({
      id: "vec_tr_cast_int_then_hash_nonstring_int_016",
      description: "schema-valid cast(int) followed by hash on int field finalizes generated tag as redacted marker",
      tags: ["transform:cast", "cast:int", "transform:hash", "transform:chain", "type:int", "redacted", "ambiguity:generated_tag_identity"],
      spec: castIntThenHashIntSpec,
      input: textInput("uid=0042"),
      expected: match({ uid: redacted(`<uid:${hmacTag("42")}>`) }),
    })
  );

  // ---- HOSTED INNER-EDGE NO-SPILL ACROSS CAPTURE BOUNDARIES (PRESERVING NORMAL LITERALS) ----
  const untilGtSpec = textSpec({
    template: "tpl_05INED06",
    event: "test.redaction.inner_edge_until_gt",
    segments: [{ lit: "user=" }, { hole: "u", class: "until" }, { lit: ">" }],
    fields: [field({ id: "fld_05INED06", name: "u", from: { hole: "u" }, type: "string" })],
    sampleLine: "user=alice>",
    sampleExpect: { u: "alice" },
  });

  const untilGtSiblingSpec = textSpec({
    template: "tpl_05INED07",
    event: "test.redaction.inner_edge_until_gt_sibling",
    segments: [
      { lit: "user=" },
      { hole: "u", class: "until" },
      { lit: "> status=" },
      { hole: "s", class: "int" },
    ],
    fields: [
      field({ id: "fld_05INED07A", name: "u", from: { hole: "u" }, type: "string" }),
      field({ id: "fld_05INED07B", name: "s", from: { hole: "s" }, type: "int" }),
    ],
    sampleLine: "user=alice> status=200",
    sampleExpect: { u: "alice", s: 200 },
  });

  const untilColonRestSpec = textSpec({
    template: "tpl_05INED08",
    event: "test.redaction.inner_edge_split_colon",
    segments: [
      { lit: "user=" },
      { hole: "u", class: "until" },
      { lit: ":" },
      { hole: "r", class: "rest" },
    ],
    fields: [
      field({ id: "fld_05INED08A", name: "u", from: { hole: "u" }, type: "string" }),
      field({ id: "fld_05INED08B", name: "r", from: { hole: "r" }, type: "string" }),
    ],
    sampleLine: "user=alice:bob",
    sampleExpect: { u: "alice", r: "bob" },
  });

  const litLtUntilGtSpec = textSpec({
    template: "tpl_05INED09",
    event: "test.redaction.inner_edge_lit_lt_gt",
    segments: [{ lit: "user=<" }, { hole: "u", class: "until" }, { lit: ">" }],
    fields: [field({ id: "fld_05INED09", name: "u", from: { hole: "u" }, type: "string" })],
    sampleLine: "user=<alice>",
    sampleExpect: { u: "alice" },
  });

  const restEmbeddedSpec = textSpec({
    template: "tpl_05INED10",
    event: "test.redaction.inner_edge_rest",
    segments: [{ lit: "msg=" }, { hole: "m", class: "rest" }],
    fields: [field({ id: "fld_05INED10", name: "m", from: { hole: "m" }, type: "string" })],
    sampleLine: "msg=hello world",
    sampleExpect: { m: "hello world" },
  });

  const INNER_EDGE_ESCAPED_TILDE =
    "<email:\\u007e0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef>";

  vectors.push(
    vec({
      id: "vec_redact_inner_edge_until_stops_at_gt_006",
      description: "until hole stopping at token-closing '>' overlaps whole-input inner edge token and fails closed as <redacted>",
      tags: ["hole:until", "type:string", "redaction:inner_edge", "redacted", "ambiguity:hosted_inner_edge_token"],
      spec: untilGtSpec,
      input: textInput(`user=${INNER_EDGE}`),
      expected: match({ u: redacted("<redacted>") }),
    }),
    vec({
      id: "vec_redact_inner_edge_until_gt_preserves_sibling_007",
      description: "whole-input inner edge span overlap redacts straddling until hole while preserving unaffected sibling fields",
      tags: ["hole:until", "hole:int", "redaction:inner_edge", "redacted", "ambiguity:hosted_inner_edge_token"],
      spec: untilGtSiblingSpec,
      input: textInput(`user=${INNER_EDGE} status=200`),
      expected: match({ u: redacted("<redacted>"), s: okInt("200") }),
    }),
    vec({
      id: "vec_redact_inner_edge_until_colon_split_across_holes_008",
      description: "inner edge token split across until ':' and rest holes fails closed as <redacted> on both overlapping fields",
      tags: ["hole:until", "hole:rest", "redaction:inner_edge", "redacted", "ambiguity:hosted_inner_edge_token"],
      spec: untilColonRestSpec,
      input: textInput(`user=${INNER_EDGE}`),
      expected: match({ u: redacted("<redacted>"), r: redacted("<redacted>") }),
    }),
    vec({
      id: "vec_redact_inner_edge_lit_consumes_lt_until_gt_009",
      description: "inner edge token straddling leading '<' literal and trailing '>' literal still fails closed as <redacted>",
      tags: ["hole:until", "redaction:inner_edge", "redacted", "ambiguity:hosted_inner_edge_token"],
      spec: litLtUntilGtSpec,
      input: textInput(`user=${INNER_EDGE}`),
      expected: match({ u: redacted("<redacted>") }),
    }),
    vec({
      id: "vec_redact_inner_edge_embedded_in_rest_010",
      description: "rest capture containing an embedded well-formed known inner edge token fails closed as <redacted>",
      tags: ["hole:rest", "redaction:inner_edge", "redacted", "ambiguity:hosted_inner_edge_token"],
      spec: restEmbeddedSpec,
      input: textInput(`msg=prefix ${INNER_EDGE} suffix`),
      expected: match({ m: redacted("<redacted>") }),
    }),
    vec({
      id: "vec_redact_inner_edge_quoted_escaped_tilde_011",
      description: "quoted capture unescaping \\u007e into a well-formed known inner edge token fails closed as <redacted>",
      tags: ["hole:quoted", "redaction:inner_edge", "redacted", "ambiguity:hosted_inner_edge_token", "ambiguity:quoted_token_classification"],
      spec: quotedUserStrSpec,
      input: textInput(`user="${INNER_EDGE_ESCAPED_TILDE}"`),
      expected: match({ user: redacted("<redacted>") }),
    }),
    vec({
      id: "vec_redact_inner_edge_object_embedded_string_012",
      description: "object string value containing an embedded well-formed known inner edge token fails closed as <redacted>",
      tags: ["type:string", "transform:hash", "redaction:inner_edge", "redacted", "ambiguity:hosted_inner_edge_token"],
      spec: innerEdgeObjSpec,
      input: objectInput({ email: `prefix ${INNER_EDGE} suffix` }),
      expected: match({ email: redacted("<redacted>") }),
    }),
    vec({
      id: "vec_redact_inner_edge_until_gt_normal_boundary_preserved_013",
      description: "normal literal '>' boundary on until hole is unchanged when no known inner edge token is present",
      tags: ["hole:until", "type:string", "boundary:following_literal", "ambiguity:hosted_inner_edge_token"],
      spec: untilGtSpec,
      input: textInput("user=alice>"),
      expected: match({ u: okStr("alice") }),
    }),
    vec({
      id: "vec_redact_inner_edge_until_gt_pseudonym_boundary_preserved_014",
      description: "normal literal '>' boundary on until hole is preserved for non-inner 16-hex final pseudonym text",
      tags: ["hole:until", "type:string", "boundary:following_literal", "ambiguity:hosted_inner_edge_token"],
      spec: untilGtSpec,
      input: textInput(`user=${PSEUDO}`),
      expected: match({ u: okStr(PSEUDO.slice(0, -1)) }),
    })
  );

  // ---- CUSTOM SCHEMA-VALID hash.kind INNER EDGE TOKENS (e.g. kind: "user") ----
  const CUSTOM_USER_INNER_EDGE =
    "<user:~0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef>";
  const CUSTOM_USER_INNER_EDGE_DECODED_ESC =
    "\\u003cuser:\\u007e0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\\u003e";

  const customUserHashSpec = textSpec({
    template: "tpl_05INED15",
    event: "test.redaction.inner_edge_custom_user",
    segments: [{ lit: "user=" }, { hole: "u", class: "word" }],
    fields: [
      field({
        id: "fld_05INED15",
        name: "user",
        from: { hole: "u" },
        type: "string",
        transforms: [{ op: "hash", kind: "user" }],
      }),
    ],
    sampleLine: "user=alice",
    sampleExpect: { user: `<user:${hmacTag("alice")}>` },
  });

  const customUserDropSpec = textSpec({
    template: "tpl_05INED19",
    event: "test.redaction.custom_user_non_inner_drop",
    segments: [{ lit: "user=" }, { hole: "u", class: "word" }],
    fields: [
      field({
        id: "fld_05INED19",
        name: "user",
        from: { hole: "u" },
        type: "string",
        transforms: [{ op: "drop" }],
      }),
    ],
    sampleLine: "user=alice",
    sampleExpect: { user: null },
  });

  vectors.push(
    vec({
      id: "vec_redact_inner_edge_custom_kind_user_single_string_015",
      description: "hosted conformance fails closed to <redacted> on custom schema-valid hash.kind 'user' inner edge token in string field",
      tags: ["hole:word", "type:string", "transform:hash", "redaction:inner_edge", "redacted", "ambiguity:hosted_inner_edge_token"],
      spec: customUserHashSpec,
      input: textInput(`user=${CUSTOM_USER_INNER_EDGE}`),
      expected: match({ user: redacted("<redacted>") }),
    }),
    vec({
      id: "vec_redact_inner_edge_custom_kind_user_single_int_016",
      description: "hosted conformance matches and fails closed to <redacted> on custom schema-valid hash.kind 'user' inner edge token in int hole",
      tags: ["hole:int", "type:float", "transform:scale", "redaction:inner_edge", "redacted", "ambiguity:hosted_inner_edge_token"],
      spec: intScaleSpec,
      input: textInput(`amt=${CUSTOM_USER_INNER_EDGE}`),
      expected: match({ usd: redacted("<redacted>") }),
    }),
    vec({
      id: "vec_redact_inner_edge_custom_kind_user_until_gt_overlap_017",
      description: "custom schema-valid hash.kind 'user' inner edge token straddling until '>' fails closed as <redacted> without spilling digest",
      tags: ["hole:until", "type:string", "redaction:inner_edge", "redacted", "ambiguity:hosted_inner_edge_token"],
      spec: untilGtSpec,
      input: textInput(`user=${CUSTOM_USER_INNER_EDGE}`),
      expected: match({ u: redacted("<redacted>") }),
    }),
    vec({
      id: "vec_redact_inner_edge_custom_kind_user_quoted_decoded_018",
      description: "quoted capture decoding \\u003c/\\u007e/\\u003e into custom inner edge token <user:~64hex> fails closed as <redacted>",
      tags: ["hole:quoted", "type:string", "redaction:inner_edge", "redacted", "ambiguity:hosted_inner_edge_token", "ambiguity:quoted_token_classification"],
      spec: quotedUserStrSpec,
      input: textInput(`user="${CUSTOM_USER_INNER_EDGE_DECODED_ESC}"`),
      expected: match({ user: redacted("<redacted>") }),
    }),
    vec({
      id: "vec_redact_custom_kind_user_non_inner_stays_ordinary_019",
      description: "non-inner custom angle form <user:9f2c41d07a3b55e1> stays ordinary text under closed-catalog final/mask rules and is still dropped",
      tags: ["hole:word", "type:string", "transform:drop", "redaction:neutral", "dropped", "ambiguity:hosted_inner_edge_token"],
      spec: customUserDropSpec,
      input: textInput("user=<user:9f2c41d07a3b55e1>"),
      expected: match({ user: dropped() }),
    })
  );

  // ---- ESCAPED INNER TAGS IN rest->cast(json) & JSON HOLE DUPLICATE KEYS, WORD+LIT+REST SPLIT, NESTED INSPECTION, HASH COERCION ----
  const restCastJsonSpec = textSpec({
    template: "tpl_05INED20",
    event: "test.redaction.inner_edge_rest_cast_json",
    segments: [{ lit: "payload=" }, { hole: "p", class: "rest" }],
    fields: [
      field({
        id: "fld_05INED20",
        name: "payload",
        from: { hole: "p" },
        type: "json",
        transforms: [{ op: "cast", to: "json" }],
      }),
    ],
    sampleLine: 'payload={"ok":true}',
    sampleExpect: { payload: { ok: true } },
  });

  const jsonHoleInnerEdgeSpec = textSpec({
    template: "tpl_05INED22",
    event: "test.redaction.inner_edge_json_hole_dup",
    segments: [{ lit: "payload=" }, { hole: "p", class: "json" }],
    fields: [
      field({
        id: "fld_05INED22",
        name: "payload",
        from: { hole: "p" },
        type: "json",
      }),
    ],
    sampleLine: 'payload={"a":"ok"}',
    sampleExpect: { payload: { a: "ok" } },
  });

  const wordColonRestSpec = textSpec({
    template: "tpl_05INED23",
    event: "test.redaction.inner_edge_word_colon_rest",
    segments: [
      { lit: "user=" },
      { hole: "u", class: "word" },
      { lit: ":" },
      { hole: "r", class: "rest" },
    ],
    fields: [
      field({ id: "fld_05INED23A", name: "u", from: { hole: "u" }, type: "string" }),
      field({ id: "fld_05INED23B", name: "r", from: { hole: "r" }, type: "string" }),
    ],
    sampleLine: "user=alice:ok",
    sampleExpect: { u: "alice", r: "ok" },
  });

  const nestedInnerEdgeObjSpec = objectSpec({
    template: "tpl_05INED25",
    event: "test.redaction.inner_edge_nested_obj",
    shape: ["data"],
    fields: [
      field({
        id: "fld_05INED25",
        name: "data",
        from: { path: "data" },
        type: "json",
      }),
    ],
    sampleObject: { data: { ok: true } },
    sampleExpect: { data: { ok: true } },
  });

  let nestedCustomInner = { leaf: CUSTOM_USER_INNER_EDGE };
  for (let d = 0; d < 16; d += 1) {
    nestedCustomInner = { a: nestedCustomInner };
  }

  const hashScalarOrStructuredSpec = objectSpec({
    template: "tpl_05HASH26",
    event: "test.transform.hash_scalar_only",
    shape: ["val"],
    fields: [
      field({
        id: "fld_05HASH26",
        name: "val",
        from: { path: "val" },
        type: "string",
        transforms: [{ op: "hash", kind: "user" }],
      }),
    ],
    sampleObject: { val: "alice" },
    sampleExpect: { val: `<user:${hmacTag("alice")}>` },
  });

  vectors.push(
    vec({
      id: "vec_redact_inner_edge_rest_cast_json_escaped_020",
      description: "rest -> cast(json) decoding an escaped custom inner edge token fails closed as <redacted>",
      tags: ["hole:rest", "transform:cast", "cast:json", "type:json", "redaction:inner_edge", "redacted", "ambiguity:hosted_inner_edge_token"],
      spec: restCastJsonSpec,
      input: textInput(`payload={"a":"${CUSTOM_USER_INNER_EDGE_DECODED_ESC}"}`),
      expected: match({ payload: redacted("<redacted>") }),
    }),
    vec({
      id: "vec_redact_inner_edge_rest_cast_json_dup_key_escaped_021",
      description: "rest -> cast(json) carrying a duplicate member's escaped inner edge token fails closed as <redacted> even when JSON.parse drops the earlier key",
      tags: ["hole:rest", "transform:cast", "cast:json", "type:json", "redaction:inner_edge", "redacted", "ambiguity:hosted_inner_edge_token"],
      spec: restCastJsonSpec,
      input: textInput(`payload={"a":"${CUSTOM_USER_INNER_EDGE_DECODED_ESC}","a":"safe"}`),
      expected: match({ payload: redacted("<redacted>") }),
    }),
    vec({
      id: "vec_redact_inner_edge_json_hole_dup_key_escaped_022",
      description: "json hole raw text carrying a duplicate member's escaped inner edge token fails closed as <redacted> even when JSON.parse drops its key",
      tags: ["hole:json", "type:json", "redaction:inner_edge", "redacted", "ambiguity:hosted_inner_edge_token"],
      spec: jsonHoleInnerEdgeSpec,
      input: textInput(`payload={"a":"${CUSTOM_USER_INNER_EDGE_DECODED_ESC}","a":"safe"}`),
      expected: match({ payload: redacted("<redacted>") }),
    }),
    vec({
      id: "vec_redact_inner_edge_custom_kind_user_word_colon_rest_split_023",
      description: "leading custom inner edge token preserves ordinary word+':'+rest split when ':' does not immediately follow the full tag and redacts both overlapping spans",
      tags: ["hole:word", "hole:rest", "type:string", "boundary:following_literal", "redaction:inner_edge", "redacted", "ambiguity:hosted_inner_edge_token"],
      spec: wordColonRestSpec,
      input: textInput(`user=${CUSTOM_USER_INNER_EDGE}`),
      expected: match({ u: redacted("<redacted>"), r: redacted("<redacted>") }),
    }),
    vec({
      id: "vec_redact_inner_edge_custom_kind_user_word_colon_rest_full_tag_024",
      description: "leading custom inner edge token immediately followed by requested ':' literal matches the full tag in word (redacted) and preserves trailing rest",
      tags: ["hole:word", "hole:rest", "type:string", "boundary:following_literal", "redaction:inner_edge", "redacted", "ambiguity:hosted_inner_edge_token"],
      spec: wordColonRestSpec,
      input: textInput(`user=${CUSTOM_USER_INNER_EDGE}:ok`),
      expected: match({ u: redacted("<redacted>"), r: okStr("ok") }),
    }),
    vec({
      id: "vec_redact_inner_edge_nested_object_025",
      description: "nested structured object containing a custom inner edge token at depth 16 fails closed as <redacted> via iterative inspection",
      tags: ["object:pure", "type:json", "redaction:inner_edge", "redacted", "ambiguity:hosted_inner_edge_token"],
      spec: nestedInnerEdgeObjSpec,
      input: objectInput({ data: nestedCustomInner }),
      expected: match({ data: redacted("<redacted>") }),
    }),
    vec({
      id: "vec_tr_hash_scalar_int_coercion_026",
      description: "hash supports scalar int string coercion from structured object input",
      tags: ["object:pure", "transform:hash", "type:string"],
      spec: hashScalarOrStructuredSpec,
      input: objectInput({ val: 42 }),
      expected: match({ val: okStr(`<user:${hmacTag("42")}>`) }),
    }),
    vec({
      id: "vec_tr_hash_structured_object_rejected_027",
      description: "hash rejects structured object input with type_mismatch instead of coercing to string",
      tags: ["object:pure", "transform:hash", "parse_error"],
      spec: hashScalarOrStructuredSpec,
      input: objectInput({ val: { a: 1 } }),
      expected: match({ val: parseErr("type_mismatch") }),
    }),
    vec({
      id: "vec_tr_hash_structured_array_rejected_028",
      description: "hash rejects structured array input with type_mismatch instead of coercing to string",
      tags: ["object:pure", "transform:hash", "parse_error"],
      spec: hashScalarOrStructuredSpec,
      input: objectInput({ val: [1, 2] }),
      expected: match({ val: parseErr("type_mismatch") }),
    })
  );

  return {
    suite: "05-transforms-privacy-and-redaction",
    description: "Golden conformance vectors covering hash, mask (token and ip_prefix), drop, known redaction tokens across all 11 hole classes and field types, neutral unknown angle-bracket strings, and explicit PII transform placement.",
    vectors,
  };
}
