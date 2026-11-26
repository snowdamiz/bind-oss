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
  textInput,
  textSpec,
  vec,
} from "../lib/vector-builders.mjs";

export function buildSuite07() {
  const vectors = [];
  const T_BASE = Date.UTC(2026, 10, 26, 14, 0, 0, 0);

  // ---- §5 Canonical Example, Static Text, Regex-Meta Literals (4 vectors) ----
  const section5OrderSpec = textSpec({
    template: "tpl_01JD8Q2M4K",
    event: "order.paid",
    version: 3,
    status: "active",
    origin: "agent",
    source: {
      kind: "callsite",
      repo: "github.com/acme/shop",
      path: "src/orders/checkout.ts",
      line: 142,
      symbol: "completeCheckout",
      logger: "pino.info",
      valid_from_commit: "9f3c2ab",
    },
    segments: [
      { lit: "order " },
      { hole: "order_id", class: "word" },
      { lit: " paid " },
      { hole: "amount", class: "int" },
      { lit: " in " },
      { hole: "elapsed", class: "int" },
      { lit: "ms" },
    ],
    fields: [
      field({
        id: "fld_01JD8Q2M9A",
        name: "order_id",
        from: { hole: "order_id" },
        type: "string",
        semantic: "id.order",
        entity: "order",
        pii: "none",
        confidence: 0.97,
        evidence: { expr: "order.id", path: "src/orders/checkout.ts", line: 142 },
      }),
      field({
        id: "fld_01JD8Q2M9B",
        name: "amount_usd",
        from: { hole: "amount" },
        type: "float",
        semantic: "money",
        unit: "USD",
        transforms: [{ op: "scale", div: 100 }],
        confidence: 0.88,
        evidence: { expr: "cents", path: "src/orders/checkout.ts", line: 139 },
      }),
      field({
        id: "fld_01JD8Q2M9C",
        name: "duration_ms",
        from: { hole: "elapsed" },
        type: "int",
        semantic: "duration",
        unit: "ms",
        confidence: 0.99,
        evidence: { expr: "ms", path: "src/orders/checkout.ts", line: 142 },
      }),
    ],
    sampleLine: "order ord_8f2a paid 1999 in 212ms",
    sampleExpect: { order_id: "ord_8f2a", amount_usd: 19.99, duration_ms: 212 },
  });

  const staticTextSpec = textSpec({
    template: "tpl_07STAT001",
    event: "health.ok",
    segments: [{ lit: "healthcheck ok" }],
    fields: [],
    sampleLine: "healthcheck ok",
    sampleExpect: {},
  });

  const regexMetaLitSpec = textSpec({
    template: "tpl_07META001",
    event: "test.regex_meta",
    segments: [
      { lit: "^$.*+?()[a-z]{1,2}|\\ " },
      { hole: "v", class: "int" },
      { lit: " $end." },
    ],
    fields: [field({ id: "fld_07META001", name: "v", from: { hole: "v" }, type: "int" })],
    sampleLine: "^$.*+?()[a-z]{1,2}|\\ 42 $end.",
    sampleExpect: { v: 42 },
  });

  vectors.push(
    vec({
      id: "vec_s5_canonical_order_paid_001",
      description: "exact §5 canonical order.paid text example with IEEE-754 pinned amount_usd",
      tags: ["section5:canonical", "hole:word", "hole:int", "transform:scale", "ieee754"],
      spec: section5OrderSpec,
      input: textInput("order ord_8f2a paid 1999 in 212ms"),
      expected: match({
        order_id: okStr("ord_8f2a"),
        amount_usd: okFloatHex("4033fd70a3d70a3d"),
        duration_ms: okInt("212"),
      }),
    }),
    vec({
      id: "vec_static_zero_field_text_match_002",
      description: "zero-field literal-only text spec matches exact line",
      tags: ["boundary:zero_fields"],
      spec: staticTextSpec,
      input: textInput("healthcheck ok"),
      expected: match({}),
    }),
    vec({
      id: "vec_static_zero_field_text_mismatch_003",
      description: "zero-field literal-only text spec rejects trailing character",
      tags: ["boundary:zero_fields", "no_match"],
      spec: staticTextSpec,
      input: textInput("healthcheck ok!"),
      expected: noMatch(),
    }),
    vec({
      id: "vec_regex_metacharacters_in_literals_004",
      description: "literals containing every RE2 metacharacter match literally without regex interpretation",
      tags: ["boundary:regex_meta", "hole:int"],
      spec: regexMetaLitSpec,
      input: textInput("^$.*+?()[a-z]{1,2}|\\ 99 $end."),
      expected: match({ v: okInt("99") }),
    })
  );

  // ---- ADJACENT HOLES (§17 explicit requirement!) (10 vectors) ----
  vectors.push(
    vec({
      id: "vec_adj_int_word_001",
      description: "adjacent int + word holes split '212ms' into 212 and 'ms'",
      tags: ["adjacent_holes", "hole:int", "hole:word"],
      spec: textSpec({
        template: "tpl_07ADJ0001",
        event: "test.adjacent",
        segments: [{ lit: "t=" }, { hole: "num", class: "int" }, { hole: "unit", class: "word" }],
        fields: [
          field({ id: "fld_07ADJ0001", name: "num", from: { hole: "num" }, type: "int" }),
          field({ id: "fld_07ADJ0002", name: "unit", from: { hole: "unit" }, type: "string" }),
        ],
        sampleLine: "t=212ms",
        sampleExpect: { num: 212, unit: "ms" },
      }),
      input: textInput("t=212ms"),
      expected: match({ num: okInt("212"), unit: okStr("ms") }),
    }),
    vec({
      id: "vec_adj_float_word_002",
      description: "adjacent float + word holes split '1.5GB' into 1.5 and 'GB'",
      tags: ["adjacent_holes", "hole:float", "hole:word"],
      spec: textSpec({
        template: "tpl_07ADJ0002",
        event: "test.adjacent",
        segments: [{ lit: "sz=" }, { hole: "sz", class: "float" }, { hole: "unit", class: "word" }],
        fields: [
          field({ id: "fld_07ADJ0003", name: "sz", from: { hole: "sz" }, type: "float" }),
          field({ id: "fld_07ADJ0004", name: "unit", from: { hole: "unit" }, type: "string" }),
        ],
        sampleLine: "sz=1.5GB",
        sampleExpect: { sz: 1.5, unit: "GB" },
      }),
      input: textInput("sz=1.5GB"),
      expected: match({ sz: okFloat(1.5), unit: okStr("GB") }),
    }),
    vec({
      id: "vec_adj_quoted_int_003",
      description: "adjacent quoted + int holes split '\"ok\"42' without separator",
      tags: ["adjacent_holes", "hole:quoted", "hole:int"],
      spec: textSpec({
        template: "tpl_07ADJ0003",
        event: "test.adjacent",
        segments: [{ hole: "msg", class: "quoted" }, { hole: "code", class: "int" }],
        fields: [
          field({ id: "fld_07ADJ0005", name: "msg", from: { hole: "msg" }, type: "string" }),
          field({ id: "fld_07ADJ0006", name: "code", from: { hole: "code" }, type: "int" }),
        ],
        sampleLine: '"ok"42',
        sampleExpect: { msg: "ok", code: 42 },
      }),
      input: textInput('"ok"42'),
      expected: match({ msg: okStr("ok"), code: okInt("42") }),
    }),
    vec({
      id: "vec_adj_quoted_quoted_004",
      description: "two adjacent quoted holes split '\"a\"\"b\"' cleanly",
      tags: ["adjacent_holes", "hole:quoted"],
      spec: textSpec({
        template: "tpl_07ADJ0004",
        event: "test.adjacent",
        segments: [{ hole: "a", class: "quoted" }, { hole: "b", class: "quoted" }],
        fields: [
          field({ id: "fld_07ADJ0007", name: "a", from: { hole: "a" }, type: "string" }),
          field({ id: "fld_07ADJ0008", name: "b", from: { hole: "b" }, type: "string" }),
        ],
        sampleLine: '"a""b"',
        sampleExpect: { a: "a", b: "b" },
      }),
      input: textInput('"hello"\'world\''),
      expected: match({ a: okStr("hello"), b: okStr("world") }),
    }),
    vec({
      id: "vec_adj_uuid_word_005",
      description: "adjacent uuid + word holes split UUID and ':ready' suffix",
      tags: ["adjacent_holes", "hole:uuid", "hole:word"],
      spec: textSpec({
        template: "tpl_07ADJ0005",
        event: "test.adjacent",
        segments: [{ hole: "id", class: "uuid" }, { hole: "suffix", class: "word" }],
        fields: [
          field({ id: "fld_07ADJ0009", name: "id", from: { hole: "id" }, type: "string" }),
          field({ id: "fld_07ADJ0010", name: "suffix", from: { hole: "suffix" }, type: "string" }),
        ],
        sampleLine: "550e8400-e29b-41d4-a716-446655440000:ready",
        sampleExpect: { id: "550e8400-e29b-41d4-a716-446655440000", suffix: ":ready" },
      }),
      input: textInput("550e8400-e29b-41d4-a716-446655440000:ready"),
      expected: match({ id: okStr("550e8400-e29b-41d4-a716-446655440000"), suffix: okStr(":ready") }),
    }),
    vec({
      id: "vec_adj_ip_word_006",
      description: "adjacent ip + word holes split IPv4 and ':8080' port suffix",
      tags: ["adjacent_holes", "hole:ip", "hole:word"],
      spec: textSpec({
        template: "tpl_07ADJ0006",
        event: "test.adjacent",
        segments: [{ hole: "ip", class: "ip" }, { hole: "port_part", class: "word" }],
        fields: [
          field({ id: "fld_07ADJ0011", name: "ip", from: { hole: "ip" }, type: "string" }),
          field({ id: "fld_07ADJ0012", name: "port_part", from: { hole: "port_part" }, type: "string" }),
        ],
        sampleLine: "127.0.0.1:8080",
        sampleExpect: { ip: "127.0.0.1", port_part: ":8080" },
      }),
      input: textInput("127.0.0.1:8080"),
      expected: match({ ip: okStr("127.0.0.1"), port_part: okStr(":8080") }),
    }),
    vec({
      id: "vec_adj_json_word_sql_refused_007",
      description: "adjacent json + word holes split '{\"a\":1}done' cleanly (SQL-refused)",
      tags: ["adjacent_holes", "hole:json", "hole:word"],
      spec: textSpec({
        template: "tpl_07ADJ0007",
        event: "test.adjacent",
        segments: [{ hole: "obj", class: "json" }, { hole: "tag", class: "word" }],
        fields: [
          field({ id: "fld_07ADJ0013", name: "obj", from: { hole: "obj" }, type: "json" }),
          field({ id: "fld_07ADJ0014", name: "tag", from: { hole: "tag" }, type: "string" }),
        ],
        sampleLine: '{"a":1}done',
        sampleExpect: { obj: { a: 1 }, tag: "done" },
      }),
      input: textInput('{"a":1}done'),
      expected: match({ obj: okJson({ a: 1 }), tag: okStr("done") }),
    }),
    vec({
      id: "vec_adj_json_int_sql_refused_008",
      description: "adjacent json + int holes split '[1,2]99' cleanly (SQL-refused)",
      tags: ["adjacent_holes", "hole:json", "hole:int"],
      spec: textSpec({
        template: "tpl_07ADJ0008",
        event: "test.adjacent",
        segments: [{ hole: "arr", class: "json" }, { hole: "cnt", class: "int" }],
        fields: [
          field({ id: "fld_07ADJ0015", name: "arr", from: { hole: "arr" }, type: "json" }),
          field({ id: "fld_07ADJ0016", name: "cnt", from: { hole: "cnt" }, type: "int" }),
        ],
        sampleLine: "[1,2]99",
        sampleExpect: { arr: [1, 2], cnt: 99 },
      }),
      input: textInput("[1,2]99"),
      expected: match({ arr: okJson([1, 2]), cnt: okInt("99") }),
    }),
    vec({
      id: "vec_adj_int_rest_009",
      description: "adjacent int + rest holes split '404not found' into 404 and 'not found'",
      tags: ["adjacent_holes", "hole:int", "hole:rest"],
      spec: textSpec({
        template: "tpl_07ADJ0009",
        event: "test.adjacent",
        segments: [{ hole: "code", class: "int" }, { hole: "msg", class: "rest" }],
        fields: [
          field({ id: "fld_07ADJ0017", name: "code", from: { hole: "code" }, type: "int" }),
          field({ id: "fld_07ADJ0018", name: "msg", from: { hole: "msg" }, type: "string" }),
        ],
        sampleLine: "404not found",
        sampleExpect: { code: 404, msg: "not found" },
      }),
      input: textInput("404not found"),
      expected: match({ code: okInt("404"), msg: okStr("not found") }),
    }),
    vec({
      id: "vec_adj_quoted_rest_010",
      description: "adjacent quoted + rest holes preserve leading space in rest",
      tags: ["adjacent_holes", "hole:quoted", "hole:rest"],
      spec: textSpec({
        template: "tpl_07ADJ0010",
        event: "test.adjacent",
        segments: [{ hole: "tag", class: "quoted" }, { hole: "details", class: "rest" }],
        fields: [
          field({ id: "fld_07ADJ0019", name: "tag", from: { hole: "tag" }, type: "string" }),
          field({ id: "fld_07ADJ0020", name: "details", from: { hole: "details" }, type: "string" }),
        ],
        sampleLine: '"err" details here',
        sampleExpect: { tag: "err", details: " details here" },
      }),
      input: textInput('"err" details here'),
      expected: match({ tag: okStr("err"), details: okStr(" details here") }),
    })
  );

  // ---- NON-ASCII UTF-8 CASES (§17 explicit requirement: U+00A0, U+3000, combining marks, emoji!) (18 vectors) ----
  const uniWordSpec = textSpec({
    template: "tpl_07UNI0001",
    event: "test.unicode.word",
    segments: [{ lit: "w=" }, { hole: "w", class: "word" }, { lit: " end" }],
    fields: [field({ id: "fld_07UNI0001", name: "w", from: { hole: "w" }, type: "string" })],
    sampleLine: "w=hello end",
    sampleExpect: { w: "hello" },
  });

  const uniLitSpaceSpec = textSpec({
    template: "tpl_07UNI0002",
    event: "test.unicode.space",
    segments: [{ lit: "a b=" }, { hole: "v", class: "word" }],
    fields: [field({ id: "fld_07UNI0002", name: "v", from: { hole: "v" }, type: "string" })],
    sampleLine: "a b=1",
    sampleExpect: { v: "1" },
  });

  const uniLitNbspSpec = textSpec({
    template: "tpl_07UNI0003",
    event: "test.unicode.nbsp_lit",
    segments: [{ lit: "a\u00a0b=" }, { hole: "v", class: "word" }],
    fields: [field({ id: "fld_07UNI0003", name: "v", from: { hole: "v" }, type: "string" })],
    sampleLine: "a\u00a0b=1",
    sampleExpect: { v: "1" },
  });

  const uniNfcLitSpec = textSpec({
    template: "tpl_07UNI0004",
    event: "test.unicode.nfc",
    segments: [{ lit: "caf\u00e9=" }, { hole: "v", class: "word" }],
    fields: [field({ id: "fld_07UNI0004", name: "v", from: { hole: "v" }, type: "string" })],
    sampleLine: "caf\u00e9=open",
    sampleExpect: { v: "open" },
  });

  const uniNfdLitSpec = textSpec({
    template: "tpl_07UNI0005",
    event: "test.unicode.nfd",
    segments: [{ lit: "cafe\u0301=" }, { hole: "v", class: "word" }],
    fields: [field({ id: "fld_07UNI0005", name: "v", from: { hole: "v" }, type: "string" })],
    sampleLine: "cafe\u0301=open",
    sampleExpect: { v: "open" },
  });

  const uniEmojiZwjUntilSpec = textSpec({
    template: "tpl_07UNI0006",
    event: "test.unicode.zwj_until",
    segments: [
      { lit: "fam=" },
      { hole: "left", class: "until" },
      { lit: "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}" },
      { hole: "right", class: "rest" },
    ],
    fields: [
      field({ id: "fld_07UNI0006", name: "left", from: { hole: "left" }, type: "string" }),
      field({ id: "fld_07UNI0007", name: "right", from: { hole: "right" }, type: "string" }),
    ],
    sampleLine: "fam=A\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}B",
    sampleExpect: { left: "A", right: "B" },
  });

  vectors.push(
    vec({
      id: "vec_unicode_nbsp_inside_word_001",
      description: "U+00A0 (NO-BREAK SPACE) is NOT ASCII whitespace and stays inside a single word hole (§17)",
      tags: ["unicode", "unicode:nbsp", "hole:word"],
      spec: uniWordSpec,
      input: textInput("w=hello\u00a0world end"),
      expected: match({ w: okStr("hello\u00a0world") }),
    }),
    vec({
      id: "vec_unicode_ascii_space_lit_rejects_nbsp_002",
      description: "ASCII space in literal does NOT match U+00A0 in input (§17)",
      tags: ["unicode", "unicode:nbsp", "no_match"],
      spec: uniLitSpaceSpec,
      input: textInput("a\u00a0b=1"),
      expected: noMatch(),
    }),
    vec({
      id: "vec_unicode_nbsp_lit_rejects_ascii_space_003",
      description: "U+00A0 in literal does NOT match ASCII space 0x20 in input (§17)",
      tags: ["unicode", "unicode:nbsp", "no_match"],
      spec: uniLitNbspSpec,
      input: textInput("a b=1"),
      expected: noMatch(),
    }),
    vec({
      id: "vec_unicode_nbsp_lit_exact_match_004",
      description: "U+00A0 in literal matches exact U+00A0 UTF-8 bytes in input",
      tags: ["unicode", "unicode:nbsp"],
      spec: uniLitNbspSpec,
      input: textInput("a\u00a0b=ok"),
      expected: match({ v: okStr("ok") }),
    }),
    vec({
      id: "vec_unicode_ideographic_space_inside_word_005",
      description: "U+3000 (IDEOGRAPHIC SPACE) is NOT ASCII whitespace and stays inside a single word hole (§17)",
      tags: ["unicode", "unicode:ideographic_space", "hole:word"],
      spec: uniWordSpec,
      input: textInput("w=\u6771\u4eac\u3000\u5927\u962a end"),
      expected: match({ w: okStr("\u6771\u4eac\u3000\u5927\u962a") }),
    }),
    vec({
      id: "vec_unicode_ascii_space_lit_rejects_ideographic_space_006",
      description: "ASCII space in literal does NOT match U+3000 in input (§17)",
      tags: ["unicode", "unicode:ideographic_space", "no_match"],
      spec: uniLitSpaceSpec,
      input: textInput("a\u3000b=1"),
      expected: noMatch(),
    }),
    vec({
      id: "vec_unicode_combining_mark_nfd_preserved_007",
      description: "NFD combining mark (e + U+0301) in word hole is preserved byte-for-byte without NFC normalization (§17)",
      tags: ["unicode", "unicode:combining", "hole:word"],
      spec: uniWordSpec,
      input: textInput("w=cafe\u0301 end"),
      expected: match({ w: okStr("cafe\u0301") }),
    }),
    vec({
      id: "vec_unicode_nfc_lit_rejects_nfd_input_008",
      description: "UTF-8 byte matching: NFC literal caf\\u00e9= does NOT match NFD input cafe\\u0301= (§17)",
      tags: ["unicode", "unicode:combining", "no_match"],
      spec: uniNfcLitSpec,
      input: textInput("cafe\u0301=open"),
      expected: noMatch(),
    }),
    vec({
      id: "vec_unicode_nfd_lit_rejects_nfc_input_009",
      description: "UTF-8 byte matching: NFD literal cafe\\u0301= does NOT match NFC input caf\\u00e9= (§17)",
      tags: ["unicode", "unicode:combining", "no_match"],
      spec: uniNfdLitSpec,
      input: textInput("caf\u00e9=open"),
      expected: noMatch(),
    }),
    vec({
      id: "vec_unicode_nfd_lit_matches_nfd_input_010",
      description: "NFD literal cafe\\u0301= matches exact NFD bytes cafe\\u0301=",
      tags: ["unicode", "unicode:combining"],
      spec: uniNfdLitSpec,
      input: textInput("cafe\u0301=open"),
      expected: match({ v: okStr("open") }),
    }),
    vec({
      id: "vec_unicode_stacked_combining_marks_011",
      description: "multiple stacked combining marks on a single base character stay intact in word hole",
      tags: ["unicode", "unicode:combining", "hole:word"],
      spec: uniWordSpec,
      input: textInput("w=a\u0301\u0323\u0308 end"),
      expected: match({ w: okStr("a\u0301\u0323\u0308") }),
    }),
    vec({
      id: "vec_unicode_emoji_rocket_in_word_012",
      description: "4-byte UTF-8 emoji 🚀 inside word hole",
      tags: ["unicode", "unicode:emoji", "hole:word"],
      spec: uniWordSpec,
      input: textInput("w=deploy-\u{1F680}-v2 end"),
      expected: match({ w: okStr("deploy-\u{1F680}-v2") }),
    }),
    vec({
      id: "vec_unicode_emoji_zwj_family_in_word_013",
      description: "multi-scalar ZWJ emoji grapheme cluster 👨‍👩‍👧‍👦 stays intact in word hole (§17)",
      tags: ["unicode", "unicode:emoji", "hole:word"],
      spec: uniWordSpec,
      input: textInput("w=team:\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466} end"),
      expected: match({ w: okStr("team:\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}") }),
    }),
    vec({
      id: "vec_unicode_emoji_zwj_as_until_delimiter_014",
      description: "until hole stops at multi-scalar ZWJ emoji literal without splitting grapheme bytes (§17)",
      tags: ["unicode", "unicode:emoji", "hole:until"],
      spec: uniEmojiZwjUntilSpec,
      input: textInput("fam=before \u{1F468} still before\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}after"),
      expected: match({ left: okStr("before \u{1F468} still before"), right: okStr("after") }),
    }),
    vec({
      id: "vec_unicode_emoji_flag_and_skin_tone_015",
      description: "regional indicator flag 🇺🇸 and skin-tone modifier 👍🏽 preserved byte-for-byte",
      tags: ["unicode", "unicode:emoji", "hole:word"],
      spec: uniWordSpec,
      input: textInput("w=\u{1F1FA}\u{1F1F8}_\u{1F44D}\u{1F3FD} end"),
      expected: match({ w: okStr("\u{1F1FA}\u{1F1F8}_\u{1F44D}\u{1F3FD}") }),
    }),
    vec({
      id: "vec_unicode_cjk_cyrillic_arabic_016",
      description: "mixed CJK, Cyrillic, and Arabic scripts preserved across until and rest",
      tags: ["unicode", "hole:until", "hole:rest"],
      spec: textSpec({
        template: "tpl_07UNI0016",
        event: "test.unicode.scripts",
        segments: [{ lit: "s=" }, { hole: "a", class: "until" }, { lit: "|" }, { hole: "b", class: "rest" }],
        fields: [
          field({ id: "fld_07UNI0016", name: "a", from: { hole: "a" }, type: "string" }),
          field({ id: "fld_07UNI0017", name: "b", from: { hole: "b" }, type: "string" }),
        ],
        sampleLine: "s=a|b",
        sampleExpect: { a: "a", b: "b" },
      }),
      input: textInput("s=\u65e5\u672c\u8a9e \u041f\u0440\u0438\u0432\u0435\u0442|\u0645\u0631\u062d\u0628\u0627"),
      expected: match({
        a: okStr("\u65e5\u672c\u8a9e \u041f\u0440\u0438\u0432\u0435\u0442"),
        b: okStr("\u0645\u0631\u062d\u0628\u0627"),
      }),
    }),
    vec({
      id: "vec_unicode_swift_grapheme_boundary_check_017",
      description: "literal ending in base 'e' matches before combining acute U+0301 in UTF-8 byte mode (§17 Swift byte scanner pin)",
      tags: ["unicode", "unicode:combining", "boundary:utf8_bytes"],
      spec: textSpec({
        template: "tpl_07UNI0017",
        event: "test.unicode.byte_split",
        segments: [{ lit: "cafe" }, { hole: "tail", class: "rest" }],
        fields: [field({ id: "fld_07UNI0018", name: "tail", from: { hole: "tail" }, type: "string" })],
        sampleLine: "cafe!",
        sampleExpect: { tail: "!" },
      }),
      input: textInput("cafe\u0301"),
      expected: match({ tail: okStr("\u0301") }),
    }),
    vec({
      id: "vec_unicode_combining_mark_in_literal_split_018",
      description: "until stops at literal combining-mark separator without normalizing",
      tags: ["unicode", "unicode:combining", "hole:until"],
      spec: textSpec({
        template: "tpl_07UNI0018",
        event: "test.unicode.comb_until",
        segments: [{ hole: "a", class: "until" }, { lit: "e\u0301" }, { hole: "b", class: "rest" }],
        fields: [
          field({ id: "fld_07UNI0019", name: "a", from: { hole: "a" }, type: "string" }),
          field({ id: "fld_07UNI0020", name: "b", from: { hole: "b" }, type: "string" }),
        ],
        sampleLine: "cafe\u0301-bar",
        sampleExpect: { a: "caf", b: "-bar" },
      }),
      input: textInput("caf\u00e9_cafe\u0301-bar"),
      expected: match({ a: okStr("caf\u00e9_caf"), b: okStr("-bar") }),
    })
  );

  // ---- 64 KiB BOUNDARY RECORDS (§17 explicit requirement!) (5 vectors) ----
  const prefix64kRest = "blob ";
  const payload64kRest = "A".repeat(65536 - Buffer.byteLength(prefix64kRest, "utf8")); // exact 65536 bytes!

  const prefix64kUntil = "data ";
  const suffix64kUntil = " len=65536";
  const payload64kUntil = "x".repeat(65536 - Buffer.byteLength(prefix64kUntil, "utf8") - Buffer.byteLength(suffix64kUntil, "utf8"));

  // Exact 65536 UTF-8 bytes with 4-byte emoji: prefix "utf8 " (5 bytes) + 16382 * 🚀 (65528 bytes) + "END" (3 bytes) = 65536 bytes!
  const prefix64kUtf8 = "utf8 ";
  const payload64kUtf8 = "\u{1F680}".repeat(16382) + "END";

  const payload64kObj = "B".repeat(65000);
  const payload64kArgs = "C".repeat(65000);

  vectors.push(
    vec({
      id: "vec_large_64kib_text_rest_001",
      description: "exact 65,536-byte (64 KiB) text record parsed via rest hole (§17)",
      tags: ["boundary:64kib", "hole:rest"],
      spec: textSpec({
        template: "tpl_07BIG0001",
        event: "test.large.rest",
        segments: [{ lit: prefix64kRest }, { hole: "blob", class: "rest" }],
        fields: [field({ id: "fld_07BIG0001", name: "blob", from: { hole: "blob" }, type: "string" })],
        sampleLine: "blob short",
        sampleExpect: { blob: "short" },
      }),
      input: textInput(prefix64kRest + payload64kRest),
      expected: match({ blob: okStr(payload64kRest) }),
    }),
    vec({
      id: "vec_large_64kib_text_until_int_002",
      description: "exact 65,536-byte (64 KiB) text record with until hole followed by literal and int hole (§17)",
      tags: ["boundary:64kib", "hole:until", "hole:int"],
      spec: textSpec({
        template: "tpl_07BIG0002",
        event: "test.large.until",
        segments: [
          { lit: prefix64kUntil },
          { hole: "data", class: "until" },
          { lit: " len=" },
          { hole: "len", class: "int" },
        ],
        fields: [
          field({ id: "fld_07BIG0002", name: "data", from: { hole: "data" }, type: "string" }),
          field({ id: "fld_07BIG0003", name: "len", from: { hole: "len" }, type: "int" }),
        ],
        sampleLine: "data hi len=2",
        sampleExpect: { data: "hi", len: 2 },
      }),
      input: textInput(prefix64kUntil + payload64kUntil + suffix64kUntil),
      expected: match({ data: okStr(payload64kUntil), len: okInt("65536") }),
    }),
    vec({
      id: "vec_large_64kib_utf8_emoji_bytes_003",
      description: "exact 65,536 UTF-8 byte record made of 4-byte emoji (16,385 codepoints, 65,536 bytes)",
      tags: ["boundary:64kib", "unicode:emoji", "hole:rest"],
      spec: textSpec({
        template: "tpl_07BIG0003",
        event: "test.large.utf8",
        segments: [{ lit: prefix64kUtf8 }, { hole: "body", class: "rest" }],
        fields: [field({ id: "fld_07BIG0004", name: "body", from: { hole: "body" }, type: "string" })],
        sampleLine: "utf8 ok",
        sampleExpect: { body: "ok" },
      }),
      input: textInput(prefix64kUtf8 + payload64kUtf8),
      expected: match({ body: okStr(payload64kUtf8) }),
    }),
    vec({
      id: "vec_large_64kib_object_004",
      description: "64 KiB-scale object record with large string leaf and message sub-pattern",
      tags: ["boundary:64kib", "object:message"],
      spec: objectSpec({
        template: "tpl_07BIG0004",
        event: "test.large.object",
        shape: ["msg", "blob"],
        message: {
          path: "msg",
          segments: [{ lit: "chunk " }, { hole: "seq", class: "int" }],
        },
        fields: [
          field({ id: "fld_07BIG0005", name: "seq", from: { hole: "seq" }, type: "int" }),
          field({ id: "fld_07BIG0006", name: "blob", from: { path: "blob" }, type: "string" }),
        ],
        sampleObject: { msg: "chunk 1", blob: "abc" },
        sampleExpect: { seq: 1, blob: "abc" },
      }),
      input: objectInput({ msg: "chunk 42", blob: payload64kObj }),
      expected: match({ seq: okInt("42"), blob: okStr(payload64kObj) }),
    }),
    vec({
      id: "vec_large_64kib_args_005",
      description: "64 KiB-scale args record with large string argument",
      tags: ["boundary:64kib", "args:basic"],
      spec: argsSpec({
        template: "tpl_07BIG0005",
        event: "test.large.args",
        strings: ["id=", " payload=", ""],
        fields: [
          field({ id: "fld_07BIG0007", name: "id", from: { arg: 0 }, type: "int" }),
          field({ id: "fld_07BIG0008", name: "payload", from: { arg: 1 }, type: "string" }),
        ],
        sampleArgs: [1, "short"],
        sampleExpect: { id: 1, payload: "short" },
      }),
      input: argsInput(["id=", " payload=", ""], [7, payload64kArgs]),
      expected: match({ id: okInt("7"), payload: okStr(payload64kArgs) }),
    })
  );

  // ---- MULTI-FIELD ISOLATION & END-TO-END CATALOG VECTORS (8 vectors) ----
  const partialFailureTextSpec = textSpec({
    template: "tpl_07ISO0001",
    event: "test.isolation.text",
    segments: [
      { lit: "id=" },
      { hole: "id", class: "word" },
      { lit: " amt=" },
      { hole: "amt", class: "int" },
      { lit: " card=" },
      { hole: "card", class: "word" },
      { lit: " sec=" },
      { hole: "sec", class: "word" },
    ],
    fields: [
      field({ id: "fld_07ISO0001", name: "id", from: { hole: "id" }, type: "string" }),
      field({ id: "fld_07ISO0002", name: "amt", from: { hole: "amt" }, type: "int" }),
      field({ id: "fld_07ISO0003", name: "card", from: { hole: "card" }, type: "string" }),
      field({ id: "fld_07ISO0004", name: "sec", from: { hole: "sec" }, type: "string", pii: "secret", transforms: [{ op: "drop" }] }),
    ],
    sampleLine: "id=ord_1 amt=10 card=4111 sec=tok",
    sampleExpect: { id: "ord_1", amt: 10, card: "4111", sec: null },
  });

  const partialFailureObjSpec = objectSpec({
    template: "tpl_07ISO0002",
    event: "test.isolation.object",
    shape: ["id", "count", "card", "sec"],
    fields: [
      field({ id: "fld_07ISO0011", name: "id", from: { path: "id" }, type: "string" }),
      field({ id: "fld_07ISO0012", name: "count", from: { path: "count" }, type: "int" }),
      field({ id: "fld_07ISO0013", name: "opt", from: { path: "opt" }, type: "string" }),
      field({ id: "fld_07ISO0014", name: "card", from: { path: "card" }, type: "string" }),
      field({ id: "fld_07ISO0015", name: "sec", from: { path: "sec" }, type: "string", transforms: [{ op: "drop" }] }),
    ],
    sampleObject: { id: "a", count: 1, opt: "x", card: "c", sec: "s" },
    sampleExpect: { id: "a", count: 1, opt: "x", card: "c", sec: null },
  });

  const partialFailureArgsSpec = argsSpec({
    template: "tpl_07ISO0003",
    event: "test.isolation.args",
    strings: ["", " ", " ", " ", " ", ""],
    fields: [
      field({ id: "fld_07ISO0021", name: "a", from: { arg: 0 }, type: "string" }),
      field({ id: "fld_07ISO0022", name: "b", from: { arg: 1 }, type: "int" }),
      field({ id: "fld_07ISO0023", name: "c", from: { arg: 2 }, type: "string" }),
      field({ id: "fld_07ISO0024", name: "d", from: { arg: 3 }, type: "int" }),
      field({ id: "fld_07ISO0025", name: "e", from: { arg: 4 }, type: "string", transforms: [{ op: "drop" }] }),
    ],
    sampleArgs: ["ok", 1, "x", 2, "s"],
    sampleExpect: { a: "ok", b: 1, c: "x", d: 2, e: null },
  });

  const fullCatalogWithJsonSpec = textSpec({
    template: "tpl_07ALL0001",
    event: "audit.catalog.with_json",
    segments: [
      { lit: "ts=" }, { hole: "ts_raw", class: "time" },
      { lit: " id=" }, { hole: "req_uuid", class: "uuid" },
      { lit: " trace=" }, { hole: "trace_hex", class: "hex" },
      { lit: " ip=" }, { hole: "client_ip", class: "ip" },
      { lit: " user=" }, { hole: "user_email" },
      { lit: " name=" }, { hole: "full_name", class: "quoted" },
      { lit: " ratio=" }, { hole: "hit_ratio", class: "float" },
      { lit: " count=" }, { hole: "item_count", class: "int" },
      { lit: " size=" }, { hole: "size_kib", class: "int" },
      { lit: " lvl=" }, { hole: "level_raw", class: "word" },
      { lit: " secret=" }, { hole: "api_secret", class: "until" },
      { lit: " payload=" }, { hole: "extra_json", class: "json" },
      { lit: " note=" }, { hole: "free_note", class: "rest" },
    ],
    fields: [
      field({ id: "fld_07ALL0001", name: "event_time", from: { hole: "ts_raw" }, type: "timestamp", transforms: [{ op: "parse_time", format: "iso8601" }] }),
      field({ id: "fld_07ALL0002", name: "request_id", from: { hole: "req_uuid" }, type: "string", semantic: "id.request" }),
      field({ id: "fld_07ALL0003", name: "trace_id", from: { hole: "trace_hex" }, type: "string", semantic: "id.trace" }),
      field({ id: "fld_07ALL0004", name: "client_ip", from: { hole: "client_ip" }, type: "string", semantic: "ip", pii: "ip", transforms: [{ op: "mask", mode: "ip_prefix" }] }),
      field({ id: "fld_07ALL0005", name: "user_email", from: { hole: "user_email" }, type: "string", semantic: "email", pii: "email", transforms: [{ op: "lower" }, { op: "hash", kind: "email" }] }),
      field({ id: "fld_07ALL0006", name: "customer_name", from: { hole: "full_name" }, type: "string", pii: "name", transforms: [{ op: "mask", mode: "token", kind: "name" }] }),
      field({ id: "fld_07ALL0007", name: "cache_hit_pct", from: { hole: "hit_ratio" }, type: "float", semantic: "ratio", transforms: [{ op: "scale", mul: 100 }] }),
      field({ id: "fld_07ALL0008", name: "items_flag", from: { hole: "item_count" }, type: "bool", semantic: "flag", transforms: [{ op: "cast", to: "bool" }] }),
      field({ id: "fld_07ALL0009", name: "payload_bytes", from: { hole: "size_kib" }, type: "int", semantic: "bytes", unit: "B", transforms: [{ op: "unit", from: "KiB", to: "B" }] }),
      field({ id: "fld_07ALL0010", name: "severity_bucket", from: { hole: "level_raw" }, type: "enum", semantic: "version", transforms: [{ op: "lower" }, { op: "enum_map", map: { v1: "1", v2: "2" }, default: "unknown" }] }),
      field({ id: "fld_07ALL0011", name: "redacted_secret", from: { hole: "api_secret" }, type: "string", pii: "secret", transforms: [{ op: "drop" }] }),
      field({ id: "fld_07ALL0012", name: "payload_obj", from: { hole: "extra_json" }, type: "json" }),
      field({ id: "fld_07ALL0013", name: "note_text", from: { hole: "free_note" }, type: "string", pii: "free_text", transforms: [{ op: "drop" }] }),
    ],
    sampleLine: 'ts=2026-11-26T14:00:00Z id=550e8400-e29b-41d4-a716-446655440000 trace=deadbeef ip=203.0.113.42 user=Alice@Example.COM name="Alice Smith" ratio=0.75 count=1 size=4 lvl=V2 secret=tok_123 payload={"k":1} note=hello world',
    sampleExpect: {
      event_time: T_BASE,
      request_id: "550e8400-e29b-41d4-a716-446655440000",
      trace_id: "deadbeef",
      client_ip: "203.0.113.0/24",
      user_email: `<email:${hmacTag("alice@example.com")}>`,
      customer_name: null,
      cache_hit_pct: 75,
      items_flag: true,
      payload_bytes: 4096,
      severity_bucket: "2",
      redacted_secret: null,
      payload_obj: { k: 1 },
      note_text: null,
    },
  });

  const fullCatalogSqlSafeSpec = textSpec({
    template: "tpl_07ALL0002",
    event: "audit.catalog.sql_safe",
    segments: [
      { lit: "ts=" }, { hole: "ts_raw", class: "time" },
      { lit: " id=" }, { hole: "req_uuid", class: "uuid" },
      { lit: " trace=" }, { hole: "trace_hex", class: "hex" },
      { lit: " ip=" }, { hole: "client_ip", class: "ip" },
      { lit: " user=" }, { hole: "user_email" },
      { lit: " name=" }, { hole: "full_name", class: "quoted" },
      { lit: " cents=" }, { hole: "cents", class: "int" },
      { lit: " size=" }, { hole: "size_kib", class: "int" },
      { lit: " lvl=" }, { hole: "level_raw", class: "word" },
      { lit: " secret=" }, { hole: "api_secret", class: "until" },
      { lit: " note=" }, { hole: "free_note", class: "rest" },
    ],
    fields: [
      field({ id: "fld_07ALL0021", name: "event_time", from: { hole: "ts_raw" }, type: "timestamp", transforms: [{ op: "parse_time", format: "iso8601" }] }),
      field({ id: "fld_07ALL0022", name: "request_id", from: { hole: "req_uuid" }, type: "string", semantic: "id.request" }),
      field({ id: "fld_07ALL0023", name: "trace_id", from: { hole: "trace_hex" }, type: "string", semantic: "id.trace" }),
      field({ id: "fld_07ALL0024", name: "client_ip", from: { hole: "client_ip" }, type: "string", semantic: "ip", pii: "ip", transforms: [{ op: "mask", mode: "ip_prefix" }] }),
      field({ id: "fld_07ALL0025", name: "user_email", from: { hole: "user_email" }, type: "string", semantic: "email", pii: "email", transforms: [{ op: "lower" }, { op: "hash", kind: "email" }] }),
      field({ id: "fld_07ALL0026", name: "customer_name", from: { hole: "full_name" }, type: "string", pii: "name", transforms: [{ op: "mask", mode: "token", kind: "name" }] }),
      field({ id: "fld_07ALL0027", name: "amount_usd", from: { hole: "cents" }, type: "float", semantic: "money", transforms: [{ op: "scale", div: 100 }] }),
      field({ id: "fld_07ALL0028", name: "payload_bytes", from: { hole: "size_kib" }, type: "int", semantic: "bytes", unit: "B", transforms: [{ op: "unit", from: "KiB", to: "B" }] }),
      field({ id: "fld_07ALL0029", name: "severity_bucket", from: { hole: "level_raw" }, type: "enum", semantic: "version", transforms: [{ op: "lower" }, { op: "enum_map", map: { v1: "1", v2: "2" }, default: "unknown" }] }),
      field({ id: "fld_07ALL0030", name: "redacted_secret", from: { hole: "api_secret" }, type: "string", pii: "secret", transforms: [{ op: "drop" }] }),
      field({ id: "fld_07ALL0031", name: "note_text", from: { hole: "free_note" }, type: "string" }),
    ],
    sampleLine: 'ts=2026-11-26T14:00:00Z id=550e8400-e29b-41d4-a716-446655440000 trace=deadbeef ip=203.0.113.42 user=Alice@Example.COM name="Alice Smith" cents=1999 size=4 lvl=V2 secret=tok_123 note=hello world',
    sampleExpect: {
      event_time: T_BASE,
      request_id: "550e8400-e29b-41d4-a716-446655440000",
      trace_id: "deadbeef",
      client_ip: "203.0.113.0/24",
      user_email: `<email:${hmacTag("alice@example.com")}>`,
      customer_name: null,
      amount_usd: 19.99,
      payload_bytes: 4096,
      severity_bucket: "2",
      redacted_secret: null,
      note_text: "hello world",
    },
  });

  vectors.push(
    vec({
      id: "vec_multi_field_isolation_text_001",
      description: "per-field isolation in text matcher: ok, parse_error, redacted, and dropped coexist cleanly",
      tags: ["isolation", "parse_error", "redacted", "dropped"],
      spec: partialFailureTextSpec,
      input: textInput("id=ord_99 amt=9223372036854775808 card=<card> sec=ghp_abc"),
      expected: match({
        id: okStr("ord_99"),
        amt: parseErr("int_overflow"),
        card: redacted("<card>"),
        sec: dropped(),
      }),
    }),
    vec({
      id: "vec_multi_field_isolation_object_002",
      description: "per-field isolation in object matcher: ok, parse_error, missing, redacted, and dropped coexist",
      tags: ["isolation", "parse_error", "missing", "redacted", "dropped"],
      spec: partialFailureObjSpec,
      input: objectInput({ id: "u_1", count: "bad", card: "<card>", sec: "secret_val" }),
      expected: match({
        id: okStr("u_1"),
        count: parseErr("type_mismatch"),
        opt: missing(),
        card: redacted("<card>"),
        sec: dropped(),
      }),
    }),
    vec({
      id: "vec_multi_field_isolation_args_003",
      description: "per-field isolation in args matcher: ok, parse_error, missing, redacted, and dropped coexist",
      tags: ["isolation", "parse_error", "missing", "redacted", "dropped"],
      spec: partialFailureArgsSpec,
      input: argsInput(["", " ", " ", " ", " ", ""], ["ok", "bad", null, "<card>", "secret"]),
      expected: match({
        a: okStr("ok"),
        b: parseErr("type_mismatch"),
        c: missing(),
        d: redacted("<card>"),
        e: dropped(),
      }),
    }),
    vec({
      id: "vec_full_catalog_all_holes_and_transforms_sql_refused_004",
      description: "end-to-end 13-field text spec exercising all 11 hole classes and all 9 transforms (SQL-refused due to json hole)",
      tags: ["catalog:complete", "hole:json"],
      spec: fullCatalogWithJsonSpec,
      input: textInput('ts=2026-11-26T14:00:00Z id=550e8400-e29b-41d4-a716-446655440000 trace=deadbeef ip=203.0.113.42 user=Alice@Example.COM name="Alice Smith" ratio=0.75 count=1 size=4 lvl=V2 secret=tok_123 payload={"k":1} note=hello world'),
      expected: match({
        event_time: okTs(T_BASE),
        request_id: okStr("550e8400-e29b-41d4-a716-446655440000"),
        trace_id: okStr("deadbeef"),
        client_ip: okStr("203.0.113.0/24"),
        user_email: okStr(`<email:${hmacTag("alice@example.com")}>`),
        customer_name: redacted("<name>"),
        cache_hit_pct: okFloat(75),
        items_flag: okBool(true),
        payload_bytes: okInt("4096"),
        severity_bucket: okEnum("2"),
        redacted_secret: dropped(),
        payload_obj: okJson({ k: 1 }),
        note_text: dropped(),
      }),
    }),
    vec({
      id: "vec_full_catalog_sql_safe_all_non_json_holes_005",
      description: "end-to-end 11-field SQL-supported text spec exercising all 10 non-json hole classes",
      tags: ["catalog:sql_safe", "ieee754"],
      spec: fullCatalogSqlSafeSpec,
      input: textInput('ts=2026-11-26T14:00:00Z id=550e8400-e29b-41d4-a716-446655440000 trace=deadbeef ip=203.0.113.42 user=Alice@Example.COM name="Alice Smith" cents=1999 size=4 lvl=V2 secret=tok_123 note=hello world'),
      expected: match({
        event_time: okTs(T_BASE),
        request_id: okStr("550e8400-e29b-41d4-a716-446655440000"),
        trace_id: okStr("deadbeef"),
        client_ip: okStr("203.0.113.0/24"),
        user_email: okStr(`<email:${hmacTag("alice@example.com")}>`),
        customer_name: redacted("<name>"),
        amount_usd: okFloatHex("4033fd70a3d70a3d"),
        payload_bytes: okInt("4096"),
        severity_bucket: okEnum("2"),
        redacted_secret: dropped(),
        note_text: okStr("hello world"),
      }),
    }),
    vec({
      id: "vec_transform_chain_cast_unit_scale_006",
      description: "3-stage numeric chain: cast(float) -> unit(s->ms) -> scale(mul:10)",
      tags: ["transform:chain", "transform:cast", "transform:unit", "transform:scale", "ieee754"],
      spec: textSpec({
        template: "tpl_07CHN0001",
        event: "test.chain.numeric",
        segments: [{ lit: "lat=" }, { hole: "lat", class: "word" }],
        fields: [
          field({
            id: "fld_07CHN0001",
            name: "tenths_ms",
            from: { hole: "lat" },
            type: "float",
            transforms: [
              { op: "cast", to: "float" },
              { op: "unit", from: "s", to: "ms" },
              { op: "scale", mul: 10 },
            ],
          }),
        ],
        sampleLine: "lat=0.145",
        sampleExpect: { tenths_ms: 0.145 * 1000 * 10 },
      }),
      input: textInput("lat=0.145"),
      expected: match({ tenths_ms: okFloat(0.145 * 1000 * 10) }),
    }),
    vec({
      id: "vec_transform_chain_early_error_propagates_007",
      description: "early cast failure in transform chain propagates parse_error cleanly",
      tags: ["transform:chain", "parse_error"],
      spec: textSpec({
        template: "tpl_07CHN0002",
        event: "test.chain.error",
        segments: [{ lit: "lat=" }, { hole: "lat", class: "word" }],
        fields: [
          field({
            id: "fld_07CHN0002",
            name: "ms",
            from: { hole: "lat" },
            type: "float",
            transforms: [
              { op: "cast", to: "float" },
              { op: "unit", from: "s", to: "ms" },
            ],
          }),
        ],
        sampleLine: "lat=0.5",
        sampleExpect: { ms: 500 },
      }),
      input: textInput("lat=bad_float"),
      expected: match({ ms: parseErr("cast_failed") }),
    }),
    vec({
      id: "vec_reused_hole_not_present_multiple_fields_same_hole_008",
      description: "two fields binding the same hole apply independent transforms (raw and scaled)",
      tags: ["multi_field_same_hole", "transform:scale", "ieee754"],
      spec: textSpec({
        template: "tpl_07SAM0001",
        event: "order.dual_view",
        segments: [{ lit: "cents=" }, { hole: "c", class: "int" }],
        fields: [
          field({ id: "fld_07SAM0001", name: "amount_cents", from: { hole: "c" }, type: "int", semantic: "money", unit: "cents" }),
          field({ id: "fld_07SAM0002", name: "amount_usd", from: { hole: "c" }, type: "float", semantic: "money", unit: "USD", transforms: [{ op: "scale", div: 100 }] }),
        ],
        sampleLine: "cents=1999",
        sampleExpect: { amount_cents: 1999, amount_usd: 19.99 },
      }),
      input: textInput("cents=1999"),
      expected: match({
        amount_cents: okInt("1999"),
        amount_usd: okFloatHex("4033fd70a3d70a3d"),
      }),
    })
  );

  return {
    suite: "07-boundaries-unicode-adjacent-large",
    description: "Golden conformance vectors covering §5 canonical example, adjacent holes, UTF-8 non-ASCII cases (U+00A0, U+3000, combining marks, emoji), 64 KiB boundary records, and multi-field isolation.",
    vectors,
  };
}
