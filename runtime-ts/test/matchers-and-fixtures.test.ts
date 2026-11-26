import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkFieldExpectations,
  computeHostedPseudonymTag,
  parseFixturePayload,
  parseRecord,
  runVectorCases,
  type ParserSpec,
} from "../src/index.js";

const SPEC_FIXTURES_DIR = path.resolve(import.meta.dirname, "../../spec/fixtures/valid");

describe("match kinds (text, object, args) and predecessor spec/fixtures/valid", () => {
  it("passes spec/fixtures/valid/parser-spec-section5-text.json end-to-end", () => {
    const raw = fs.readFileSync(
      path.join(SPEC_FIXTURES_DIR, "parser-spec-section5-text.json"),
      "utf8",
    );
    const cases = parseFixturePayload(raw, "parser-spec-section5-text.json");
    const report = runVectorCases(cases);
    expect(report.total).toBe(1);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.results[0]).toMatchObject({
      matched: true,
      spans: {
        order_id: { start: 6, end: 14 },
        amount: { start: 20, end: 24 },
        elapsed: { start: 28, end: 31 },
      },
      fields: {
        order_id: { status: "ok", type: "string", value: "ord_8f2a" },
        amount_usd: { status: "ok", type: "float", value_hex: "4033fd70a3d70a3d" },
        duration_ms: { status: "ok", type: "int", value: "212" },
      },
    });
  });

  it("matches parser-spec-object-pure (including extra keys and prototype safety)", () => {
    const spec: ParserSpec = {
      spec_version: 1,
      template: "tpl_01JD8Q4OBJ2",
      event: "payment.failed",
      version: 2,
      status: "active",
      origin: "user",
      source: { kind: "callsite", repo: "github.com/acme/shop", path: "src/payments/stripe.ts", line: 204 },
      match: {
        kind: "object",
        shape: ["error.code", "error.message", "retryable", "meta"],
      },
      fields: [
        { id: "fld_01JD8Q4P01", name: "error_type", from: { path: "error.code" }, type: "string", semantic: "error.type" },
        { id: "fld_01JD8Q4P02", name: "error_message", from: { path: "error.message" }, type: "string", semantic: "error.message" },
        { id: "fld_01JD8Q4P03", name: "is_retryable", from: { path: "retryable" }, type: "bool", semantic: "flag" },
        { id: "fld_01JD8Q4P04", name: "metadata", from: { path: "meta" }, type: "json", semantic: "unknown" },
      ],
      tests: [],
    };

    const res = parseRecord(spec, {
      object: {
        pid: 1234, // extra key allowed
        error: { code: "card_declined", message: "insufficient funds" },
        retryable: false,
        meta: { gateway: "stripe" },
      },
    });
    expect(
      checkFieldExpectations(spec, res, {
        error_type: "card_declined",
        error_message: "insufficient funds",
        is_retryable: false,
        metadata: { gateway: "stripe" },
      }),
    ).toEqual([]);

    // Missing required shape key -> no match
    expect(parseRecord(spec, { object: { error: { code: "x" }, retryable: false, meta: {} } }).matched).toBe(false);

    // Prototype keys (toString, constructor) must not satisfy required shape
    const protoSpec: ParserSpec = {
      ...spec,
      match: { kind: "object", shape: ["toString"] },
      fields: [],
    };
    expect(parseRecord(protoSpec, { object: {} }).matched).toBe(false);

    // Raw object whose sole top-level key is literally named "object"
    const objKeySpec: ParserSpec = {
      ...spec,
      match: { kind: "object", shape: ["object.id"] },
      fields: [
        { id: "fld_01OBJKEY", name: "obj_id", from: { path: "object.id" }, type: "string", semantic: "id.item" },
      ],
    };
    const objKeyRes = parseRecord(objKeySpec, { object: { id: "obj_42" } });
    expect(objKeyRes.matched).toBe(true);
    if (objKeyRes.matched) {
      expect(objKeyRes.fields["obj_id"]!.value).toBe("obj_42");
    }
  });

  it("matches parser-spec-object-with-message (combined path + message hole extraction)", () => {
    const spec: ParserSpec = {
      spec_version: 1,
      template: "tpl_01JD8Q4OBJ1",
      event: "http.request.completed",
      version: 1,
      status: "active",
      origin: "agent",
      source: { kind: "callsite", repo: "github.com/acme/shop", path: "src/http/middleware.ts", line: 88 },
      match: {
        kind: "object",
        shape: ["msg", "req.method", "req.path", "res.statusCode", "latency_s"],
        message: {
          path: "msg",
          segments: [
            { lit: "request " },
            { hole: "req_id", class: "uuid" },
            { lit: " completed" },
          ],
        },
      },
      fields: [
        { id: "fld_01JD8Q4F01", name: "request_id", from: { hole: "req_id" }, type: "string", semantic: "id.request" },
        {
          id: "fld_01JD8Q4F02",
          name: "http_method",
          from: { path: "req.method" },
          type: "enum",
          semantic: "http.method",
          transforms: [
            { op: "lower" },
            { op: "enum_map", map: { get: "GET", post: "POST", put: "PUT", delete: "DELETE" }, default: "OTHER" },
          ],
        },
        { id: "fld_01JD8Q4F03", name: "url_path", from: { path: "req.path" }, type: "string", semantic: "url.path" },
        { id: "fld_01JD8Q4F04", name: "status_code", from: { path: "res.statusCode" }, type: "int", semantic: "http.status" },
        {
          id: "fld_01JD8Q4F05",
          name: "duration_ms",
          from: { path: "latency_s" },
          type: "float",
          semantic: "duration",
          unit: "ms",
          transforms: [{ op: "unit", from: "s", to: "ms" }],
        },
      ],
      tests: [],
    };

    const res = parseRecord(spec, {
      object: {
        msg: "request 550e8400-e29b-41d4-a716-446655440000 completed",
        req: { method: "post", path: "/v1/orders" },
        res: { statusCode: 201 },
        latency_s: 0.145,
      },
    });
    expect(res.matched).toBe(true);
    if (res.matched) {
      expect(res.spans["req_id"]).toEqual({ start: 8, end: 44 });
    }
    expect(
      checkFieldExpectations(spec, res, {
        request_id: "550e8400-e29b-41d4-a716-446655440000",
        http_method: "POST",
        url_path: "/v1/orders",
        status_code: 201,
        duration_ms: 145,
      }),
    ).toEqual([]);

    // Non-matching message subpattern rejects the object
    expect(
      parseRecord(spec, {
        object: {
          msg: "request NOT-A-UUID completed",
          req: { method: "post", path: "/v1/orders" },
          res: { statusCode: 201 },
          latency_s: 0.145,
        },
      }).matched,
    ).toBe(false);
  });

  it("matches parser-spec-args (with and without template strings verification)", () => {
    const spec: ParserSpec = {
      spec_version: 1,
      template: "tpl_01JD8Q5ARGS",
      event: "order.paid",
      version: 1,
      status: "active",
      origin: "agent",
      source: { kind: "sdk_template" },
      match: { kind: "args", strings: ["", " paid ", " in ", "ms"] },
      fields: [
        { id: "fld_01JD8Q2M9A", name: "order_id", from: { arg: 0 }, type: "string", semantic: "id.order" },
        {
          id: "fld_01JD8Q2M9B",
          name: "amount_usd",
          from: { arg: 1 },
          type: "float",
          semantic: "money",
          transforms: [{ op: "scale", div: 100 }],
        },
        { id: "fld_01JD8Q2M9C", name: "duration_ms", from: { arg: 2 }, type: "int", semantic: "duration" },
      ],
      tests: [],
    };

    const res = parseRecord(spec, {
      strings: ["", " paid ", " in ", "ms"],
      args: ["ord_8f2a", 1999, 212],
    });
    expect(
      checkFieldExpectations(spec, res, {
        order_id: "ord_8f2a",
        amount_usd: 19.99,
        duration_ms: 212,
      }),
    ).toEqual([]);

    // Mismatched literal strings or wrong arity fails match
    expect(
      parseRecord(spec, {
        strings: ["", " refunded ", " in ", "ms"],
        args: ["ord_8f2a", 1999, 212],
      }).matched,
    ).toBe(false);
    expect(parseRecord(spec, { args: ["ord_8f2a", 1999] }).matched).toBe(false);
  });

  it("matches parser-spec-mined-zero-fields and parser-spec-all-transforms (all 11 holes & 9 transforms)", () => {
    const zeroSpec: ParserSpec = {
      spec_version: 1,
      template: "tpl_01JD8Q7ZERO",
      event: "server.started",
      version: 1,
      status: "retired",
      origin: "user",
      source: { kind: "mined" },
      match: { kind: "text", segments: [{ lit: "server ready and listening" }] },
      fields: [],
      tests: [],
    };
    const zeroRes = parseRecord(zeroSpec, "server ready and listening");
    expect(zeroRes.matched).toBe(true);
    if (zeroRes.matched) expect(zeroRes.fields).toEqual({});

    const allSpec: ParserSpec = {
      spec_version: 1,
      template: "tpl_01JD8Q6ALL9",
      event: "audit.catalog.exercised",
      version: 1,
      status: "provisional",
      origin: "agent",
      source: { kind: "mined" },
      match: {
        kind: "text",
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
      },
      fields: [
        { id: "fld_01", name: "event_time", from: { hole: "ts_raw" }, type: "timestamp", semantic: "unknown", transforms: [{ op: "parse_time", format: "iso8601" }] },
        { id: "fld_02", name: "request_id", from: { hole: "req_uuid" }, type: "string", semantic: "id.request" },
        { id: "fld_03", name: "trace_id", from: { hole: "trace_hex" }, type: "string", semantic: "id.trace" },
        { id: "fld_04", name: "client_ip", from: { hole: "client_ip" }, type: "string", semantic: "ip", pii: "ip", transforms: [{ op: "mask", mode: "ip_prefix" }] },
        { id: "fld_05", name: "user_email", from: { hole: "user_email" }, type: "string", semantic: "email", pii: "email", transforms: [{ op: "lower" }, { op: "hash", kind: "email" }] },
        { id: "fld_06", name: "customer_name", from: { hole: "full_name" }, type: "string", semantic: "text", pii: "name", transforms: [{ op: "mask", mode: "token", kind: "name" }] },
        { id: "fld_07", name: "cache_hit_pct", from: { hole: "hit_ratio" }, type: "float", semantic: "ratio", transforms: [{ op: "scale", mul: 100 }] },
        { id: "fld_08", name: "items_flag", from: { hole: "item_count" }, type: "bool", semantic: "flag", transforms: [{ op: "cast", to: "bool" }] },
        { id: "fld_09", name: "payload_bytes", from: { hole: "size_kib" }, type: "int", semantic: "bytes", transforms: [{ op: "unit", from: "KiB", to: "B" }] },
        { id: "fld_10", name: "severity_bucket", from: { hole: "level_raw" }, type: "enum", semantic: "version", transforms: [{ op: "lower" }, { op: "enum_map", map: { v1: "1", v2: "2" }, default: "unknown" }] },
        { id: "fld_11", name: "redacted_secret", from: { hole: "api_secret" }, type: "string", semantic: "unknown", pii: "secret", transforms: [{ op: "drop" }] },
        { id: "fld_12", name: "payload_obj", from: { hole: "extra_json" }, type: "json", semantic: "unknown" },
        { id: "fld_13", name: "note_text", from: { hole: "free_note" }, type: "string", semantic: "text", pii: "free_text", transforms: [{ op: "drop" }] },
      ],
      tests: [],
    };

    const edgeKey = "test-edge-key";
    const serverKey = "test-server-key";
    const expectedEmailTag = computeHostedPseudonymTag(edgeKey, serverKey, "alice@example.com");

    const line =
      'ts=2026-11-26T14:00:00Z id=550e8400-e29b-41d4-a716-446655440000 trace=deadbeef ip=203.0.113.42 user=Alice@Example.COM name="Alice Smith" ratio=0.75 count=1 size=4 lvl=V2 secret=tok_123 payload={"k":1} note=hello world';
    const res = parseRecord(allSpec, line, { hashKeys: { edgeKey, serverKey } });

    expect(
      checkFieldExpectations(allSpec, res, {
        event_time: 1795701600000,
        request_id: "550e8400-e29b-41d4-a716-446655440000",
        trace_id: "deadbeef",
        client_ip: "203.0.113.0/24",
        user_email: `<email:${expectedEmailTag}>`,
        customer_name: null,
        cache_hit_pct: 75,
        items_flag: true,
        payload_bytes: 4096,
        severity_bucket: "2",
        redacted_secret: null,
        payload_obj: { k: 1 },
        note_text: null,
      }),
    ).toEqual([]);
  });
});
