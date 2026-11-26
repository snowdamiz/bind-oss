import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  SPEC_ROOT,
  createValidator,
  loadDocument,
} from "../scripts/validate.mjs";

const VALID_DIR = path.join(SPEC_ROOT, "fixtures", "valid");
const INVALID_DIR = path.join(SPEC_ROOT, "fixtures", "invalid");

const validator = createValidator();

function clone(value) {
  return structuredClone(value);
}

describe("Schema compilation and closed catalogs (§5)", () => {
  it("compiles common, parser-spec, and event-type schemas under Draft 2020-12 strict mode", () => {
    assert.equal(
      validator.schemas.common.$schema,
      "https://json-schema.org/draft/2020-12/schema"
    );
    assert.equal(
      validator.schemas.parserSpec.$schema,
      "https://json-schema.org/draft/2020-12/schema"
    );
    assert.equal(
      validator.schemas.eventType.$schema,
      "https://json-schema.org/draft/2020-12/schema"
    );
  });

  it("matches the exact closed catalogs declared in §5", () => {
    const defs = validator.schemas.common.$defs;

    assert.deepEqual(defs.MatchKind.enum, ["text", "object", "args"]);
    assert.deepEqual(defs.HoleClass.enum, [
      "word",
      "int",
      "float",
      "uuid",
      "hex",
      "ip",
      "time",
      "quoted",
      "json",
      "until",
      "rest",
    ]);
    assert.deepEqual(defs.TransformOp.enum, [
      "cast",
      "scale",
      "unit",
      "parse_time",
      "lower",
      "enum_map",
      "hash",
      "mask",
      "drop",
    ]);
    assert.deepEqual(defs.FieldType.enum, [
      "string",
      "int",
      "float",
      "bool",
      "timestamp",
      "enum",
      "json",
    ]);
    assert.deepEqual(defs.PiiClass.enum, [
      "none",
      "pseudonymous_id",
      "email",
      "phone",
      "ip",
      "name",
      "address",
      "secret",
      "free_text",
    ]);
    assert.deepEqual(defs.SpecStatus.enum, ["provisional", "active", "retired"]);
    assert.deepEqual(defs.SpecOrigin.enum, ["agent", "user"]);
    assert.deepEqual(defs.SourceKind.enum, ["callsite", "sdk_template", "mined"]);
    assert.equal(defs.StorageSlot.enum.length, 59);
  });
});

describe("Valid fixtures (§5 examples, matcher variants, transforms, slots)", () => {
  const validParserSpecs = [
    "parser-spec-section5-text.yaml",
    "parser-spec-section5-text.json",
    "parser-spec-object-with-message.yaml",
    "parser-spec-object-pure.yaml",
    "parser-spec-args.yaml",
    "parser-spec-all-transforms.yaml",
    "parser-spec-mined-zero-fields.yaml",
  ];

  for (const filename of validParserSpecs) {
    it(`accepts valid ParserSpec fixture: ${filename}`, () => {
      const doc = loadDocument(path.join(VALID_DIR, filename));
      const result = validator.validateParserSpec(doc);
      assert.equal(
        result.valid,
        true,
        `Expected ${filename} to be valid, got errors:\n${result.formattedErrors.join("\n")}`
      );
    });
  }

  const validEventTypes = [
    "event-type-section5.yaml",
    "event-type-section5.json",
    "event-type-all-slot-families.yaml",
  ];

  for (const filename of validEventTypes) {
    it(`accepts valid EventType fixture: ${filename}`, () => {
      const doc = loadDocument(path.join(VALID_DIR, filename));
      const result = validator.validateEventType(doc);
      assert.equal(
        result.valid,
        true,
        `Expected ${filename} to be valid, got errors:\n${result.formattedErrors.join("\n")}`
      );
    });
  }

  it("keeps §5 YAML and canonical JSON fixtures structurally identical", () => {
    const specYaml = loadDocument(path.join(VALID_DIR, "parser-spec-section5-text.yaml"));
    const specJson = loadDocument(path.join(VALID_DIR, "parser-spec-section5-text.json"));
    assert.deepEqual(specYaml, specJson);

    const evtYaml = loadDocument(path.join(VALID_DIR, "event-type-section5.yaml"));
    const evtJson = loadDocument(path.join(VALID_DIR, "event-type-section5.json"));
    assert.deepEqual(evtYaml, evtJson);
  });
});

