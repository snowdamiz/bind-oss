import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildAllArtifacts } from "../scripts/build-vectors.mjs";
import {
  MANIFEST_PATH,
  VECTORS_DIR,
  createVectorValidator,
  float64ToHex,
  hexToFloat64,
  validateAllVectors,
  validateVectorSuiteDocument,
} from "../scripts/validate-vectors.mjs";
import { SPEC_ROOT, loadDocument } from "../scripts/validate.mjs";

const result = validateAllVectors();
const validator = createVectorValidator();

describe("Golden vector schema and manifest integrity (T2.1.2)", () => {
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

  it("is 100% deterministic: buildAllArtifacts() matches checked-in JSON byte-for-byte", () => {
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
  });
});

describe("Golden vector coverage matrix (§5, §14, §17, T2.1.2)", () => {
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

  it("covers §17 boundary requirements: adjacent holes, 64 KiB records, non-ASCII UTF-8, and IEEE-754 scale pins", () => {
    assert.ok(s.tags.has("adjacent_holes"), "Missing adjacent_holes vectors");
    assert.ok(s.tags.has("unicode:nbsp"), "Missing U+00A0 vectors");
    assert.ok(s.tags.has("unicode:ideographic_space"), "Missing U+3000 vectors");
    assert.ok(s.tags.has("unicode:combining"), "Missing combining-mark vectors");
    assert.ok(s.tags.has("unicode:emoji"), "Missing emoji vectors");
    assert.ok(s.tags.has("boundary:64kib"), "Missing 64 KiB record vectors");
    assert.equal(s.maxRecordBytes, 65536, "Expected exact 65536-byte (64 KiB) text record");

    // Verify exact §5/§17 IEEE-754 double hex for 1999 / 100 vs 1999 * 0.01
    assert.equal(float64ToHex(1999 / 100), "4033fd70a3d70a3d");
    assert.equal(float64ToHex(1999 * 0.01), "4033fd70a3d70a3e");
    assert.equal(hexToFloat64("4033fd70a3d70a3d"), 19.99);
  });

  it("keeps §5 canonical vector ParserSpec structurally identical to T2.1.1 fixture", () => {
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

describe("Negative validation checks: malformed vectors are rejected", () => {
  const sampleSuite = JSON.parse(
    fs.readFileSync(path.join(VECTORS_DIR, "suites", "01-holes-word-int-float.json"), "utf8")
  );
  const jsonSuite = JSON.parse(
    fs.readFileSync(path.join(VECTORS_DIR, "suites", "03-holes-quoted-json-until-rest.json"), "utf8")
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
    const floatVec = sampleSuite.vectors.find((v) => v.id === "vec_hole_float_point_one_006");
    const bad = singleVectorSuite(sampleSuite, floatVec);
    bad.vectors[0].expected.fields.f.value = 0.1;
    const errs = validateVectorSuiteDocument(bad, validator);
    assert.ok(errs.length > 0, "Expected float numeric encoding to fail schema validation");
  });

  it("rejects int64 overflow inside an ok int result", () => {
    const intVec = sampleSuite.vectors.find((v) => v.id === "vec_hole_int_max_int64_008");
    const bad = singleVectorSuite(sampleSuite, intVec);
    bad.vectors[0].expected.fields.n.value = "9223372036854775808";
    const errs = validateVectorSuiteDocument(bad, validator);
    assert.ok(errs.some((e) => e.includes("out of int64 bounds")));
  });

  it("rejects SQL-refused json-hole spec if marked sql.supported: true", () => {
    const jsonVec = jsonSuite.vectors.find((v) => v.id === "vec_hole_json_flat_object_001");
    const bad = singleVectorSuite(jsonSuite, jsonVec);
    bad.vectors[0].sql = { supported: true };
    const errs = validateVectorSuiteDocument(bad, validator);
    assert.ok(errs.some((e) => e.includes("sql.supported must be false")));
  });

  it("rejects SQL-supported spec if erroneously tagged sql:refuse", () => {
    const wordVec = sampleSuite.vectors.find((v) => v.id === "vec_hole_word_basic_001");
    const bad = singleVectorSuite(sampleSuite, wordVec);
    bad.vectors[0].tags.push("sql:refuse");
    const errs = validateVectorSuiteDocument(bad, validator);
    assert.ok(errs.some((e) => e.includes("must not carry sql:refuse")));
  });

  it("rejects expected.fields missing a declared field", () => {
    const wordVec = sampleSuite.vectors.find((v) => v.id === "vec_hole_word_basic_001");
    const bad = singleVectorSuite(sampleSuite, wordVec);
    bad.vectors[0].expected.fields = {};
    const errs = validateVectorSuiteDocument(bad, validator);
    assert.ok(errs.some((e) => e.includes("do not match spec.fields")));
  });

  it("rejects spec with undeclared hole reference", () => {
    const wordVec = sampleSuite.vectors.find((v) => v.id === "vec_hole_word_basic_001");
    const bad = singleVectorSuite(sampleSuite, wordVec);
    bad.vectors[0].spec.fields[0].from = { hole: "missing_hole" };
    const errs = validateVectorSuiteDocument(bad, validator);
    assert.ok(errs.some((e) => e.includes('undeclared hole "missing_hole"')));
  });

  it("rejects corrupted expected value caught by independent reference evaluator", () => {
    const wordVec = sampleSuite.vectors.find((v) => v.id === "vec_hole_word_basic_001");
    const bad = singleVectorSuite(sampleSuite, wordVec);
    bad.vectors[0].expected.fields.val.value = "wrong_value";
    const errs = validateVectorSuiteDocument(bad, validator);
    assert.ok(errs.some((e) => e.includes("reference evaluator mismatch")));
  });
});
