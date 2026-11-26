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
      description: "hash transform leaves pre-existing pseudonym token unchanged (no double hashing, §14)",
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
  vectors.push(
    vec({
      id: "vec_tr_drop_text_001",
      description: "drop transform discards secret text field value",
      tags: ["transform:drop", "dropped"],
      spec: textSpec({
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
        sampleLine: "secret=ghp_0123456789abcdef",
        sampleExpect: { secret: null },
      }),
      input: textInput("secret=ghp_0123456789abcdef"),
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

  // ---- REDACTION TOKENS ACROSS ALL 11 HOLE CLASSES (§5 line 112, §14 line 39) ----
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
        description: `mask token ${cfg.token} matches ${cfg.cls} hole and produces redacted marker (§5)`,
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
        description: `pseudonym token matches ${cfg.cls} hole and is stored as value of string field (§5)`,
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

  // Pseudonym token in ALL 6 non-string field types -> treated as mask (§5 line 112!)
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
        description: `pseudonym token in non-string (${cfg.type}) field is treated as a mask (§5)`,
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

  // Mask token short-circuits scale transform + non-token angle-bracket rejection (4 vectors)
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
    })
  );

  return {
    suite: "05-transforms-privacy-and-redaction",
    description: "Golden conformance vectors covering hash, mask (token and ip_prefix), drop, and Stage 2/3 redaction tokens across all 11 hole classes and field types (§5, §14).",
    vectors,
  };
}