describe("Malformed fixtures fail with clear diagnostic messages", () => {
  const invalidParserSpecCases = [
    {
      file: "01-unknown-match-kind.yaml",
      expectPath: "/match/kind",
      expectFragment: "text, object, args",
    },
    {
      file: "02-unknown-hole-class.yaml",
      expectPath: "/match/segments/1/class",
      expectFragment: "word, int, float",
    },
    {
      file: "03-scale-fractional-mul.yaml",
      expectPath: "/fields/0/transforms/0/mul",
      expectFragment: "expected type integer",
    },
    {
      file: "04-scale-both-mul-and-div.yaml",
      expectPath: "/fields/0/transforms/0",
      expectFragment: 'exactly one of "mul" or "div"',
    },
    {
      file: "05-scale-div-by-zero.yaml",
      expectPath: "/fields/0/transforms/0/div",
      expectFragment: "must not be 0",
    },
    {
      file: "06-unknown-transform-op.yaml",
      expectPath: "/fields/0/transforms/0/op",
      expectFragment: "cast, scale, unit, parse_time, lower, enum_map, hash, mask, drop",
    },
    {
      file: "07-unit-cross-dimension.yaml",
      expectPath: "/fields/0/transforms/0",
      expectFragment: "same dimension",
    },
    {
      file: "08-invalid-semantic.yaml",
      expectPath: "/fields/0/semantic",
      expectFragment: "id.<entity>",
    },
    {
      file: "09-invalid-pii-class.yaml",
      expectPath: "/fields/0/pii",
      expectFragment: "none, pseudonymous_id, email",
    },
    {
      file: "10-args-with-hole-from.yaml",
      expectPath: "/fields/0/from",
      expectFragment: 'missing required property "arg"',
    },
    {
      file: "11-object-without-message-hole-from.yaml",
      expectPath: "/fields/0/from",
      expectFragment: 'missing required property "path"',
    },
    {
      file: "12-text-with-path-from.yaml",
      expectPath: "/fields/0/from",
      expectFragment: 'missing required property "hole"',
    },
    {
      file: "13-callsite-missing-location.yaml",
      expectPath: "/source",
      expectFragment: 'missing required property "repo"',
    },
    {
      file: "14-additional-property.yaml",
      expectPath: "<root>",
      expectFragment: 'unexpected property "unexpected_flag"',
    },
    {
      file: "15-missing-tests.yaml",
      expectPath: "/tests",
      expectFragment: "at least 1 item",
    },
    {
      file: "16-bad-template-id.yaml",
      expectPath: "/template",
      expectFragment: "^tpl_",
    },
    {
      file: "17-bad-spec-version.yaml",
      expectPath: "/spec_version",
      expectFragment: "expected 1",
    },
  ];

  for (const tc of invalidParserSpecCases) {
    it(`rejects malformed ParserSpec: ${tc.file}`, () => {
      const doc = loadDocument(path.join(INVALID_DIR, tc.file));
      const result = validator.validateParserSpec(doc);
      assert.equal(result.valid, false, `Expected ${tc.file} to fail validation`);
      assert.ok(result.formattedErrors.length > 0, "Expected at least one formatted error");

      const combined = result.formattedErrors.join("\n");
      assert.ok(
        combined.includes(tc.expectPath),
        `Expected error for ${tc.file} to include path "${tc.expectPath}", got:\n${combined}`
      );
      assert.ok(
        combined.includes(tc.expectFragment),
        `Expected error for ${tc.file} to include "${tc.expectFragment}", got:\n${combined}`
      );
    });
  }

  const invalidEventTypeCases = [
    {
      file: "18-event-type-slot-type-mismatch.yaml",
      expectPath: "/fields/0/slot",
      expectFragment: "incompatible with the field's declared type",
    },
    {
      file: "19-event-type-invalid-slot.yaml",
      expectPath: "/fields/0/slot",
      expectFragment: "expected one of",
    },
    {
      file: "20-event-type-bad-id-prefix.yaml",
      expectPath: "/id",
      expectFragment: "^evt_",
    },
  ];

  for (const tc of invalidEventTypeCases) {
    it(`rejects malformed EventType: ${tc.file}`, () => {
      const doc = loadDocument(path.join(INVALID_DIR, tc.file));
      const result = validator.validateEventType(doc);
      assert.equal(result.valid, false, `Expected ${tc.file} to fail validation`);
      assert.ok(result.formattedErrors.length > 0, "Expected at least one formatted error");

      const combined = result.formattedErrors.join("\n");
      assert.ok(
        combined.includes(tc.expectPath),
        `Expected error for ${tc.file} to include path "${tc.expectPath}", got:\n${combined}`
      );
      assert.ok(
        combined.includes(tc.expectFragment),
        `Expected error for ${tc.file} to include "${tc.expectFragment}", got:\n${combined}`
      );
    });
  }
});

