import {
  argsInput,
  argsSpec,
  field,
  match,
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
  textInput,
  textSpec,
  vec,
} from "../lib/vector-builders.mjs";

export function buildSuite04() {
  const vectors = [];

  // ---- CAST (18 vectors across all 5 targets: string, int, float, bool, json) ----
  const castStrFromIntSpec = textSpec({
    template: "tpl_04CAST001",
    event: "test.transform.cast",
    segments: [{ lit: "v=" }, { hole: "v", class: "int" }],
    fields: [
      field({
        id: "fld_04CAST0001",
        name: "v",
        from: { hole: "v" },
        type: "string",
        transforms: [{ op: "cast", to: "string" }],
      }),
    ],
    sampleLine: "v=42",
    sampleExpect: { v: "42" },
  });

  const castStrFromObjBoolSpec = objectSpec({
    template: "tpl_04CAST002",
    event: "test.transform.cast",
    shape: ["flag"],
    fields: [
      field({
        id: "fld_04CAST0002",
        name: "flag_str",
        from: { path: "flag" },
        type: "string",
        transforms: [{ op: "cast", to: "string" }],
      }),
    ],
    sampleObject: { flag: true },
    sampleExpect: { flag_str: "true" },
  });

  const castIntFromWordSpec = textSpec({
    template: "tpl_04CAST003",
    event: "test.transform.cast",
    segments: [{ lit: "v=" }, { hole: "v", class: "word" }],
    fields: [
      field({
        id: "fld_04CAST0003",
        name: "v",
        from: { hole: "v" },
        type: "int",
        transforms: [{ op: "cast", to: "int" }],
      }),
    ],
    sampleLine: "v=42",
    sampleExpect: { v: 42 },
  });

  const castIntFromObjBoolSpec = objectSpec({
    template: "tpl_04CAST004",
    event: "test.transform.cast",
    shape: ["ok"],
    fields: [
      field({
        id: "fld_04CAST0004",
        name: "ok_num",
        from: { path: "ok" },
        type: "int",
        transforms: [{ op: "cast", to: "int" }],
      }),
    ],
    sampleObject: { ok: true },
    sampleExpect: { ok_num: 1 },
  });

  const castFloatFromWordSpec = textSpec({
    template: "tpl_04CAST005",
    event: "test.transform.cast",
    segments: [{ lit: "v=" }, { hole: "v", class: "word" }],
    fields: [
      field({
        id: "fld_04CAST0005",
        name: "v",
        from: { hole: "v" },
        type: "float",
        transforms: [{ op: "cast", to: "float" }],
      }),
    ],
    sampleLine: "v=3.14",
    sampleExpect: { v: 3.14 },
  });

  const castBoolFromWordSpec = textSpec({
    template: "tpl_04CAST006",
    event: "test.transform.cast",
    segments: [{ lit: "v=" }, { hole: "v", class: "word" }],
    fields: [
      field({
        id: "fld_04CAST0006",
        name: "v",
        from: { hole: "v" },
        type: "bool",
        semantic: "flag",
        transforms: [{ op: "cast", to: "bool" }],
      }),
    ],
    sampleLine: "v=true",
    sampleExpect: { v: true },
  });

  const castBoolFromIntSpec = textSpec({
    template: "tpl_04CAST007",
    event: "test.transform.cast",
    segments: [{ lit: "v=" }, { hole: "v", class: "int" }],
    fields: [
      field({
        id: "fld_04CAST0007",
        name: "v",
        from: { hole: "v" },
        type: "bool",
        semantic: "flag",
        transforms: [{ op: "cast", to: "bool" }],
      }),
    ],
    sampleLine: "v=1",
    sampleExpect: { v: true },
  });

  const castJsonFromRestSpec = textSpec({
    template: "tpl_04CAST008",
    event: "test.transform.cast",
    segments: [{ lit: "j=" }, { hole: "j", class: "rest" }],
    fields: [
      field({
        id: "fld_04CAST0008",
        name: "j",
        from: { hole: "j" },
        type: "json",
        transforms: [{ op: "cast", to: "json" }],
      }),
    ],
    sampleLine: 'j={"ok":true}',
    sampleExpect: { j: { ok: true } },
  });

  vectors.push(
    vec({
      id: "vec_tr_cast_to_string_from_int_001",
      description: "cast to string converts int hole lexeme to string",
      tags: ["transform:cast", "cast:string", "type:string"],
      spec: castStrFromIntSpec,
      input: textInput("v=-42"),
      expected: match({ v: okStr("-42") }),
    }),
    vec({
      id: "vec_tr_cast_to_string_from_bool_002",
      description: "cast to string converts boolean object value to 'false'",
      tags: ["transform:cast", "cast:string", "type:string"],
      spec: castStrFromObjBoolSpec,
      input: objectInput({ flag: false }),
      expected: match({ flag_str: okStr("false") }),
    }),
    vec({
      id: "vec_tr_cast_to_int_signed_003",
      description: "cast to int parses signed integer from word hole",
      tags: ["transform:cast", "cast:int", "type:int"],
      spec: castIntFromWordSpec,
      input: textInput("v=-9007199254740993"),
      expected: match({ v: okInt("-9007199254740993") }),
    }),
    vec({
      id: "vec_tr_cast_to_int_plus_sign_004",
      description: "cast to int accepts leading + sign",
      tags: ["transform:cast", "cast:int", "type:int"],
      spec: castIntFromWordSpec,
      input: textInput("v=+100"),
      expected: match({ v: okInt("100") }),
    }),
    vec({
      id: "vec_tr_cast_to_int_from_bool_005",
      description: "cast to int converts boolean false to 0",
      tags: ["transform:cast", "cast:int", "type:int"],
      spec: castIntFromObjBoolSpec,
      input: objectInput({ ok: false }),
      expected: match({ ok_num: okInt("0") }),
    }),
    vec({
      id: "vec_tr_cast_to_int_fail_alpha_006",
      description: "cast to int fails with cast_failed on alphabetic word",
      tags: ["transform:cast", "cast:int", "parse_error"],
      spec: castIntFromWordSpec,
      input: textInput("v=not_a_num"),
      expected: match({ v: parseErr("cast_failed") }),
    }),
    vec({
      id: "vec_tr_cast_to_int_fail_overflow_007",
      description: "cast to int fails with int_overflow on INT64_MAX+1",
      tags: ["transform:cast", "cast:int", "parse_error", "boundary:int64_overflow"],
      spec: castIntFromWordSpec,
      input: textInput("v=9223372036854775808"),
      expected: match({ v: parseErr("int_overflow") }),
    }),
    vec({
      id: "vec_tr_cast_to_float_valid_008",
      description: "cast to float parses scientific notation from word hole",
      tags: ["transform:cast", "cast:float", "type:float", "ieee754"],
      spec: castFloatFromWordSpec,
      input: textInput("v=-1.25e-2"),
      expected: match({ v: okFloat(-0.0125) }),
    }),
    vec({
      id: "vec_tr_cast_to_float_fail_alpha_009",
      description: "cast to float fails with cast_failed on non-numeric string",
      tags: ["transform:cast", "cast:float", "parse_error"],
      spec: castFloatFromWordSpec,
      input: textInput("v=abc"),
      expected: match({ v: parseErr("cast_failed") }),
    }),
    vec({
      id: "vec_tr_cast_to_float_fail_nan_010",
      description: "cast to float rejects NaN with cast_failed",
      tags: ["transform:cast", "cast:float", "parse_error"],
      spec: castFloatFromWordSpec,
      input: textInput("v=NaN"),
      expected: match({ v: parseErr("cast_failed") }),
    }),
    vec({
      id: "vec_tr_cast_to_bool_upper_true_011",
      description: "cast to bool accepts uppercase TRUE",
      tags: ["transform:cast", "cast:bool", "type:bool"],
      spec: castBoolFromWordSpec,
      input: textInput("v=TRUE"),
      expected: match({ v: okBool(true) }),
    }),
    vec({
      id: "vec_tr_cast_to_bool_lower_false_012",
      description: "cast to bool accepts lowercase false",
      tags: ["transform:cast", "cast:bool", "type:bool"],
      spec: castBoolFromWordSpec,
      input: textInput("v=false"),
      expected: match({ v: okBool(false) }),
    }),
    vec({
      id: "vec_tr_cast_to_bool_int_one_013",
      description: "cast to bool converts integer 1 to true",
      tags: ["transform:cast", "cast:bool", "type:bool"],
      spec: castBoolFromIntSpec,
      input: textInput("v=1"),
      expected: match({ v: okBool(true) }),
    }),
    vec({
      id: "vec_tr_cast_to_bool_int_zero_014",
      description: "cast to bool converts integer 0 to false",
      tags: ["transform:cast", "cast:bool", "type:bool"],
      spec: castBoolFromIntSpec,
      input: textInput("v=0"),
      expected: match({ v: okBool(false) }),
    }),
    vec({
      id: "vec_tr_cast_to_bool_fail_two_015",
      description: "cast to bool rejects integer 2 with cast_failed",
      tags: ["transform:cast", "cast:bool", "parse_error"],
      spec: castBoolFromIntSpec,
      input: textInput("v=2"),
      expected: match({ v: parseErr("cast_failed") }),
    }),
    vec({
      id: "vec_tr_cast_to_bool_fail_word_016",
      description: "cast to bool rejects 'maybe' with cast_failed",
      tags: ["transform:cast", "cast:bool", "parse_error"],
      spec: castBoolFromWordSpec,
      input: textInput("v=maybe"),
      expected: match({ v: parseErr("cast_failed") }),
    }),
    vec({
      id: "vec_tr_cast_to_json_valid_017",
      description: "cast to json parses JSON array from rest hole (SQL-supported, no json hole)",
      tags: ["transform:cast", "cast:json", "type:json"],
      spec: castJsonFromRestSpec,
      input: textInput('j=[1,"two",{"a":false}]'),
      expected: match({ j: okJson([1, "two", { a: false }]) }),
    }),
    vec({
      id: "vec_tr_cast_to_json_fail_invalid_018",
      description: "cast to json returns invalid_json parse_error on malformed JSON string",
      tags: ["transform:cast", "cast:json", "parse_error"],
      spec: castJsonFromRestSpec,
      input: textInput("j={not valid json}"),
      expected: match({ j: parseErr("invalid_json") }),
    })
  );

  // ---- SCALE (16 vectors — IEEE-754 single-op bit-exact pinning!) ----
  const scaleDivSpec = (div, suffix, outType = "float") =>
    textSpec({
      template: `tpl_04SCAL${suffix}`,
      event: "test.transform.scale",
      segments: [{ lit: "n=" }, { hole: "n", class: "int" }],
      fields: [
        field({
          id: `fld_04SC${suffix}`,
          name: "v",
          from: { hole: "n" },
          type: outType,
          semantic: "money",
          transforms: [{ op: "scale", div }],
        }),
      ],
      sampleLine: `n=${div * 2}`,
      sampleExpect: { v: 2 },
    });

  const scaleMulSpec = (mul, suffix, holeCls = "int", outType = "float") =>
    textSpec({
      template: `tpl_04SCAM${suffix}`,
      event: "test.transform.scale",
      segments: [{ lit: "n=" }, { hole: "n", class: holeCls }],
      fields: [
        field({
          id: `fld_04SM${suffix}`,
          name: "v",
          from: { hole: "n" },
          type: outType,
          semantic: "ratio",
          transforms: [{ op: "scale", mul }],
        }),
      ],
      sampleLine: "n=2",
      sampleExpect: { v: 2 * mul },
    });

  vectors.push(
    vec({
      id: "vec_tr_scale_div_1999_by_100_ieee754_001",
      description: "canonical IEEE-754 pin: 1999 / 100 = 19.99 (4033fd70a3d70a3d, NOT 1999 * 0.01)",
      tags: ["transform:scale", "ieee754", "section5:canonical"],
      spec: scaleDivSpec(100, "0001"),
      input: textInput("n=1999"),
      expected: match({ v: okFloatHex("4033fd70a3d70a3d") }),
    }),
    vec({
      id: "vec_tr_scale_div_57_by_100_ieee754_002",
      description: "IEEE-754 pin: 57 / 100 = 0.57 (3fe23d70a3d70a3d, differs from 57 * 0.01)",
      tags: ["transform:scale", "ieee754"],
      spec: scaleDivSpec(100, "0002"),
      input: textInput("n=57"),
      expected: match({ v: okFloatHex("3fe23d70a3d70a3d") }),
    }),
    vec({
      id: "vec_tr_scale_div_115_by_100_ieee754_003",
      description: "IEEE-754 pin: 115 / 100 = 1.15 (3ff2666666666666, differs from 115 * 0.01)",
      tags: ["transform:scale", "ieee754"],
      spec: scaleDivSpec(100, "0003"),
      input: textInput("n=115"),
      expected: match({ v: okFloatHex("3ff2666666666666") }),
    }),
    vec({
      id: "vec_tr_scale_div_251_by_100_ieee754_004",
      description: "IEEE-754 pin: 251 / 100 = 2.51 (4004147ae147ae14, differs from 251 * 0.01)",
      tags: ["transform:scale", "ieee754"],
      spec: scaleDivSpec(100, "0004"),
      input: textInput("n=251"),
      expected: match({ v: okFloatHex("4004147ae147ae14") }),
    }),
    vec({
      id: "vec_tr_scale_div_1001_by_1000_ieee754_005",
      description: "IEEE-754 pin: 1001 / 1000 = 1.001 (3ff004189374bc6a, differs from 1001 * 0.001)",
      tags: ["transform:scale", "ieee754"],
      spec: scaleDivSpec(1000, "0005"),
      input: textInput("n=1001"),
      expected: match({ v: okFloatHex("3ff004189374bc6a") }),
    }),
    vec({
      id: "vec_tr_scale_div_3_by_10_ieee754_006",
      description: "IEEE-754 pin: 3 / 10 = 0.3 (3fd3333333333333, differs from 3 * 0.1)",
      tags: ["transform:scale", "ieee754"],
      spec: scaleDivSpec(10, "0006"),
      input: textInput("n=3"),
      expected: match({ v: okFloatHex("3fd3333333333333") }),
    }),
    vec({
      id: "vec_tr_scale_div_negative_input_007",
      description: "scale div handles negative input -1999 / 100 = -19.99",
      tags: ["transform:scale", "ieee754", "boundary:negative"],
      spec: scaleDivSpec(100, "0007"),
      input: textInput("n=-1999"),
      expected: match({ v: okFloatHex("c033fd70a3d70a3d") }),
    }),
    vec({
      id: "vec_tr_scale_div_negative_divisor_008",
      description: "scale div handles negative integer divisor 1999 / -100",
      tags: ["transform:scale", "ieee754", "boundary:negative"],
      spec: scaleDivSpec(-100, "0008"),
      input: textInput("n=1999"),
      expected: match({ v: okFloatHex("c033fd70a3d70a3d") }),
    }),
    vec({
      id: "vec_tr_scale_div_zero_009",
      description: "scale div on zero yields +0.0",
      tags: ["transform:scale", "ieee754", "boundary:zero"],
      spec: scaleDivSpec(100, "0009"),
      input: textInput("n=0"),
      expected: match({ v: okFloatHex("0000000000000000") }),
    }),
    vec({
      id: "vec_tr_scale_mul_int_by_100_010",
      description: "scale mul multiplies integer 1999 by 100",
      tags: ["transform:scale", "ieee754"],
      spec: scaleMulSpec(100, "0010"),
      input: textInput("n=1999"),
      expected: match({ v: okFloat(199900) }),
    }),
    vec({
      id: "vec_tr_scale_mul_float_ratio_011",
      description: "scale mul converts float ratio 0.75 * 100 = 75.0",
      tags: ["transform:scale", "ieee754"],
      spec: scaleMulSpec(100, "0011", "float", "float"),
      input: textInput("n=0.75"),
      expected: match({ v: okFloat(75) }),
    }),
    vec({
      id: "vec_tr_scale_mul_negate_012",
      description: "scale mul by -1 negates value",
      tags: ["transform:scale", "boundary:negative"],
      spec: scaleMulSpec(-1, "0012", "int", "int"),
      input: textInput("n=-42"),
      expected: match({ v: okInt("42") }),
    }),
    vec({
      id: "vec_tr_scale_exact_int_output_013",
      description: "scale div producing exact integer populates int field",
      tags: ["transform:scale", "type:int"],
      spec: scaleDivSpec(1000, "0013", "int"),
      input: textInput("n=42000"),
      expected: match({ v: okInt("42") }),
    }),
    vec({
      id: "vec_tr_scale_chained_mul_then_div_014",
      description: "chained scale mul:3 then div:2 evaluates left-to-right in double arithmetic",
      tags: ["transform:scale", "transform:chain", "ieee754"],
      spec: textSpec({
        template: "tpl_04SCAC014",
        event: "test.transform.scale_chain",
        segments: [{ lit: "n=" }, { hole: "n", class: "int" }],
        fields: [
          field({
            id: "fld_04SC0014",
            name: "v",
            from: { hole: "n" },
            type: "float",
            transforms: [
              { op: "scale", mul: 3 },
              { op: "scale", div: 2 },
            ],
          }),
        ],
        sampleLine: "n=7",
        sampleExpect: { v: 10.5 },
      }),
      input: textInput("n=7"),
      expected: match({ v: okFloat((7 * 3) / 2) }),
    }),
    vec({
      id: "vec_tr_scale_overflow_015",
      description: "scale mul overflowing finite float64 reports float_overflow parse_error",
      tags: ["transform:scale", "parse_error", "boundary:float64_overflow"],
      spec: scaleMulSpec(10, "0015", "float", "float"),
      input: textInput("n=1e308"),
      expected: match({ v: parseErr("float_overflow") }),
    }),
    vec({
      id: "vec_tr_scale_non_numeric_object_016",
      description: "scale on non-numeric object value produces type_mismatch parse_error",
      tags: ["transform:scale", "parse_error"],
      spec: objectSpec({
        template: "tpl_04SCAL016",
        event: "test.transform.scale_obj",
        shape: ["cents"],
        fields: [
          field({
            id: "fld_04SC0016",
            name: "usd",
            from: { path: "cents" },
            type: "float",
            transforms: [{ op: "scale", div: 100 }],
          }),
        ],
        sampleObject: { cents: 1999 },
        sampleExpect: { usd: 19.99 },
      }),
      input: objectInput({ cents: "not-a-number" }),
      expected: match({ usd: parseErr("type_mismatch") }),
    })
  );

  // ---- UNIT (22 vectors — ALL 7 time units + ALL 9 byte units!) ----
  const unitVec = ({ id, desc, from, to, raw, outType = "float", expectedVal, extraTags = [] }) => {
    const holeCls = String(raw).includes(".") ? "float" : "int";
    const spec = textSpec({
      template: `tpl_04U${id.slice(-3).toUpperCase()}`,
      event: "test.transform.unit",
      segments: [{ lit: "v=" }, { hole: "v", class: holeCls }],
      fields: [
        field({
          id: `fld_04U${id.slice(-3).toUpperCase()}`,
          name: "v",
          from: { hole: "v" },
          type: outType,
          unit: to,
          transforms: [{ op: "unit", from, to }],
        }),
      ],
      sampleLine: `v=${raw}`,
      sampleExpect: { v: outType === "int" ? Number(expectedVal) : expectedVal },
    });
    return vec({
      id,
      description: desc,
      tags: ["transform:unit", `unit:${from.toLowerCase()}_to_${to.toLowerCase()}`, ...extraTags],
      spec,
      input: textInput(`v=${raw}`),
      expected: match({ v: outType === "int" ? okInt(expectedVal) : okFloat(expectedVal) }),
    });
  };

  vectors.push(
    // Time units: ns, us, ms, s, m, h, d
    unitVec({ id: "vec_tr_unit_time_ns_to_ms_001", desc: "unit converts ns to ms", from: "ns", to: "ms", raw: "1500000", expectedVal: 1.5, extraTags: ["unit:time"] }),
    unitVec({ id: "vec_tr_unit_time_us_to_ms_002", desc: "unit converts us to ms", from: "us", to: "ms", raw: "2500", expectedVal: 2.5, extraTags: ["unit:time"] }),
    unitVec({ id: "vec_tr_unit_time_ms_to_s_003", desc: "unit converts ms to s", from: "ms", to: "s", raw: "1500", expectedVal: 1.5, extraTags: ["unit:time"] }),
    unitVec({ id: "vec_tr_unit_time_s_to_ms_004", desc: "unit converts float seconds 0.145s to 145ms", from: "s", to: "ms", raw: "0.145", expectedVal: 0.145 * 1000, extraTags: ["unit:time", "ieee754"] }),
    unitVec({ id: "vec_tr_unit_time_s_to_m_005", desc: "unit converts s to m", from: "s", to: "m", raw: "90", expectedVal: 1.5, extraTags: ["unit:time"] }),
    unitVec({ id: "vec_tr_unit_time_m_to_h_006", desc: "unit converts m to h", from: "m", to: "h", raw: "90", expectedVal: 1.5, extraTags: ["unit:time"] }),
    unitVec({ id: "vec_tr_unit_time_h_to_d_007", desc: "unit converts h to d", from: "h", to: "d", raw: "36", expectedVal: 1.5, extraTags: ["unit:time"] }),
    unitVec({ id: "vec_tr_unit_time_d_to_s_008", desc: "unit converts d to s as int", from: "d", to: "s", raw: "2", outType: "int", expectedVal: "172800", extraTags: ["unit:time"] }),
    unitVec({ id: "vec_tr_unit_time_h_to_ms_009", desc: "unit converts h to ms as int", from: "h", to: "ms", raw: "1", outType: "int", expectedVal: "3600000", extraTags: ["unit:time"] }),
    unitVec({ id: "vec_tr_unit_time_ms_to_us_010", desc: "unit converts ms to us as int", from: "ms", to: "us", raw: "5", outType: "int", expectedVal: "5000", extraTags: ["unit:time"] }),
    unitVec({ id: "vec_tr_unit_time_us_to_ns_011", desc: "unit converts us to ns as int", from: "us", to: "ns", raw: "7", outType: "int", expectedVal: "7000", extraTags: ["unit:time"] }),
    unitVec({ id: "vec_tr_unit_time_identity_012", desc: "unit identity ms to ms preserves exact value", from: "ms", to: "ms", raw: "42", outType: "int", expectedVal: "42", extraTags: ["unit:time"] }),
    // Byte units: B, KB, MB, GB, TB, KiB, MiB, GiB, TiB
    unitVec({ id: "vec_tr_unit_bytes_kb_to_b_013", desc: "unit converts decimal KB to B", from: "KB", to: "B", raw: "4", outType: "int", expectedVal: "4000", extraTags: ["unit:bytes"] }),
    unitVec({ id: "vec_tr_unit_bytes_mb_to_kb_014", desc: "unit converts decimal MB to KB", from: "MB", to: "KB", raw: "3", outType: "int", expectedVal: "3000", extraTags: ["unit:bytes"] }),
    unitVec({ id: "vec_tr_unit_bytes_gb_to_mb_015", desc: "unit converts decimal GB to MB", from: "GB", to: "MB", raw: "2", outType: "int", expectedVal: "2000", extraTags: ["unit:bytes"] }),
    unitVec({ id: "vec_tr_unit_bytes_tb_to_gb_016", desc: "unit converts decimal TB to GB", from: "TB", to: "GB", raw: "5", outType: "int", expectedVal: "5000", extraTags: ["unit:bytes"] }),
    unitVec({ id: "vec_tr_unit_bytes_b_to_kb_017", desc: "unit converts B to decimal KB", from: "B", to: "KB", raw: "1500", expectedVal: 1.5, extraTags: ["unit:bytes"] }),
    unitVec({ id: "vec_tr_unit_bytes_kib_to_b_018", desc: "unit converts binary KiB to B", from: "KiB", to: "B", raw: "4", outType: "int", expectedVal: "4096", extraTags: ["unit:bytes"] }),
    unitVec({ id: "vec_tr_unit_bytes_mib_to_kib_019", desc: "unit converts binary MiB to KiB", from: "MiB", to: "KiB", raw: "2", outType: "int", expectedVal: "2048", extraTags: ["unit:bytes"] }),
    unitVec({ id: "vec_tr_unit_bytes_gib_to_mib_020", desc: "unit converts binary GiB to MiB", from: "GiB", to: "MiB", raw: "3", outType: "int", expectedVal: "3072", extraTags: ["unit:bytes"] }),
    unitVec({ id: "vec_tr_unit_bytes_tib_to_gib_021", desc: "unit converts binary TiB to GiB", from: "TiB", to: "GiB", raw: "2", outType: "int", expectedVal: "2048", extraTags: ["unit:bytes"] }),
    unitVec({ id: "vec_tr_unit_bytes_kib_to_kb_cross_022", desc: "unit converts cross-base KiB to decimal KB (1000 KiB = 1024 KB)", from: "KiB", to: "KB", raw: "1000", expectedVal: 1024, extraTags: ["unit:bytes", "ambiguity:unit_cross_base"] })
  );

  // ---- PARSE_TIME (21 vectors — ALL 10 formats!) ----
  const ptSpec = (format, suffix, sampleRaw, sampleMs) => {
    const tr = format === undefined ? { op: "parse_time" } : { op: "parse_time", format };
    return textSpec({
      template: `tpl_04PT${suffix}`,
      event: "test.transform.parse_time",
      segments: [{ lit: "ts=" }, { hole: "ts", class: "rest" }],
      fields: [
        field({
          id: `fld_04PT${suffix}`,
          name: "ts",
          from: { hole: "ts" },
          type: "timestamp",
          transforms: [tr],
        }),
      ],
      sampleLine: `ts=${sampleRaw}`,
      sampleExpect: { ts: sampleMs },
    });
  };

  const T_BASE = Date.UTC(2026, 10, 26, 14, 0, 0, 0); // 1795701600000

  vectors.push(
    vec({
      id: "vec_tr_parse_time_default_auto_iso_001",
      description: "parse_time with omitted format defaults to auto and parses ISO 8601 UTC",
      tags: ["transform:parse_time", "parse_time:auto", "type:timestamp"],
      spec: ptSpec(undefined, "0001", "2026-11-26T14:00:00Z", T_BASE),
      input: textInput("ts=2026-11-26T14:00:00Z"),
      expected: match({ ts: okTs(T_BASE) }),
    }),
    vec({
      id: "vec_tr_parse_time_explicit_auto_apache_002",
      description: "parse_time format:auto parses Apache timestamp",
      tags: ["transform:parse_time", "parse_time:auto", "type:timestamp"],
      spec: ptSpec("auto", "0002", "26/Nov/2026:14:00:00 +0000", T_BASE),
      input: textInput("ts=26/Nov/2026:14:00:00 +0000"),
      expected: match({ ts: okTs(T_BASE) }),
    }),
    vec({
      id: "vec_tr_parse_time_iso8601_ms_003",
      description: "parse_time format:iso8601 preserves millisecond precision",
      tags: ["transform:parse_time", "parse_time:iso8601", "type:timestamp"],
      spec: ptSpec("iso8601", "0003", "2026-11-26T14:00:00.123Z", T_BASE + 123),
      input: textInput("ts=2026-11-26T14:00:00.123Z"),
      expected: match({ ts: okTs(T_BASE + 123) }),
    }),
    vec({
      id: "vec_tr_parse_time_iso8601_ns_truncate_004",
      description: "parse_time format:iso8601 truncates sub-millisecond nanoseconds to ms",
      tags: ["transform:parse_time", "parse_time:iso8601", "ambiguity:subms_truncation"],
      spec: ptSpec("iso8601", "0004", "2026-11-26T14:00:00.999999999Z", T_BASE + 999),
      input: textInput("ts=2026-11-26T14:00:00.999999999Z"),
      expected: match({ ts: okTs(T_BASE + 999) }),
    }),
    vec({
      id: "vec_tr_parse_time_iso8601_neg_offset_005",
      description: "parse_time format:iso8601 adjusts -05:00 offset to UTC epoch ms",
      tags: ["transform:parse_time", "parse_time:iso8601", "type:timestamp"],
      spec: ptSpec("iso8601", "0005", "2026-11-26T09:00:00-05:00", T_BASE),
      input: textInput("ts=2026-11-26T09:00:00-05:00"),
      expected: match({ ts: okTs(T_BASE) }),
    }),
    vec({
      id: "vec_tr_parse_time_rfc3339_pos_offset_006",
      description: "parse_time format:rfc3339 adjusts +05:30 offset with fractional seconds",
      tags: ["transform:parse_time", "parse_time:rfc3339", "type:timestamp"],
      spec: ptSpec("rfc3339", "0006", "2026-11-26T19:30:00.500+05:30", T_BASE + 500),
      input: textInput("ts=2026-11-26T19:30:00.500+05:30"),
      expected: match({ ts: okTs(T_BASE + 500) }),
    }),
    vec({
      id: "vec_tr_parse_time_rfc2822_utc_007",
      description: "parse_time format:rfc2822 parses email/HTTP date with +0000",
      tags: ["transform:parse_time", "parse_time:rfc2822", "type:timestamp"],
      spec: ptSpec("rfc2822", "0007", "Thu, 26 Nov 2026 14:00:00 +0000", T_BASE),
      input: textInput("ts=Thu, 26 Nov 2026 14:00:00 +0000"),
      expected: match({ ts: okTs(T_BASE) }),
    }),
    vec({
      id: "vec_tr_parse_time_rfc2822_offset_008",
      description: "parse_time format:rfc2822 adjusts -0500 offset to UTC",
      tags: ["transform:parse_time", "parse_time:rfc2822", "type:timestamp"],
      spec: ptSpec("rfc2822", "0008", "Thu, 26 Nov 2026 09:00:00 -0500", T_BASE),
      input: textInput("ts=Thu, 26 Nov 2026 09:00:00 -0500"),
      expected: match({ ts: okTs(T_BASE) }),
    }),
    vec({
      id: "vec_tr_parse_time_syslog_rfc5424_009",
      description: "parse_time format:syslog parses RFC 5424 ISO timestamp",
      tags: ["transform:parse_time", "parse_time:syslog", "type:timestamp"],
      spec: ptSpec("syslog", "0009", "2026-11-26T14:00:00Z", T_BASE),
      input: textInput("ts=2026-11-26T14:00:00Z"),
      expected: match({ ts: okTs(T_BASE) }),
    }),
    vec({
      id: "vec_tr_parse_time_syslog_rfc3164_ref_year_010",
      description: "parse_time format:syslog resolves yearless RFC 3164 using UTC year of reference_ts_ms",
      tags: ["transform:parse_time", "parse_time:syslog", "ambiguity:syslog_rfc3164_year"],
      spec: ptSpec("syslog", "0010", "Nov 26 14:00:00", T_BASE),
      input: textInput("ts=Nov 26 14:00:00"),
      expected: match({ ts: okTs(T_BASE) }),
    }),
    vec({
      id: "vec_tr_parse_time_apache_offset_011",
      description: "parse_time format:apache adjusts -0500 offset to UTC",
      tags: ["transform:parse_time", "parse_time:apache", "type:timestamp"],
      spec: ptSpec("apache", "0011", "26/Nov/2026:09:00:00 -0500", T_BASE),
      input: textInput("ts=26/Nov/2026:09:00:00 -0500"),
      expected: match({ ts: okTs(T_BASE) }),
    }),
    vec({
      id: "vec_tr_parse_time_unix_s_012",
      description: "parse_time format:unix_s converts integer epoch seconds to ms",
      tags: ["transform:parse_time", "parse_time:unix_s", "type:timestamp"],
      spec: ptSpec("unix_s", "0012", "1795701600", T_BASE),
      input: textInput("ts=1795701600"),
      expected: match({ ts: okTs(T_BASE) }),
    }),
    vec({
      id: "vec_tr_parse_time_unix_s_fractional_013",
      description: "parse_time format:unix_s converts fractional epoch seconds to ms",
      tags: ["transform:parse_time", "parse_time:unix_s", "type:timestamp"],
      spec: ptSpec("unix_s", "0013", "1795701600.25", T_BASE + 250),
      input: textInput("ts=1795701600.25"),
      expected: match({ ts: okTs(T_BASE + 250) }),
    }),
    vec({
      id: "vec_tr_parse_time_unix_ms_014",
      description: "parse_time format:unix_ms preserves epoch milliseconds",
      tags: ["transform:parse_time", "parse_time:unix_ms", "type:timestamp"],
      spec: ptSpec("unix_ms", "0014", "1795701600123", T_BASE + 123),
      input: textInput("ts=1795701600123"),
      expected: match({ ts: okTs(T_BASE + 123) }),
    }),
    vec({
      id: "vec_tr_parse_time_unix_us_015",
      description: "parse_time format:unix_us truncates epoch microseconds to ms",
      tags: ["transform:parse_time", "parse_time:unix_us", "type:timestamp"],
      spec: ptSpec("unix_us", "0015", "1795701600123456", T_BASE + 123),
      input: textInput("ts=1795701600123456"),
      expected: match({ ts: okTs(T_BASE + 123) }),
    }),
    vec({
      id: "vec_tr_parse_time_unix_ns_016",
      description: "parse_time format:unix_ns truncates epoch nanoseconds to ms",
      tags: ["transform:parse_time", "parse_time:unix_ns", "type:timestamp"],
      spec: ptSpec("unix_ns", "0016", "1795701600123456789", T_BASE + 123),
      input: textInput("ts=1795701600123456789"),
      expected: match({ ts: okTs(T_BASE + 123) }),
    }),
    vec({
      id: "vec_tr_parse_time_fail_invalid_calendar_date_017",
      description: "parse_time rejects impossible date 2026-02-30 with invalid_time parse_error",
      tags: ["transform:parse_time", "parse_error"],
      spec: ptSpec("iso8601", "0017", "2026-11-26T14:00:00Z", T_BASE),
      input: textInput("ts=2026-02-30T14:00:00Z"),
      expected: match({ ts: parseErr("invalid_time") }),
    }),
    vec({
      id: "vec_tr_parse_time_fail_format_mismatch_018",
      description: "parse_time format:iso8601 rejects Apache formatted string with invalid_time",
      tags: ["transform:parse_time", "parse_error"],
      spec: ptSpec("iso8601", "0018", "2026-11-26T14:00:00Z", T_BASE),
      input: textInput("ts=26/Nov/2026:14:00:00 +0000"),
      expected: match({ ts: parseErr("invalid_time") }),
    }),
    vec({
      id: "vec_tr_parse_time_unix_s_exact_decimal_019",
      description: "parse_time format:unix_s parses '1.001' via exact decimal arithmetic to 1001 ms (not binary64 1000)",
      tags: ["transform:parse_time", "parse_time:unix_s", "type:timestamp", "ambiguity:unix_s_exact_decimal"],
      spec: ptSpec("unix_s", "0019", "1.001", 1001),
      input: textInput("ts=1.001"),
      expected: match({ ts: okTs(1001) }),
    }),
    vec({
      id: "vec_tr_parse_time_unix_s_negative_subms_020",
      description: "parse_time format:unix_s truncates negative sub-millisecond fraction '-1.0019' toward zero to -1001 ms",
      tags: ["transform:parse_time", "parse_time:unix_s", "boundary:negative", "ambiguity:unix_s_exact_decimal", "ambiguity:subms_truncation"],
      spec: ptSpec("unix_s", "0020", "-1.0019", -1001),
      input: textInput("ts=-1.0019"),
      expected: match({ ts: okTs(-1001) }),
    }),
    vec({
      id: "vec_tr_parse_time_fail_offsetless_iso_021",
      description: "parse_time format:iso8601 rejects offset-less timestamp without Z or numeric offset",
      tags: ["transform:parse_time", "parse_time:iso8601", "parse_error", "ambiguity:offsetless_time"],
      spec: ptSpec("iso8601", "0021", "2026-11-26T14:00:00Z", T_BASE),
      input: textInput("ts=2026-11-26T14:00:00"),
      expected: match({ ts: parseErr("invalid_time") }),
    }),
    vec({
      id: "vec_tr_parse_time_iso8601_compact_offset_022",
      description: "parse_time format:iso8601 adjusts compact -0500 offset to UTC epoch ms",
      tags: ["transform:parse_time", "parse_time:iso8601", "type:timestamp", "time:compact_offset"],
      spec: ptSpec("iso8601", "0022", "2026-11-26T09:00:00-0500", T_BASE),
      input: textInput("ts=2026-11-26T09:00:00-0500"),
      expected: match({ ts: okTs(T_BASE) }),
    }),
    vec({
      id: "vec_tr_parse_time_unix_s_float_hole_exact_decimal_023",
      description: "float hole feeding direct parse_time(unix_s) preserves original decimal lexeme 1795701600.12399999 without binary64 rounding",
      tags: ["hole:float", "transform:parse_time", "parse_time:unix_s", "type:timestamp", "ambiguity:unix_s_exact_decimal", "ambiguity:subms_truncation"],
      spec: textSpec({
        template: "tpl_04PT0023",
        event: "test.transform.parse_time",
        segments: [{ lit: "ts=" }, { hole: "ts", class: "float" }],
        fields: [
          field({
            id: "fld_04PT0023",
            name: "ts",
            from: { hole: "ts" },
            type: "timestamp",
            transforms: [{ op: "parse_time", format: "unix_s" }],
          }),
        ],
        sampleLine: "ts=1795701600.12399999",
        sampleExpect: { ts: T_BASE + 123 },
      }),
      input: textInput("ts=1795701600.12399999"),
      expected: match({ ts: okTs(T_BASE + 123) }),
    }),
    vec({
      id: "vec_tr_parse_time_unix_s_float_hole_zero_padded_pos_exp_024",
      description: "float hole feeding direct parse_time(unix_s) handles bounded zero-padded positive exponent 1e+000000002",
      tags: ["hole:float", "transform:parse_time", "parse_time:unix_s", "type:timestamp", "ambiguity:unix_s_exact_decimal"],
      spec: textSpec({
        template: "tpl_04PT0024",
        event: "test.transform.parse_time",
        segments: [{ lit: "ts=" }, { hole: "ts", class: "float" }],
        fields: [
          field({
            id: "fld_04PT0024",
            name: "ts",
            from: { hole: "ts" },
            type: "timestamp",
            transforms: [{ op: "parse_time", format: "unix_s" }],
          }),
        ],
        sampleLine: "ts=1e+000000002",
        sampleExpect: { ts: 100000 },
      }),
      input: textInput("ts=1e+000000002"),
      expected: match({ ts: okTs(100000) }),
    }),
    vec({
      id: "vec_tr_parse_time_unix_s_float_hole_zero_padded_neg_exp_025",
      description: "float hole feeding direct parse_time(unix_s) handles bounded zero-padded negative exponent 1e-000000002",
      tags: ["hole:float", "transform:parse_time", "parse_time:unix_s", "type:timestamp", "ambiguity:unix_s_exact_decimal"],
      spec: textSpec({
        template: "tpl_04PT0025",
        event: "test.transform.parse_time",
        segments: [{ lit: "ts=" }, { hole: "ts", class: "float" }],
        fields: [
          field({
            id: "fld_04PT0025",
            name: "ts",
            from: { hole: "ts" },
            type: "timestamp",
            transforms: [{ op: "parse_time", format: "unix_s" }],
          }),
        ],
        sampleLine: "ts=1e-000000002",
        sampleExpect: { ts: 10 },
      }),
      input: textInput("ts=1e-000000002"),
      expected: match({ ts: okTs(10) }),
    }),
    vec({
      id: "vec_tr_parse_time_unix_s_float_hole_zero_padded_zero_exp_026",
      description: "float hole feeding direct parse_time(unix_s) handles bounded zero-padded zero exponent 1.25e000000000",
      tags: ["hole:float", "transform:parse_time", "parse_time:unix_s", "type:timestamp", "ambiguity:unix_s_exact_decimal"],
      spec: textSpec({
        template: "tpl_04PT0026",
        event: "test.transform.parse_time",
        segments: [{ lit: "ts=" }, { hole: "ts", class: "float" }],
        fields: [
          field({
            id: "fld_04PT0026",
            name: "ts",
            from: { hole: "ts" },
            type: "timestamp",
            transforms: [{ op: "parse_time", format: "unix_s" }],
          }),
        ],
        sampleLine: "ts=1.25e000000000",
        sampleExpect: { ts: 1250 },
      }),
      input: textInput("ts=1.25e000000000"),
      expected: match({ ts: okTs(1250) }),
    })
  );

  // ---- LOWER & ENUM_MAP (13 vectors) ----
  const lowerSpec = textSpec({
    template: "tpl_04LOWR001",
    event: "test.transform.lower",
    segments: [{ lit: "v=" }, { hole: "v", class: "rest" }],
    fields: [
      field({
        id: "fld_04LOW0001",
        name: "v",
        from: { hole: "v" },
        type: "string",
        transforms: [{ op: "lower" }],
      }),
    ],
    sampleLine: "v=Hello",
    sampleExpect: { v: "hello" },
  });

  const enumDefaultSpec = textSpec({
    template: "tpl_04ENUM001",
    event: "test.transform.enum_map",
    segments: [{ lit: "m=" }, { hole: "m", class: "word" }],
    fields: [
      field({
        id: "fld_04ENU0001",
        name: "method",
        from: { hole: "m" },
        type: "enum",
        semantic: "http.method",
        transforms: [{ op: "enum_map", map: { get: "GET", post: "POST" }, default: "OTHER" }],
      }),
    ],
    sampleLine: "m=get",
    sampleExpect: { method: "GET" },
  });

  const enumStrictSpec = textSpec({
    template: "tpl_04ENUM002",
    event: "test.transform.enum_map_strict",
    segments: [{ lit: "m=" }, { hole: "m", class: "word" }],
    fields: [
      field({
        id: "fld_04ENU0002",
        name: "method",
        from: { hole: "m" },
        type: "enum",
        semantic: "http.method",
        transforms: [{ op: "enum_map", map: { get: "GET", post: "POST" } }],
      }),
    ],
    sampleLine: "m=post",
    sampleExpect: { method: "POST" },
  });

  const lowerEnumSpec = textSpec({
    template: "tpl_04ENUM003",
    event: "test.transform.lower_enum",
    segments: [{ lit: "m=" }, { hole: "m", class: "word" }],
    fields: [
      field({
        id: "fld_04ENU0003",
        name: "method",
        from: { hole: "m" },
        type: "enum",
        semantic: "http.method",
        transforms: [
          { op: "lower" },
          { op: "enum_map", map: { get: "GET", post: "POST", delete: "DELETE" }, default: "OTHER" },
        ],
      }),
    ],
    sampleLine: "m=POST",
    sampleExpect: { method: "POST" },
  });

  const enumFromIntSpec = argsSpec({
    template: "tpl_04ENUM004",
    event: "test.transform.enum_args",
    strings: ["status=", ""],
    fields: [
      field({
        id: "fld_04ENU0004",
        name: "bucket",
        from: { arg: 0 },
        type: "enum",
        semantic: "http.status",
        transforms: [
          { op: "cast", to: "string" },
          { op: "enum_map", map: { "200": "ok", "404": "not_found", "500": "error" }, default: "other" },
        ],
      }),
    ],
    sampleArgs: [200],
    sampleExpect: { bucket: "ok" },
  });

  vectors.push(
    vec({
      id: "vec_tr_lower_ascii_mixed_001",
      description: "lower converts ASCII uppercase letters to lowercase",
      tags: ["transform:lower", "type:string"],
      spec: lowerSpec,
      input: textInput("v=Alice@Example.COM"),
      expected: match({ v: okStr("alice@example.com") }),
    }),
    vec({
      id: "vec_tr_lower_already_lower_digits_002",
      description: "lower leaves digits, punctuation, and lowercase ASCII unchanged",
      tags: ["transform:lower", "type:string"],
      spec: lowerSpec,
      input: textInput("v=v1.2.3-rc_0"),
      expected: match({ v: okStr("v1.2.3-rc_0") }),
    }),
    vec({
      id: "vec_tr_lower_empty_003",
      description: "lower handles empty string",
      tags: ["transform:lower", "boundary:empty"],
      spec: lowerSpec,
      input: textInput("v="),
      expected: match({ v: okStr("") }),
    }),
    vec({
      id: "vec_tr_lower_unicode_utf8_004",
      description: "lower folds Unicode UTF-8 uppercase characters (CAFÉ -> café)",
      tags: ["transform:lower", "unicode", "ambiguity:lower_unicode"],
      spec: lowerSpec,
      input: textInput("v=CAF\u00c9 \u00dcBER"),
      expected: match({ v: okStr("caf\u00e9 \u00fcber") }),
    }),
    vec({
      id: "vec_tr_enum_map_hit_005",
      description: "enum_map maps exact matching raw value to canonical enum label",
      tags: ["transform:enum_map", "type:enum"],
      spec: enumDefaultSpec,
      input: textInput("m=post"),
      expected: match({ method: okEnum("POST") }),
    }),
    vec({
      id: "vec_tr_enum_map_case_sensitive_miss_default_006",
      description: "enum_map is case-sensitive and falls back to default when unmapped",
      tags: ["transform:enum_map", "type:enum"],
      spec: enumDefaultSpec,
      input: textInput("m=POST"),
      expected: match({ method: okEnum("OTHER") }),
    }),
    vec({
      id: "vec_tr_enum_map_miss_no_default_error_007",
      description: "enum_map without default reports unmapped_enum parse_error on unknown key",
      tags: ["transform:enum_map", "parse_error", "ambiguity:enum_map_no_default"],
      spec: enumStrictSpec,
      input: textInput("m=patch"),
      expected: match({ method: parseErr("unmapped_enum") }),
    }),
    vec({
      id: "vec_tr_lower_then_enum_map_hit_008",
      description: "chained lower + enum_map normalizes case before lookup",
      tags: ["transform:lower", "transform:enum_map", "transform:chain", "type:enum"],
      spec: lowerEnumSpec,
      input: textInput("m=DeLeTe"),
      expected: match({ method: okEnum("DELETE") }),
    }),
    vec({
      id: "vec_tr_lower_then_enum_map_default_009",
      description: "chained lower + enum_map falls back to default on unknown value",
      tags: ["transform:lower", "transform:enum_map", "transform:chain", "type:enum"],
      spec: lowerEnumSpec,
      input: textInput("m=OPTIONS"),
      expected: match({ method: okEnum("OTHER") }),
    }),
    vec({
      id: "vec_tr_cast_then_enum_map_args_010",
      description: "chained cast(string) + enum_map maps integer arg to enum",
      tags: ["transform:cast", "transform:enum_map", "transform:chain", "type:enum"],
      spec: enumFromIntSpec,
      input: argsInput(["status=", ""], [404]),
      expected: match({ bucket: okEnum("not_found") }),
    }),
    vec({
      id: "vec_tr_cast_then_enum_map_args_default_011",
      description: "chained cast(string) + enum_map uses default for unmapped status code",
      tags: ["transform:cast", "transform:enum_map", "transform:chain", "type:enum"],
      spec: enumFromIntSpec,
      input: argsInput(["status=", ""], [418]),
      expected: match({ bucket: okEnum("other") }),
    }),
    vec({
      id: "vec_tr_lower_type_mismatch_on_int_obj_012",
      description: "lower on integer object value produces type_mismatch parse_error",
      tags: ["transform:lower", "parse_error"],
      spec: objectSpec({
        template: "tpl_04LOWR012",
        event: "test.transform.lower_err",
        shape: ["name"],
        fields: [
          field({
            id: "fld_04LOW0012",
            name: "name",
            from: { path: "name" },
            type: "string",
            transforms: [{ op: "lower" }],
          }),
        ],
        sampleObject: { name: "ALICE" },
        sampleExpect: { name: "alice" },
      }),
      input: objectInput({ name: 123 }),
      expected: match({ name: parseErr("type_mismatch") }),
    }),
    vec({
      id: "vec_tr_lower_locale_independent_root_013",
      description: "lower performs locale-independent root Unicode folding (İ -> i+U+0307, ASCII I -> i)",
      tags: ["transform:lower", "unicode", "ambiguity:lower_unicode"],
      spec: lowerSpec,
      input: textInput("v=\u0130STANBUL I"),
      expected: match({ v: okStr("i\u0307stanbul i") }),
    })
  );

  return {
    suite: "04-transforms-core",
    description: "Golden conformance vectors covering cast, scale (IEEE-754 single-op bit patterns), unit (all time and byte units), parse_time (all 10 formats including exact decimal unix_s), lower (locale-independent UTF-8), and enum_map transforms.",
    vectors,
  };
}
