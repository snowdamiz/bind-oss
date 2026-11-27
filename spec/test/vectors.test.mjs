import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildAllArtifacts,
  checkAllArtifacts,
  findExtraSuiteFiles,
} from "../scripts/build-vectors.mjs";
import {
  MANIFEST_PATH,
  VECTORS_DIR,
  createVectorValidator,
  evaluateVector,
  float64ToHex,
  hexToFloat64,
  validateAllVectors,
  validateVectorSuiteDocument,
} from "../scripts/validate-vectors.mjs";
import { SPEC_ROOT, loadDocument } from "../scripts/validate.mjs";

const result = validateAllVectors();
const validator = createVectorValidator();

function copyVectorsToTempDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-vectors-test-"));
  const suitesDst = path.join(tmpDir, "suites");
  fs.mkdirSync(suitesDst, { recursive: true });
  fs.copyFileSync(MANIFEST_PATH, path.join(tmpDir, "manifest.json"));
  const suitesSrc = path.join(VECTORS_DIR, "suites");
  for (const name of fs.readdirSync(suitesSrc)) {
    fs.copyFileSync(path.join(suitesSrc, name), path.join(suitesDst, name));
  }
  return tmpDir;
}

describe("Golden vector schema and manifest integrity", () => {
  it("compiles vector.schema.json under Draft 2020-12 strict mode", () => {
    assert.equal(
      validator.vectorSuiteSchema.$schema,
      "https://json-schema.org/draft/2020-12/schema"
    );
    assert.equal(
      validator.vectorSuiteSchema.$id,
      "https://schemas.bind.dev/v1/golden-vector-suite.schema.json"
    );
  });

  it("validates manifest, SHA-256 digests, all vector schemas, ParserSpecs, cross-references, and reference outputs", () => {
    assert.equal(
      result.valid,
      true,
      `Golden vector validation failed:\n${result.errors.join("\n")}`
    );
  });

  it("is 100% deterministic: buildAllArtifacts() and checkAllArtifacts() match checked-in JSON byte-for-byte", () => {
    const built = buildAllArtifacts();
    assert.equal(
      fs.readFileSync(MANIFEST_PATH, "utf8"),
      built.manifestText,
      "manifest.json drifted from deterministic build"
    );
    for (const f of built.suiteFiles) {
      assert.equal(
        fs.readFileSync(f.absPath, "utf8"),
        f.jsonText,
        `${f.relFile} drifted from deterministic build`
      );
    }
    const check = checkAllArtifacts({ built });
    assert.equal(check.ok, true, `checkAllArtifacts failed: ${check.mismatches.join("; ")}`);
  });
});

describe("Golden vector coverage matrix", () => {
  const s = result.stats;

  it("supplies at least 300 deterministic golden vectors", () => {
    assert.ok(
      s.totalVectors >= 300,
      `Expected at least 300 golden vectors, found ${s.totalVectors}`
    );
  });

  it("covers all 3 matcher families (text, object, args)", () => {
    assert.deepEqual([...s.matchKinds].sort(), ["args", "object", "text"]);
  });

  it("covers all 11 hole classes", () => {
    assert.deepEqual([...s.holeClasses].sort(), [
      "float",
      "hex",
      "int",
      "ip",
      "json",
      "quoted",
      "rest",
      "time",
      "until",
      "uuid",
      "word",
    ]);
  });

  it("covers all 9 transforms and all sub-catalogs (units, parse_time formats, cast targets)", () => {
    assert.deepEqual([...s.transforms].sort(), [
      "cast",
      "drop",
      "enum_map",
      "hash",
      "lower",
      "mask",
      "parse_time",
      "scale",
      "unit",
    ]);
    assert.deepEqual([...s.timeUnits].sort(), ["d", "h", "m", "ms", "ns", "s", "us"]);
    assert.deepEqual([...s.byteUnits].sort(), [
      "B",
      "GB",
      "GiB",
      "KB",
      "KiB",
      "MB",
      "MiB",
      "TB",
      "TiB",
    ]);
    assert.deepEqual([...s.parseTimeFormats].sort(), [
      "apache",
      "auto",
      "iso8601",
      "rfc2822",
      "rfc3339",
      "syslog",
      "unix_ms",
      "unix_ns",
      "unix_s",
      "unix_us",
    ]);
    assert.deepEqual([...s.castTargets].sort(), ["bool", "float", "int", "json", "string"]);
  });

  it("covers all 7 field types and all 5 field result statuses plus non-match cases", () => {
    assert.deepEqual([...s.fieldTypes].sort(), [
      "bool",
      "enum",
      "float",
      "int",
      "json",
      "string",
      "timestamp",
    ]);
    assert.deepEqual([...s.fieldStatuses].sort(), [
      "dropped",
      "missing",
      "ok",
      "parse_error",
      "redacted",
    ]);
    assert.ok(s.matchedTrue > 0, "Expected matched vectors");
    assert.ok(s.matchedFalse >= 50, `Expected substantial non-match coverage, got ${s.matchedFalse}`);
  });

  it("covers SQL refusals (text and object.message json holes) and SQL-supported json paths/args", () => {
    assert.ok(s.sqlRefused >= 20, `Expected >= 20 SQL-refused vectors, got ${s.sqlRefused}`);
    assert.ok(s.sqlSupported >= 300, `Expected >= 300 SQL-supported vectors, got ${s.sqlSupported}`);
    assert.ok(s.tags.has("sql:refuse"));
    assert.ok(s.tags.has("sql:refuse:json_hole"));
    assert.ok(s.tags.has("sql:supported_json_path"));
    assert.ok(s.tags.has("sql:supported_json_arg"));
  });

  it("covers boundary requirements: adjacent holes, overlapping literals, 64 KiB records, non-ASCII UTF-8, and IEEE-754 scale pins", () => {
    assert.ok(s.tags.has("adjacent_holes"), "Missing adjacent_holes vectors");
    assert.ok(s.tags.has("boundary:following_literal"), "Missing overlapping-literal boundary vectors");
    assert.ok(s.tags.has("ambiguity:scanner_hole_boundary"), "Missing scanner_hole_boundary tag");
    assert.ok(s.tags.has("ambiguity:prescrubbed_token_transforms"), "Missing prescrubbed_token_transforms tag");
    assert.ok(s.tags.has("ambiguity:pii_default_transform_placement"), "Missing pii_default_transform_placement tag");
    assert.ok(s.tags.has("ambiguity:offsetless_time"), "Missing offsetless_time tag");
    assert.ok(s.tags.has("ambiguity:unix_s_exact_decimal"), "Missing unix_s_exact_decimal tag");
    assert.ok(s.tags.has("ambiguity:quoted_token_classification"), "Missing quoted_token_classification tag");
    assert.ok(s.tags.has("ambiguity:hosted_inner_edge_token"), "Missing hosted_inner_edge_token tag");
    assert.ok(s.tags.has("ambiguity:generated_tag_identity"), "Missing generated_tag_identity tag");
    assert.ok(s.tags.has("time:compact_offset"), "Missing compact_offset tag");
    assert.ok(s.tags.has("redaction:neutral"), "Missing neutral unknown angle-bracket vectors");
    assert.ok(s.tags.has("redaction:inner_edge"), "Missing inner_edge redaction vectors");
    assert.ok(s.tags.has("unicode:nbsp"), "Missing U+00A0 vectors");
    assert.ok(s.tags.has("unicode:ideographic_space"), "Missing U+3000 vectors");
    assert.ok(s.tags.has("unicode:combining"), "Missing combining-mark vectors");
    assert.ok(s.tags.has("unicode:emoji"), "Missing emoji vectors");
    assert.ok(s.tags.has("boundary:64kib"), "Missing 64 KiB record vectors");
    assert.equal(s.maxRecordBytes, 65536, "Expected exact 65536-byte (64 KiB) text record");

    // Verify exact IEEE-754 double hex for 1999 / 100 vs 1999 * 0.01
    assert.equal(float64ToHex(1999 / 100), "4033fd70a3d70a3d");
    assert.equal(float64ToHex(1999 * 0.01), "4033fd70a3d70a3e");
    assert.equal(hexToFloat64("4033fd70a3d70a3d"), 19.99);
  });

  it("keeps canonical order.paid vector ParserSpec structurally identical to parser-spec-section5-text fixture", () => {
    const suite07 = JSON.parse(
      fs.readFileSync(path.join(VECTORS_DIR, "suites", "07-boundaries-unicode-adjacent-large.json"), "utf8")
    );
    const canonical = suite07.vectors.find((v) => v.id === "vec_s5_canonical_order_paid_001");
    assert.ok(canonical, "Expected vec_s5_canonical_order_paid_001");

    const fixture = loadDocument(
      path.join(SPEC_ROOT, "fixtures", "valid", "parser-spec-section5-text.json")
    );
    assert.deepEqual(canonical.spec, fixture);
  });
});