describe("Targeted matcher, transform, and slot edge cases", () => {
  const baseTextSpec = loadDocument(path.join(VALID_DIR, "parser-spec-section5-text.json"));
  const baseArgsSpec = loadDocument(path.join(VALID_DIR, "parser-spec-args.yaml"));
  const baseObjMsgSpec = loadDocument(path.join(VALID_DIR, "parser-spec-object-with-message.yaml"));
  const baseEventType = loadDocument(path.join(VALID_DIR, "event-type-section5.json"));

  it("rejects mismatched test input shapes across match kinds", () => {
    const badTextTest = clone(baseTextSpec);
    badTextTest.tests = [{ args: ["ord_1", 100, 10], expect: {} }];
    assert.equal(validator.validateParserSpec(badTextTest).valid, false);

    const badArgsTest = clone(baseArgsSpec);
    badArgsTest.tests = [{ line: "ord_1 paid 100 in 10ms", expect: {} }];
    assert.equal(validator.validateParserSpec(badArgsTest).valid, false);

    const badObjTest = clone(baseObjMsgSpec);
    badObjTest.tests = [{ line: "not an object", expect: {} }];
    assert.equal(validator.validateParserSpec(badObjTest).valid, false);
  });

  it("rejects from.arg inside object match even when message sub-pattern is present", () => {
    const doc = clone(baseObjMsgSpec);
    doc.fields[0].from = { arg: 0 };
    assert.equal(validator.validateParserSpec(doc).valid, false);
  });

  it("rejects duplicate paths in object match shape", () => {
    const doc = clone(baseObjMsgSpec);
    doc.match.shape.push("msg");
    const result = validator.validateParserSpec(doc);
    assert.equal(result.valid, false);
    assert.ok(result.formattedErrors.join("\n").includes("duplicate"));
  });

  it("enforces scale transform integer and non-zero rules", () => {
    const missingBoth = clone(baseTextSpec);
    missingBoth.fields[1].transforms = [{ op: "scale" }];
    assert.equal(validator.validateParserSpec(missingBoth).valid, false);

    const zeroMul = clone(baseTextSpec);
    zeroMul.fields[1].transforms = [{ op: "scale", mul: 0 }];
    assert.equal(validator.validateParserSpec(zeroMul).valid, false);

    const negMul = clone(baseTextSpec);
    negMul.fields[1].transforms = [{ op: "scale", mul: -1 }];
    assert.equal(validator.validateParserSpec(negMul).valid, true);
  });

  it("rejects empty enum_map and unknown parse_time format, accepts default parse_time", () => {
    const emptyEnum = clone(baseTextSpec);
    emptyEnum.fields[0].transforms = [{ op: "enum_map", map: {} }];
    assert.equal(validator.validateParserSpec(emptyEnum).valid, false);

    const badTime = clone(baseTextSpec);
    badTime.fields[0].transforms = [{ op: "parse_time", format: "%Y-%m-%d" }];
    assert.equal(validator.validateParserSpec(badTime).valid, false);

    const defaultTime = clone(baseTextSpec);
    defaultTime.fields[0].transforms = [{ op: "parse_time" }];
    assert.equal(validator.validateParserSpec(defaultTime).valid, true);
  });

  it("rejects enum/json in actor slot and duplicate templates on EventType", () => {
    const enumInActor = clone(baseEventType);
    enumInActor.fields[0] = {
      id: "fld_01JD8Q2M9A",
      name: "status",
      type: "enum",
      semantic: "text",
      slot: "actor",
    };
    assert.equal(validator.validateEventType(enumInActor).valid, false);

    const dupTemplates = clone(baseEventType);
    dupTemplates.templates = ["tpl_01JD8Q2M4K", "tpl_01JD8Q2M4K"];
    assert.equal(validator.validateEventType(dupTemplates).valid, false);
  });

  it("allows every field type to overflow to the extra slot", () => {
    const types = ["string", "int", "float", "bool", "timestamp", "enum", "json"];
    const doc = clone(baseEventType);
    doc.fields = types.map((type, idx) => ({
      id: `fld_01JD8Q9EX0${idx}`,
      name: `field_${type}`,
      type,
      semantic: "unknown",
      slot: "extra",
    }));
    const result = validator.validateEventType(doc);
    assert.equal(result.valid, true, result.formattedErrors.join("\n"));
  });
});

describe("Scope boundary: runtime and registry invariants intentionally outside JSON Schema", () => {
  const baseTextSpec = loadDocument(path.join(VALID_DIR, "parser-spec-section5-text.json"));
  const baseArgsSpec = loadDocument(path.join(VALID_DIR, "parser-spec-args.yaml"));
  const baseEventType = loadDocument(path.join(VALID_DIR, "event-type-section5.json"));

  it("leaves cross-reference and lexer grammar invariants to runtime/registry validation", () => {
    // 1. Undeclared hole reference (cross-reference invariant -> runtime/registry)
    const missingHoleRef = clone(baseTextSpec);
    missingHoleRef.fields[0].from = { hole: "undeclared_hole" };
    assert.equal(validator.validateParserSpec(missingHoleRef).valid, true);

    // 2. Arg index exceeding strings.length - 1 (cross-reference invariant -> runtime/registry)
    const outOfRangeArg = clone(baseArgsSpec);
    outOfRangeArg.fields[0].from = { arg: 99 };
    assert.equal(validator.validateParserSpec(outOfRangeArg).valid, true);

    // 3. `until` as final segment without trailing literal (lexer grammar invariant -> runtime/registry)
    const trailingUntil = clone(baseTextSpec);
    trailingUntil.match.segments = [{ lit: "prefix " }, { hole: "order_id", class: "until" }];
    assert.equal(validator.validateParserSpec(trailingUntil).valid, true);

    // 4. Transform pipeline type mismatch (type-checker invariant -> runtime/registry)
    const scaleOnString = clone(baseTextSpec);
    scaleOnString.fields[0].transforms = [{ op: "scale", div: 100 }];
    assert.equal(validator.validateParserSpec(scaleOnString).valid, true);

    // 5. Duplicate slot assignment across fields (registry uniqueness invariant -> registry)
    const duplicateSlot = clone(baseEventType);
    duplicateSlot.fields = [
      { id: "fld_01JD8Q2M9A", name: "first_str", type: "string", semantic: "text", slot: "s01" },
      { id: "fld_01JD8Q2M9E", name: "second_str", type: "string", semantic: "text", slot: "s01" },
    ];
    assert.equal(validator.validateEventType(duplicateSlot).valid, true);
  });
});