describe("Negative validation checks: malformed vectors and semantic regressions are rejected", () => {
  const suite01 = JSON.parse(
    fs.readFileSync(path.join(VECTORS_DIR, "suites", "01-holes-word-int-float.json"), "utf8")
  );
  const suite02 = JSON.parse(
    fs.readFileSync(path.join(VECTORS_DIR, "suites", "02-holes-uuid-hex-ip-time.json"), "utf8")
  );
  const suite03 = JSON.parse(
    fs.readFileSync(path.join(VECTORS_DIR, "suites", "03-holes-quoted-json-until-rest.json"), "utf8")
  );
  const suite04 = JSON.parse(
    fs.readFileSync(path.join(VECTORS_DIR, "suites", "04-transforms-core.json"), "utf8")
  );
  const suite05 = JSON.parse(
    fs.readFileSync(path.join(VECTORS_DIR, "suites", "05-transforms-privacy-and-redaction.json"), "utf8")
  );
  const suite07 = JSON.parse(
    fs.readFileSync(path.join(VECTORS_DIR, "suites", "07-boundaries-unicode-adjacent-large.json"), "utf8")
  );

  function singleVectorSuite(baseSuite, vector) {
    return {
      schema_version: 1,
      suite: baseSuite.suite,
      description: baseSuite.description,
      context: baseSuite.context,
      vectors: [structuredClone(vector)],
    };
  }

  it("rejects float encoded as decimal number instead of 16-char IEEE-754 hex", () => {
    const floatVec = suite01.vectors.find((v) => v.id === "vec_hole_float_point_one_006");
    const bad = singleVectorSuite(suite01, floatVec);
    bad.vectors[0].expected.fields.f.value = 0.1;
    const errs = validateVectorSuiteDocument(bad, validator);
    assert.ok(errs.length > 0, "Expected float numeric encoding to fail schema validation");
  });

  it("rejects int64 overflow inside an ok int result", () => {
    const intVec = suite01.vectors.find((v) => v.id === "vec_hole_int_max_int64_008");
    const bad = singleVectorSuite(suite01, intVec);
    bad.vectors[0].expected.fields.n.value = "9223372036854775808";
    const errs = validateVectorSuiteDocument(bad, validator);
    assert.ok(errs.some((e) => e.includes("out of int64 bounds")));
  });

  it("rejects SQL-refused json-hole spec if marked sql.supported: true", () => {
    const jsonVec = suite03.vectors.find((v) => v.id === "vec_hole_json_flat_object_001");
    const bad = singleVectorSuite(suite03, jsonVec);
    bad.vectors[0].sql = { supported: true };
    const errs = validateVectorSuiteDocument(bad, validator);
    assert.ok(errs.some((e) => e.includes("sql.supported must be false")));
  });

  it("rejects SQL-supported spec if erroneously tagged sql:refuse", () => {
    const wordVec = suite01.vectors.find((v) => v.id === "vec_hole_word_basic_001");
    const bad = singleVectorSuite(suite01, wordVec);
    bad.vectors[0].tags.push("sql:refuse");
    const errs = validateVectorSuiteDocument(bad, validator);
    assert.ok(errs.some((e) => e.includes("must not carry sql:refuse")));
  });

  it("rejects expected.fields missing a declared field", () => {
    const wordVec = suite01.vectors.find((v) => v.id === "vec_hole_word_basic_001");
    const bad = singleVectorSuite(suite01, wordVec);
    bad.vectors[0].expected.fields = {};
    const errs = validateVectorSuiteDocument(bad, validator);
    assert.ok(errs.some((e) => e.includes("do not match spec.fields")));
  });

  it("rejects spec with undeclared hole reference", () => {
    const wordVec = suite01.vectors.find((v) => v.id === "vec_hole_word_basic_001");
    const bad = singleVectorSuite(suite01, wordVec);
    bad.vectors[0].spec.fields[0].from = { hole: "missing_hole" };
    const errs = validateVectorSuiteDocument(bad, validator);
    assert.ok(errs.some((e) => e.includes('undeclared hole "missing_hole"')));
  });

  it("rejects corrupted expected value caught by independent reference evaluator", () => {
    const wordVec = suite01.vectors.find((v) => v.id === "vec_hole_word_basic_001");
    const bad = singleVectorSuite(suite01, wordVec);
    bad.vectors[0].expected.fields.val.value = "wrong_value";
    const errs = validateVectorSuiteDocument(bad, validator);
    assert.ok(errs.some((e) => e.includes("reference evaluator mismatch")));
  });

  it("rejects binary64-drifted parse_time(unix_s) '1.001' -> 1000 and accepts exact 1001", () => {
    const exactVec = suite04.vectors.find((v) => v.id === "vec_tr_parse_time_unix_s_exact_decimal_019");
    assert.ok(exactVec);
    assert.equal(validateVectorSuiteDocument(singleVectorSuite(suite04, exactVec), validator).length, 0);

    const drifted = singleVectorSuite(suite04, exactVec);
    drifted.vectors[0].expected.fields.ts.value = 1000;
    const errs = validateVectorSuiteDocument(drifted, validator);
    assert.ok(errs.some((e) => e.includes("reference evaluator mismatch")));
  });

  it("rejects pre-scrubbed pseudonym on string field being dropped instead of preserved", () => {
    const pseudoDropVec = suite05.vectors.find(
      (v) => v.id === "vec_redact_pseudonym_string_short_circuits_drop_001"
    );
    assert.ok(pseudoDropVec);
    assert.equal(validateVectorSuiteDocument(singleVectorSuite(suite05, pseudoDropVec), validator).length, 0);

    const bad = singleVectorSuite(suite05, pseudoDropVec);
    bad.vectors[0].expected.fields.secret = { status: "dropped" };
    const errs = validateVectorSuiteDocument(bad, validator);
    assert.ok(errs.some((e) => e.includes("reference evaluator mismatch")));
  });

  it("rejects misclassifying neutral <nil> as redacted and rejects failing <b>bold in word hole", () => {
    const nilWordVec = suite05.vectors.find((v) => v.id === "vec_redact_neutral_unknown_nil_in_word_005");
    assert.ok(nilWordVec);
    assert.equal(validateVectorSuiteDocument(singleVectorSuite(suite05, nilWordVec), validator).length, 0);

    const badNil = singleVectorSuite(suite05, nilWordVec);
    badNil.vectors[0].expected.fields.val = { status: "redacted", token: "<nil>" };
    assert.ok(
      validateVectorSuiteDocument(badNil, validator).some((e) => e.includes("reference evaluator mismatch"))
    );

    const htmlWordVec = suite05.vectors.find((v) => v.id === "vec_redact_neutral_html_tag_prefix_in_word_006");
    assert.ok(htmlWordVec);
    assert.equal(validateVectorSuiteDocument(singleVectorSuite(suite05, htmlWordVec), validator).length, 0);

    const badHtml = singleVectorSuite(suite05, htmlWordVec);
    badHtml.vectors[0].expected = { matched: false };
    assert.ok(
      validateVectorSuiteDocument(badHtml, validator).some((e) => e.includes("reference evaluator mismatch"))
    );
  });

  it("enforces overlapping-literal and adjacent-hole boundary semantics", () => {
    const wordCommaVec = suite01.vectors.find((v) => v.id === "vec_hole_word_before_comma_id_lit_019");
    const hexFVec = suite02.vectors.find((v) => v.id === "vec_hole_hex_before_hex_lit_f_013");
    const adjIntWordVec = suite07.vectors.find((v) => v.id === "vec_adj_int_word_all_digits_no_backtrack_011");
    assert.ok(wordCommaVec && hexFVec && adjIntWordVec);

    const badWord = singleVectorSuite(suite01, wordCommaVec);
    badWord.vectors[0].expected = { matched: false };
    assert.ok(
      validateVectorSuiteDocument(badWord, validator).some((e) => e.includes("reference evaluator mismatch"))
    );

    const badHex = singleVectorSuite(suite02, hexFVec);
    badHex.vectors[0].expected = { matched: false };
    assert.ok(
      validateVectorSuiteDocument(badHex, validator).some((e) => e.includes("reference evaluator mismatch"))
    );

    const badAdj = singleVectorSuite(suite07, adjIntWordVec);
    badAdj.vectors[0].expected = {
      matched: true,
      fields: {
        num: { status: "ok", type: "int", value: "21234" },
        unit: { status: "ok", type: "string", value: "5" },
      },
    };
    assert.ok(
      validateVectorSuiteDocument(badAdj, validator).some((e) => e.includes("reference evaluator mismatch"))
    );
  });

  it("enforces quoted capture token classification after unescaping across mask, pseudonym, drop/mask, and neutral text", () => {
    const quotedMaskStr = suite05.vectors.find((v) => v.id === "vec_redact_quoted_mask_string_001");
    const quotedMaskInt = suite05.vectors.find((v) => v.id === "vec_redact_quoted_mask_int_002");
    const quotedPseudoDrop = suite05.vectors.find(
      (v) => v.id === "vec_redact_quoted_pseudonym_short_circuits_drop_003"
    );
    const quotedPseudoMask = suite05.vectors.find(
      (v) => v.id === "vec_redact_quoted_pseudonym_short_circuits_mask_004"
    );
    const quotedEscaped = suite05.vectors.find(
      (v) => v.id === "vec_redact_quoted_escaped_token_unescaped_006"
    );
    assert.ok(quotedMaskStr && quotedMaskInt && quotedPseudoDrop && quotedPseudoMask && quotedEscaped);

    const badMaskStr = singleVectorSuite(suite05, quotedMaskStr);
    badMaskStr.vectors[0].expected.fields.user = { status: "ok", type: "string", value: "<card>" };
    assert.ok(
      validateVectorSuiteDocument(badMaskStr, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );

    const badMaskInt = singleVectorSuite(suite05, quotedMaskInt);
    badMaskInt.vectors[0].expected.fields.user = { status: "parse_error", code: "cast_failed" };
    assert.ok(
      validateVectorSuiteDocument(badMaskInt, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );

    const badPseudoDrop = singleVectorSuite(suite05, quotedPseudoDrop);
    badPseudoDrop.vectors[0].expected.fields.user = { status: "dropped" };
    assert.ok(
      validateVectorSuiteDocument(badPseudoDrop, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );

    const badPseudoMask = singleVectorSuite(suite05, quotedPseudoMask);
    badPseudoMask.vectors[0].expected.fields.user = { status: "redacted", token: "<email>" };
    assert.ok(
      validateVectorSuiteDocument(badPseudoMask, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );

    const badEscaped = singleVectorSuite(suite05, quotedEscaped);
    badEscaped.vectors[0].expected.fields.user = {
      status: "ok",
      type: "string",
      value: '<secret:a"b>',
    };
    assert.ok(
      validateVectorSuiteDocument(badEscaped, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );
  });

  it("rejects exposing inner edge 64-hex digest in value or redacted token detail during hosted conformance", () => {
    const innerRaw = suite05.vectors.find((v) => v.id === "vec_redact_inner_edge_string_raw_001");
    const innerHash = suite05.vectors.find((v) => v.id === "vec_redact_inner_edge_string_with_hash_002");
    const innerNonStr = suite05.vectors.find((v) => v.id === "vec_redact_inner_edge_nonstring_int_003");
    assert.ok(innerRaw && innerHash && innerNonStr);

    const innerToken =
      "<email:~0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef>";

    const leakedVal = singleVectorSuite(suite05, innerRaw);
    leakedVal.vectors[0].expected.fields.email = { status: "ok", type: "string", value: innerToken };
    assert.ok(
      validateVectorSuiteDocument(leakedVal, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );

    const leakedDetail = singleVectorSuite(suite05, innerNonStr);
    leakedDetail.vectors[0].expected.fields.usd = { status: "redacted", token: innerToken };
    assert.ok(
      validateVectorSuiteDocument(leakedDetail, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );

    const leakedHash = singleVectorSuite(suite05, innerHash);
    leakedHash.vectors[0].expected.fields.email = { status: "redacted", token: "<email>" };
    assert.ok(
      validateVectorSuiteDocument(leakedHash, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );
  });

  it("carries newly generated tag identity across custom labels, repeated hash, and non-string fields while keeping later drop/mask", () => {
    const repeatCustom = suite05.vectors.find((v) => v.id === "vec_tr_hash_custom_label_repeated_hash_009");
    const chainCustom = suite05.vectors.find(
      (v) => v.id === "vec_tr_hash_custom_label_cast_lower_repeated_hash_010"
    );
    const nonStrInt = suite05.vectors.find(
      (v) => v.id === "vec_tr_hash_custom_label_nonstring_int_redacted_011"
    );
    const nonStrEnum = suite05.vectors.find(
      (v) => v.id === "vec_tr_hash_custom_label_nonstring_enum_after_lower_redacted_012"
    );
    const hashDrop = suite05.vectors.find((v) => v.id === "vec_tr_hash_followed_by_explicit_drop_013");
    const hashMask = suite05.vectors.find((v) => v.id === "vec_tr_hash_followed_by_explicit_mask_014");
    assert.ok(repeatCustom && chainCustom && nonStrInt && nonStrEnum && hashDrop && hashMask);

    const badDoubleHash = singleVectorSuite(suite05, repeatCustom);
    badDoubleHash.vectors[0].expected.fields.email = {
      status: "ok",
      type: "string",
      value: "<email:0000000000000000>",
    };
    assert.ok(
      validateVectorSuiteDocument(badDoubleHash, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );

    const badNonStrEnum = singleVectorSuite(suite05, nonStrEnum);
    badNonStrEnum.vectors[0].expected.fields.role = {
      status: "ok",
      type: "enum",
      value: nonStrEnum.expected.fields.role.token,
    };
    assert.ok(
      validateVectorSuiteDocument(badNonStrEnum, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );

    const badNonStrInt = singleVectorSuite(suite05, nonStrInt);
    badNonStrInt.vectors[0].expected.fields.uid = { status: "parse_error", code: "type_mismatch" };
    assert.ok(
      validateVectorSuiteDocument(badNonStrInt, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );

    const badHashDrop = singleVectorSuite(suite05, hashDrop);
    badHashDrop.vectors[0].expected.fields.email = {
      status: "ok",
      type: "string",
      value: repeatCustom.expected.fields.email.value,
    };
    assert.ok(
      validateVectorSuiteDocument(badHashDrop, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );

    const badHashMask = singleVectorSuite(suite05, hashMask);
    badHashMask.vectors[0].expected.fields.email = {
      status: "ok",
      type: "string",
      value: repeatCustom.expected.fields.email.value,
    };
    assert.ok(
      validateVectorSuiteDocument(badHashMask, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );
  });

  it("preserves original decimal lexemes through float holes to direct unix_s and handles bounded zero-padded exponents", () => {
    const floatExact = suite04.vectors.find(
      (v) => v.id === "vec_tr_parse_time_unix_s_float_hole_exact_decimal_023"
    );
    const posExp = suite04.vectors.find(
      (v) => v.id === "vec_tr_parse_time_unix_s_float_hole_zero_padded_pos_exp_024"
    );
    const negExp = suite04.vectors.find(
      (v) => v.id === "vec_tr_parse_time_unix_s_float_hole_zero_padded_neg_exp_025"
    );
    const zeroExp = suite04.vectors.find(
      (v) => v.id === "vec_tr_parse_time_unix_s_float_hole_zero_padded_zero_exp_026"
    );
    assert.ok(floatExact && posExp && negExp && zeroExp);

    const roundedFloat = singleVectorSuite(suite04, floatExact);
    roundedFloat.vectors[0].expected.fields.ts.value = 1795701600124;
    assert.ok(
      validateVectorSuiteDocument(roundedFloat, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );

    const badPosExp = singleVectorSuite(suite04, posExp);
    badPosExp.vectors[0].expected.fields.ts = { status: "parse_error", code: "invalid_time" };
    assert.ok(
      validateVectorSuiteDocument(badPosExp, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );

    const badNegExp = singleVectorSuite(suite04, negExp);
    badNegExp.vectors[0].expected.fields.ts.value = 0;
    assert.ok(
      validateVectorSuiteDocument(badNegExp, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );
  });

  it("pins tokens before overlapping ':' literals and compact ±HHMM ISO offsets", () => {
    const colonPseudo = suite05.vectors.find(
      (v) => v.id === "vec_redact_token_before_colon_literal_pseudonym_001"
    );
    const colonMask = suite05.vectors.find(
      (v) => v.id === "vec_redact_token_before_colon_literal_mask_002"
    );
    const compactHole = suite02.vectors.find((v) => v.id === "vec_hole_time_iso_compact_offset_021");
    const compactParse = suite04.vectors.find(
      (v) => v.id === "vec_tr_parse_time_iso8601_compact_offset_022"
    );
    assert.ok(colonPseudo && colonMask && compactHole && compactParse);

    const badColon = singleVectorSuite(suite05, colonPseudo);
    badColon.vectors[0].expected = { matched: false };
    assert.ok(
      validateVectorSuiteDocument(badColon, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );

    const badCompact = singleVectorSuite(suite04, compactParse);
    badCompact.vectors[0].expected.fields.ts = { status: "parse_error", code: "invalid_time" };
    assert.ok(
      validateVectorSuiteDocument(badCompact, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );
  });
  it("preserves numeric hole semantics outside direct parse_time(unix_s): Int64 int-hole before scale, integral float-to-int, and cast(int)->hash", () => {
    const intOverflowScale = suite04.vectors.find(
      (v) => v.id === "vec_tr_scale_int_hole_overflow_before_scale_015"
    );
    const floatIntegralToInt = suite04.vectors.find(
      (v) => v.id === "vec_tr_float_hole_integral_to_int_016"
    );
    const floatFracToInt = suite04.vectors.find(
      (v) => v.id === "vec_tr_float_hole_fractional_to_int_error_017"
    );
    const castIntHashStr = suite05.vectors.find(
      (v) => v.id === "vec_tr_cast_int_then_hash_string_015"
    );
    const castIntHashInt = suite05.vectors.find(
      (v) => v.id === "vec_tr_cast_int_then_hash_nonstring_int_016"
    );
    assert.ok(intOverflowScale && floatIntegralToInt && floatFracToInt && castIntHashStr && castIntHashInt);

    // Int64 int-hole overflow before scale must not silently widen to ok float
    const badScale = singleVectorSuite(suite04, intOverflowScale);
    badScale.vectors[0].expected.fields.usd = {
      status: "ok",
      type: "float",
      value: "43747ae147ae147b",
    };
    assert.ok(
      validateVectorSuiteDocument(badScale, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );

    // Integral float hole 12.0 -> int must remain ok int "12"
    const badFloatInt = singleVectorSuite(suite04, floatIntegralToInt);
    badFloatInt.vectors[0].expected.fields.v = { status: "parse_error", code: "type_mismatch" };
    assert.ok(
      validateVectorSuiteDocument(badFloatInt, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );

    // Schema-valid cast(int) -> hash must not reject int input with type_mismatch
    const badCastHash = singleVectorSuite(suite05, castIntHashStr);
    badCastHash.vectors[0].expected.fields.uid = { status: "parse_error", code: "type_mismatch" };
    assert.ok(
      validateVectorSuiteDocument(badCastHash, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );
  });

  it("prevents inner edge digest spill across straddling capture boundaries while preserving normal literal boundaries", () => {
    const untilGt = suite05.vectors.find(
      (v) => v.id === "vec_redact_inner_edge_until_stops_at_gt_006"
    );
    const untilSibling = suite05.vectors.find(
      (v) => v.id === "vec_redact_inner_edge_until_gt_preserves_sibling_007"
    );
    const splitColon = suite05.vectors.find(
      (v) => v.id === "vec_redact_inner_edge_until_colon_split_across_holes_008"
    );
    const litLtGt = suite05.vectors.find(
      (v) => v.id === "vec_redact_inner_edge_lit_consumes_lt_until_gt_009"
    );
    const restEmbed = suite05.vectors.find(
      (v) => v.id === "vec_redact_inner_edge_embedded_in_rest_010"
    );
    const quotedEsc = suite05.vectors.find(
      (v) => v.id === "vec_redact_inner_edge_quoted_escaped_tilde_011"
    );
    const objEmbed = suite05.vectors.find(
      (v) => v.id === "vec_redact_inner_edge_object_embedded_string_012"
    );
    const normalGt = suite05.vectors.find(
      (v) => v.id === "vec_redact_inner_edge_until_gt_normal_boundary_preserved_013"
    );
    const pseudoGt = suite05.vectors.find(
      (v) => v.id === "vec_redact_inner_edge_until_gt_pseudonym_boundary_preserved_014"
    );
    assert.ok(
      untilGt &&
        untilSibling &&
        splitColon &&
        litLtGt &&
        restEmbed &&
        quotedEsc &&
        objEmbed &&
        normalGt &&
        pseudoGt
    );

    // Reject spilling truncated inner digest when until stops at closing '>'
    const spillUntilGt = singleVectorSuite(suite05, untilGt);
    spillUntilGt.vectors[0].expected.fields.u = {
      status: "ok",
      type: "string",
      value: "<email:~0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    };
    assert.ok(
      validateVectorSuiteDocument(spillUntilGt, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );

    // Reject spilling digest half across ':' split
    const spillSplit = singleVectorSuite(suite05, splitColon);
    spillSplit.vectors[0].expected.fields.r = {
      status: "ok",
      type: "string",
      value: "~0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef>",
    };
    assert.ok(
      validateVectorSuiteDocument(spillSplit, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );

    // Ensure normal literal '>' boundary is preserved for non-inner final pseudonym text
    const brokenBoundary = singleVectorSuite(suite05, pseudoGt);
    brokenBoundary.vectors[0].expected.fields.u = { status: "redacted", token: "<redacted>" };
    assert.ok(
      validateVectorSuiteDocument(brokenBoundary, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );
  });
  it("redacts custom schema-valid hash.kind inner edge tokens (single, overlap, and decoded escapes) while keeping closed-catalog final/mask rules", () => {
    const customSingleStr = suite05.vectors.find(
      (v) => v.id === "vec_redact_inner_edge_custom_kind_user_single_string_015"
    );
    const customSingleInt = suite05.vectors.find(
      (v) => v.id === "vec_redact_inner_edge_custom_kind_user_single_int_016"
    );
    const customOverlap = suite05.vectors.find(
      (v) => v.id === "vec_redact_inner_edge_custom_kind_user_until_gt_overlap_017"
    );
    const customDecoded = suite05.vectors.find(
      (v) => v.id === "vec_redact_inner_edge_custom_kind_user_quoted_decoded_018"
    );
    const customOrdinary = suite05.vectors.find(
      (v) => v.id === "vec_redact_custom_kind_user_non_inner_stays_ordinary_019"
    );
    assert.ok(customSingleStr && customSingleInt && customOverlap && customDecoded && customOrdinary);

    // Reject exposing custom inner digest on single capture
    const badSingle = singleVectorSuite(suite05, customSingleStr);
    badSingle.vectors[0].expected.fields.user = {
      status: "ok",
      type: "string",
      value: "<user:~0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef>",
    };
    assert.ok(
      validateVectorSuiteDocument(badSingle, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );

    // Reject spilling custom inner digest when until stops at '>'
    const badOverlap = singleVectorSuite(suite05, customOverlap);
    badOverlap.vectors[0].expected.fields.u = {
      status: "ok",
      type: "string",
      value: "<user:~0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    };
    assert.ok(
      validateVectorSuiteDocument(badOverlap, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );

    // Targeted decoder check: \u003c / \u007e / \u003e must decode and redact, while non-inner
    // custom <user:9f2c41d07a3b55e1> and <nil> stay ordinary text under closed-catalog rules.
    const badDecoded = singleVectorSuite(suite05, customDecoded);
    badDecoded.vectors[0].expected.fields.user = {
      status: "ok",
      type: "string",
      value: "<user:~0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef>",
    };
    assert.ok(
      validateVectorSuiteDocument(badDecoded, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );

    const decodedOrdinarySuite = singleVectorSuite(suite05, customDecoded);
    decodedOrdinarySuite.vectors[0].input = { kind: "text", line: 'user="\\u003cnil\\u003e"' };
    decodedOrdinarySuite.vectors[0].expected = {
      matched: true,
      fields: { user: { status: "ok", type: "string", value: "<nil>" } },
    };
    assert.deepEqual(validateVectorSuiteDocument(decodedOrdinarySuite, validator), []);

    const badOrdinaryCustom = singleVectorSuite(suite05, customOrdinary);
    badOrdinaryCustom.vectors[0].expected.fields.user = {
      status: "ok",
      type: "string",
      value: "<user:9f2c41d07a3b55e1>",
    };
    assert.ok(
      validateVectorSuiteDocument(badOrdinaryCustom, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );
  });

  it("blocks escaped inner tags in rest->cast(json) and duplicate-member json holes, preserves word+lit+rest split, rejects structured hash coercion, and pins overflowing-int controls", () => {
    const restCastEsc = suite05.vectors.find(
      (v) => v.id === "vec_redact_inner_edge_rest_cast_json_escaped_020"
    );
    const restCastDup = suite05.vectors.find(
      (v) => v.id === "vec_redact_inner_edge_rest_cast_json_dup_key_escaped_021"
    );
    const jsonHoleDup = suite05.vectors.find(
      (v) => v.id === "vec_redact_inner_edge_json_hole_dup_key_escaped_022"
    );
    const wordSplit = suite05.vectors.find(
      (v) => v.id === "vec_redact_inner_edge_custom_kind_user_word_colon_rest_split_023"
    );
    const wordFullTag = suite05.vectors.find(
      (v) => v.id === "vec_redact_inner_edge_custom_kind_user_word_colon_rest_full_tag_024"
    );
    const hashScalar = suite05.vectors.find(
      (v) => v.id === "vec_tr_hash_scalar_int_coercion_026"
    );
    const hashObj = suite05.vectors.find(
      (v) => v.id === "vec_tr_hash_structured_object_rejected_027"
    );
    const hashArr = suite05.vectors.find(
      (v) => v.id === "vec_tr_hash_structured_array_rejected_028"
    );
    const intOverflowStr = suite04.vectors.find(
      (v) => v.id === "vec_tr_int_hole_overflow_string_target_018"
    );
    const intOverflowCastFloat = suite04.vectors.find(
      (v) => v.id === "vec_tr_int_hole_overflow_leading_cast_float_019"
    );
    const intOverflowStrDrop = suite04.vectors.find(
      (v) => v.id === "vec_tr_int_hole_overflow_string_drop_020"
    );
    assert.ok(
      restCastEsc &&
        restCastDup &&
        jsonHoleDup &&
        wordSplit &&
        wordFullTag &&
        hashScalar &&
        hashObj &&
        hashArr &&
        intOverflowStr &&
        intOverflowCastFloat &&
        intOverflowStrDrop
    );

    const ctx = suite05.context;

    // 1. rest->cast(json) must reject leaking escaped inner tag (single & duplicate key),
    //    while keeping escaped ordinary <nil> intact.
    const badRestCast = singleVectorSuite(suite05, restCastEsc);
    badRestCast.vectors[0].expected.fields.payload = {
      status: "ok",
      type: "json",
      value: { a: "<user:~0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef>" },
    };
    assert.ok(
      validateVectorSuiteDocument(badRestCast, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );
    const cleanEscNil = evaluateVector(
      restCastEsc.spec,
      { kind: "text", line: 'payload={"a":"\u003cnil\u003e","a":"safe"}' },
      ctx
    );
    assert.deepEqual(cleanEscNil, {
      matched: true,
      fields: { payload: { status: "ok", type: "json", value: { a: "safe" } } },
    });

    // 2. json hole raw text carrying a duplicate member's escaped inner tag must fail closed
    //    for both type: "json" and type: "string" even though JSON.parse drops the earlier key.
    const badJsonDup = singleVectorSuite(suite05, jsonHoleDup);
    badJsonDup.vectors[0].expected.fields.payload = {
      status: "ok",
      type: "json",
      value: { a: "safe" },
    };
    assert.ok(
      validateVectorSuiteDocument(badJsonDup, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );
    const jsonHoleStrSpec = structuredClone(jsonHoleDup.spec);
    jsonHoleStrSpec.fields[0].type = "string";
    const jsonHoleStrRes = evaluateVector(jsonHoleStrSpec, jsonHoleDup.input, ctx);
    assert.deepEqual(jsonHoleStrRes, {
      matched: true,
      fields: { payload: { status: "redacted", token: "<redacted>" } },
    });

    // 3. Leading custom inner token in word+':'+rest:
    //    - without immediately following ':', preserve split and redact both overlapping spans
    //    - even with trailing whitespace (' tail'), preserve split instead of failing match
    //    - with immediately following ':', take full tag in word and keep trailing rest
    const badWordSplit = singleVectorSuite(suite05, wordSplit);
    badWordSplit.vectors[0].expected = { matched: false };
    assert.ok(
      validateVectorSuiteDocument(badWordSplit, validator).some((e) =>
        e.includes("reference evaluator mismatch")
      )
    );
    const splitWithTrailingSpace = evaluateVector(
      wordSplit.spec,
      {
        kind: "text",
        line: "user=<user:~0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef> tail",
      },
      ctx
    );
    assert.deepEqual(splitWithTrailingSpace, {
      matched: true,
      fields: {
        u: { status: "redacted", token: "<redacted>" },
        r: { status: "redacted", token: "<redacted>" },
      },
    });
    const fullTagBeforeColon = evaluateVector(wordFullTag.spec, wordFullTag.input, ctx);
    assert.deepEqual(fullTagBeforeColon, {
      matched: true,
      fields: {
        u: { status: "redacted", token: "<redacted>" },
        r: { status: "ok", type: "string", value: "ok" },
      },
    });

    // 4. hash scalar-only coercion: structured objects, arrays, and JSON null must never coerce.
    const restCastJsonThenHashSpec = structuredClone(restCastEsc.spec);
    restCastJsonThenHashSpec.fields[0].type = "string";
    restCastJsonThenHashSpec.fields[0].transforms = [
      { op: "cast", to: "json" },
      { op: "hash", kind: "user" },
    ];
    for (const rawJson of ['{"a":1}', "[1,2]", "null"]) {
      const res = evaluateVector(
        restCastJsonThenHashSpec,
        { kind: "text", line: `payload=${rawJson}` },
        ctx
      );
      assert.deepEqual(res, {
        matched: true,
        fields: { payload: { status: "parse_error", code: "type_mismatch" } },
      });
    }
    const boolScalarHash = evaluateVector(hashScalar.spec, { kind: "object", object: { val: true } }, ctx);
    assert.equal(boolScalarHash.matched, true);
    assert.equal(boolScalarHash.fields.val.status, "ok");
    assert.match(boolScalarHash.fields.val.value, /^<user:[0-9a-f]{16}>$/);

    // 5. Overflowing int hole lexeme controls must NOT be unconditionally rejected as int_overflow.
    for (const vecCase of [intOverflowStr, intOverflowCastFloat, intOverflowStrDrop]) {
      const badOverflow = singleVectorSuite(suite04, vecCase);
      badOverflow.vectors[0].expected.fields.n = { status: "parse_error", code: "int_overflow" };
      assert.ok(
        validateVectorSuiteDocument(badOverflow, validator).some((e) =>
          e.includes("reference evaluator mismatch")
        )
      );
    }
  });

  it("inspects 20,000-level deeply nested valid JSON inputs iteratively without stack overflow", () => {
    const depth = 20000;
    const ctx = suite05.context;
    const customInner =
      "<user:~0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef>";
    const customInnerEsc =
      "\u003cuser:\u007e0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\u003e";

    const nestedObjSpec = suite05.vectors.find(
      (v) => v.id === "vec_redact_inner_edge_nested_object_025"
    ).spec;
    const restCastJsonSpec = suite05.vectors.find(
      (v) => v.id === "vec_redact_inner_edge_rest_cast_json_escaped_020"
    ).spec;
    const jsonHoleSpec = suite05.vectors.find(
      (v) => v.id === "vec_redact_inner_edge_json_hole_dup_key_escaped_022"
    ).spec;

    let deepClean = "ok";
    let deepInner = customInner;
    for (let i = 0; i < depth; i += 1) {
      deepClean = [deepClean];
      deepInner = [deepInner];
    }

    const objCleanRes = evaluateVector(nestedObjSpec, { kind: "object", object: { data: deepClean } }, ctx);
    assert.equal(objCleanRes.matched, true);
    assert.equal(objCleanRes.fields.data.status, "ok");
    assert.equal(objCleanRes.fields.data.type, "json");

    const objInnerRes = evaluateVector(nestedObjSpec, { kind: "object", object: { data: deepInner } }, ctx);
    assert.deepEqual(objInnerRes, {
      matched: true,
      fields: { data: { status: "redacted", token: "<redacted>" } },
    });

    const openBrackets = "[".repeat(depth);
    const closeBrackets = "]".repeat(depth);
    const deepJsonCleanLine = `payload=${openBrackets}"ok"${closeBrackets}`;
    const deepJsonInnerLine = `payload=${openBrackets}"${customInnerEsc}"${closeBrackets}`;

    const restCleanRes = evaluateVector(restCastJsonSpec, { kind: "text", line: deepJsonCleanLine }, ctx);
    assert.equal(restCleanRes.matched, true);
    assert.equal(restCleanRes.fields.payload.status, "ok");

    const restInnerRes = evaluateVector(restCastJsonSpec, { kind: "text", line: deepJsonInnerLine }, ctx);
    assert.deepEqual(restInnerRes, {
      matched: true,
      fields: { payload: { status: "redacted", token: "<redacted>" } },
    });

    const holeCleanRes = evaluateVector(jsonHoleSpec, { kind: "text", line: deepJsonCleanLine }, ctx);
    assert.equal(holeCleanRes.matched, true);
    assert.equal(holeCleanRes.fields.payload.status, "ok");

    const holeInnerRes = evaluateVector(jsonHoleSpec, { kind: "text", line: deepJsonInnerLine }, ctx);
    assert.deepEqual(holeInnerRes, {
      matched: true,
      fields: { payload: { status: "redacted", token: "<redacted>" } },
    });
  });
});

describe("Manifest integrity checks: per-suite SQL counts, default_context, and extra suite files", () => {
  it("rejects corrupted per-suite sql_supported_count / sql_refused_count even when top-level totals still match", () => {
    const tmpDir = copyVectorsToTempDir();
    try {
      const manifestPath = path.join(tmpDir, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      // Swap 1 between suite 01 and suite 03 so top-level totals remain identical while per-suite counts are wrong.
      manifest.suites[0].sql_supported_count -= 1;
      manifest.suites[0].sql_refused_count += 1;
      manifest.suites[2].sql_supported_count += 1;
      manifest.suites[2].sql_refused_count -= 1;
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      const res = validateAllVectors({ vectorsDir: tmpDir });
      assert.equal(res.valid, false);
      assert.ok(
        res.errors.some((e) => e.includes("sql_supported_count mismatch")),
        `Expected per-suite sql_supported_count error, got: ${res.errors.join("; ")}`
      );
      assert.ok(
        res.errors.some((e) => e.includes("sql_refused_count mismatch")),
        `Expected per-suite sql_refused_count error, got: ${res.errors.join("; ")}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects manifest default_context mismatch against suite context", () => {
    const tmpDir = copyVectorsToTempDir();
    try {
      const manifestPath = path.join(tmpDir, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.default_context.reference_ts_ms += 1000;
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      const res = validateAllVectors({ vectorsDir: tmpDir });
      assert.equal(res.valid, false);
      assert.ok(
        res.errors.some((e) => e.includes("Manifest default_context mismatch")),
        `Expected default_context mismatch error, got: ${res.errors.join("; ")}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects extra unlisted files in suites/ in both validateAllVectors and checkAllArtifacts/findExtraSuiteFiles", () => {
    const tmpDir = copyVectorsToTempDir();
    try {
      const strayPath = path.join(tmpDir, "suites", "99-stray-unlisted.json");
      fs.writeFileSync(strayPath, "{}\n", "utf8");

      const valRes = validateAllVectors({ vectorsDir: tmpDir });
      assert.equal(valRes.valid, false);
      assert.ok(
        valRes.errors.some((e) => e.includes("Unexpected extra file in suites directory") && e.includes("99-stray-unlisted.json")),
        `Expected extra unlisted file error from validateAllVectors, got: ${valRes.errors.join("; ")}`
      );

      const checkRes = checkAllArtifacts({ vectorsDir: tmpDir });
      assert.equal(checkRes.ok, false);
      assert.ok(
        checkRes.mismatches.some((m) => m.includes("extra unlisted file") && m.includes("99-stray-unlisted.json")),
        `Expected extra unlisted file error from checkAllArtifacts, got: ${checkRes.mismatches.join("; ")}`
      );

      const built = buildAllArtifacts();
      assert.deepEqual(
        findExtraSuiteFiles(
          path.join(tmpDir, "suites"),
          built.suiteFiles.map((f) => f.relFile)
        ),
        ["99-stray-unlisted.json"]
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
