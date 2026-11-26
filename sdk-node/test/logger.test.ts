import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createLogger,
  flush,
  init,
  log,
  Severity,
  shutdown,
  type BatchIdentity,
  type LogRecordInput,
  type RecordSink,
  type TransportError,
  type TransportStats,
} from "../src/index.js";
import { FakeIngestServer } from "./fake-server.js";

class MemorySink implements RecordSink {
  readonly identity: Readonly<BatchIdentity> = Object.freeze({
    service: "checkout",
    env: "test",
    release: "r1",
  });
  readonly records: LogRecordInput[] = [];
  throwOnEnqueue = false;

  enqueue(record: LogRecordInput): boolean {
    if (this.throwOnEnqueue) {
      throw new Error("sink exploded");
    }
    this.records.push(record);
    return true;
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  getStats(): TransportStats {
    return {
      queuedRecords: this.records.length,
      queuedBytes: 0,
      pendingDropped: 0,
      totalEnqueued: this.records.length,
      totalDropped: 0,
      totalSentRecords: 0,
      totalSentBatches: 0,
      totalFailedBatches: 0,
      totalRetries: 0,
      closed: false,
    };
  }
}

describe("tagged-template and structured log capture API", () => {
  it("captures literal parts and typed argument values separately across all severity levels", () => {
    const sink = new MemorySink();
    const logger = createLogger(sink, { callsite: { enabled: false } });

    const id = "ord_42";
    const cents = 1999;
    const paid = true;
    const discount = null;
    const coupon = undefined;
    const big = 90071992547409931234n;
    const when = new Date("2026-11-26T15:00:00.000Z");
    const err = new TypeError("card declined");
    (err as Error & { code?: string }).code = "CARD_DECLINED";
    const meta = { region: "us-east", retries: 2 };
    const items = ["sku_1", 3, false];

    assert.equal(logger.trace`trace ${id}`, true);
    assert.equal(logger.debug`debug ${cents} ${paid}`, true);
    assert.equal(
      logger.info`order ${id} paid ${cents} confirmed=${paid} discount=${discount} coupon=${coupon} big=${big} at=${when}`,
      true,
    );
    assert.equal(logger.warn`meta=${meta} items=${items} nan=${Number.NaN} inf=${Number.POSITIVE_INFINITY} negZero=${-0}`, true);
    assert.equal(logger.error`payment failed: ${err}`, true);
    assert.equal(logger.fatal`shutdown code=${503}`, true);

    assert.equal(sink.records.length, 6);
    assert.equal(sink.records[0]!.severity, Severity.TRACE);
    assert.equal(sink.records[1]!.severity, Severity.DEBUG);
    assert.equal(sink.records[2]!.severity, Severity.INFO);
    assert.equal(sink.records[3]!.severity, Severity.WARN);
    assert.equal(sink.records[4]!.severity, Severity.ERROR);
    assert.equal(sink.records[5]!.severity, Severity.FATAL);

    const infoRec = sink.records[2]!;
    assert.deepEqual(infoRec.tpl, {
      strings: [
        "order ",
        " paid ",
        " confirmed=",
        " discount=",
        " coupon=",
        " big=",
        " at=",
        "",
      ],
      args: [
        "ord_42",
        1999,
        true,
        null,
        null,
        "90071992547409931234",
        "2026-11-26T15:00:00.000Z",
      ],
    });
    // Strict runtime types are preserved in tpl.args
    assert.equal(typeof infoRec.tpl!.args[0], "string");
    assert.equal(typeof infoRec.tpl!.args[1], "number");
    assert.equal(typeof infoRec.tpl!.args[2], "boolean");
    assert.equal(infoRec.tpl!.args[3], null);
    assert.equal(infoRec.tpl!.args[4], null);
    assert.equal(
      infoRec.body,
      "order ord_42 paid 1999 confirmed=true discount=null coupon=undefined big=90071992547409931234 at=2026-11-26T15:00:00.000Z",
    );

    const warnRec = sink.records[3]!;
    assert.deepEqual(warnRec.tpl?.args, [
      { region: "us-east", retries: 2 },
      ["sku_1", 3, false],
      "NaN",
      "Infinity",
      0,
    ]);
    assert.equal(Object.is(warnRec.tpl!.args[4], 0), true);
    assert.equal(
      warnRec.body,
      'meta={"region":"us-east","retries":2} items=["sku_1",3,false] nan=NaN inf=Infinity negZero=0',
    );

    const errRec = sink.records[4]!;
    assert.equal(errRec.body, "payment failed: TypeError: card declined");
    const errArg = errRec.tpl!.args[0] as Record<string, unknown>;
    assert.equal(errArg.name, "TypeError");
    assert.equal(errArg.message, "card declined");
    assert.equal(errArg.code, "CARD_DECLINED");
    assert.equal(typeof errArg.stack, "string");
  });

  it("handles zero-interpolation templates, adjacent holes, invalid escapes, and isolates caller mutations", () => {
    const sink = new MemorySink();
    const logger = createLogger(sink, { callsite: { enabled: false } });

    const payload = { count: 1 };
    logger.info`plain literal template`;
    logger.info`${"a"}${2}`;
    // Invalid unicode escape produces cooked undefined; SDK must fall back to raw string.
    logger.info`\unicode ${payload}`;
    payload.count = 999;

    assert.equal(sink.records.length, 3);
    assert.deepEqual(sink.records[0]!.tpl, {
      strings: ["plain literal template"],
      args: [],
    });
    assert.equal(sink.records[0]!.body, "plain literal template");

    assert.deepEqual(sink.records[1]!.tpl, {
      strings: ["", "", ""],
      args: ["a", 2],
    });
    assert.equal(sink.records[1]!.body, "a2");

    assert.deepEqual(sink.records[2]!.tpl, {
      strings: ["\\unicode ", ""],
      args: [{ count: 1 }],
    });
  });

  it("captures structured event names and typed fields without clobbering user keys named event", () => {
    const sink = new MemorySink();
    const logger = createLogger(sink, { callsite: { enabled: false } });

    const fields = {
      orderId: "ord_99",
      cents: 4250,
      paid: true,
      nested: { currency: "USD", items: [1, 2] },
      ignored: undefined,
      url: new URL("https://bind.dev/orders/99"),
      pattern: /ord_\d+/i,
      tags: new Set(["vip", "fast"]),
      extra: new Map([["tier", "pro"]]),
      bytes: Buffer.from("abc"),
    };

    assert.equal(logger.info("order.paid", fields), true);
    assert.equal(
      logger.warn("webhook.received", { event: "invoice.paid", id: 7 }),
      true,
    );
    assert.equal(logger.info("server.started"), true);
    assert.equal(
      logger.error(
        "checkout.failed",
        { orderId: "ord_99", attempt: 3 },
        {
          attrs: { "http.route": "/checkout" },
          trace_id: "000000000000000000000000000000ab",
          span_id: "00000000000000cd",
          ts: 1_700_000_000_000_000_123n,
          callsite: { file: "src/checkout.ts", line: 88, column: 5, function: "charge" },
        },
      ),
      true,
    );

    assert.equal(sink.records.length, 4);

    const paidRec = sink.records[0]!;
    assert.equal(paidRec.severity, Severity.INFO);
    assert.deepEqual(paidRec.tpl, { strings: ["order.paid"], args: [] });
    assert.deepEqual(paidRec.body, {
      event: "order.paid",
      fields: {
        orderId: "ord_99",
        cents: 4250,
        paid: true,
        nested: { currency: "USD", items: [1, 2] },
        url: "https://bind.dev/orders/99",
        pattern: "/ord_\\d+/i",
        tags: ["vip", "fast"],
        extra: { tier: "pro" },
        bytes: "[Buffer(3)]",
      },
    });

    const webhookRec = sink.records[1]!;
    assert.deepEqual(webhookRec.body, {
      event: "webhook.received",
      fields: { event: "invoice.paid", id: 7 },
    });
    assert.deepEqual(webhookRec.tpl, { strings: ["webhook.received"], args: [] });

    const startedRec = sink.records[2]!;
    assert.deepEqual(startedRec.body, { event: "server.started", fields: {} });
    assert.deepEqual(startedRec.tpl, { strings: ["server.started"], args: [] });

    const failedRec = sink.records[3]!;
    assert.equal(failedRec.severity, Severity.ERROR);
    assert.deepEqual(failedRec.attrs, { "http.route": "/checkout" });
    assert.equal(failedRec.trace_id, "000000000000000000000000000000ab");
    assert.equal(failedRec.span_id, "00000000000000cd");
    assert.equal(failedRec.ts, 1_700_000_000_000_000_123n);
    assert.deepEqual(failedRec.callsite, {
      file: "src/checkout.ts",
      line: 88,
      column: 5,
      function: "charge",
    });
  });

  it("supports child loggers with bound context and pre-init module-level log.child()", async () => {
    await shutdown(0);
    // Before init(), module-level log and its child must safely no-op without throwing.
    const preInitChild = log.child({
      attrs: { component: "billing" },
      trace_id: "trace-1",
      fields: { region: "us-east" },
    });
    assert.equal(log.info`dropped before init ${1}`, false);
    assert.equal(preInitChild.info("order.paid", { cents: 100 }), false);

    const server = new FakeIngestServer();
    const url = await server.start();
    try {
      init({
        key: "bk_test_key",
        endpoint: url,
        service: "billing-svc",
        env: "staging",
        release: "sha-abc",
        flushIntervalMs: 60_000,
        callsite: { enabled: false },
      });

      const nested = preInitChild.child({
        attrs: { handler: "stripe" },
        span_id: "span-9",
        fields: { currency: "USD" },
      });

      assert.equal(nested.info("order.paid", { cents: 500, region: "eu-west" }), true);
      assert.equal(nested.warn`charge retry ${2}`, true);

      await flush();
      assert.equal(server.requests.length, 1);

      const records = server.requests[0]!.envelope.records;
      assert.equal(records.length, 2);

      assert.deepEqual(records[0]!.body, {
        event: "order.paid",
        fields: { region: "eu-west", currency: "USD", cents: 500 },
      });
      assert.deepEqual(records[0]!.attrs, {
        component: "billing",
        handler: "stripe",
      });
      assert.equal(records[0]!.trace_id, "trace-1");
      assert.equal(records[0]!.span_id, "span-9");

      assert.equal(records[1]!.body, "charge retry 2");
      assert.deepEqual(records[1]!.tpl, { strings: ["charge retry ", ""], args: [2] });
      assert.deepEqual(records[1]!.attrs, {
        component: "billing",
        handler: "stripe",
      });
      assert.equal(records[1]!.trace_id, "trace-1");
      assert.equal(records[1]!.span_id, "span-9");
    } finally {
      await shutdown(1_000);
      await server.close();
    }

    assert.equal(log.info`after shutdown ${2}`, false);
  });

  it("handles circular references, shared DAGs, deep nesting, throwing getters/toJSON, and invalid args without throwing or silently dropping errors", () => {
    const sink = new MemorySink();
    const errors: TransportError[] = [];
    const logger = createLogger(sink, {
      callsite: { enabled: false },
      onError: (err) => {
        errors.push(err);
      },
    });

    // Shared DAG must not be mislabeled circular; true cycle becomes [Circular].
    const shared = { id: "s1" };
    const cyclic: Record<string, unknown> = { name: "root", first: shared, second: shared };
    cyclic.self = cyclic;

    // Deep nesting past MAX_NORMALIZE_DEPTH is capped safely.
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 40; i += 1) {
      deep = { child: deep };
    }

    // Throwing getter and throwing toJSON must not throw into caller AND must report capture_error.
    const hostileFields: Record<string, unknown> = { ok: 42 };
    Object.defineProperty(hostileFields, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter exploded");
      },
    });
    const badToJson = {
      toJSON() {
        throw new Error("toJSON exploded");
      },
    };

    assert.equal(logger.info("graph.check", { cyclic, deep }), true);
    assert.equal(logger.info("hostile.fields", hostileFields), true);
    assert.equal(logger.info`bad=${badToJson} ok=${7}`, true);

    // Invalid first arg, non-plain fields, non-string attrs must not throw and must report errors.
    assert.equal((logger.info as unknown as (a: unknown) => boolean)(123), false);
    assert.equal((logger.info as unknown as (a: string, b: unknown) => boolean)("bad.fields", [1, 2]), false);
    assert.equal(
      logger.info(
        "bad.attr",
        { a: 1 },
        { attrs: { good: "yes", bad: 123 as unknown as string } },
      ),
      true,
    );

    assert.equal(sink.records.length, 4);

    const graphBody = sink.records[0]!.body as { event: string; fields: Record<string, unknown> };
    const normCyclic = graphBody.fields.cyclic as Record<string, unknown>;
    assert.deepEqual(normCyclic.first, { id: "s1" });
    assert.deepEqual(normCyclic.second, { id: "s1" });
    assert.equal(normCyclic.self, "[Circular]");

    // Verify deep nesting hit [MaxDepth] without stack overflow.
    assert.ok(JSON.stringify(graphBody.fields.deep).includes("[MaxDepth]"));

    const hostileBody = sink.records[1]!.body as { event: string; fields: Record<string, unknown> };
    assert.equal(hostileBody.fields.ok, 42);
    assert.equal(hostileBody.fields.boom, "[Unserializable]");

    const badJsonRec = sink.records[2]!;
    assert.deepEqual(badJsonRec.tpl, {
      strings: ["bad=", " ok=", ""],
      args: ["[Unserializable]", 7],
    });

    const badAttrRec = sink.records[3]!;
    assert.deepEqual(badAttrRec.attrs, { good: "yes" });

    // Throwing getter inside child() context attrs must not throw in child() or emit(), and must report capture_error.
    const hostileAttrs: Record<string, string> = { safe: "ok" };
    Object.defineProperty(hostileAttrs, "badAttr", {
      enumerable: true,
      get() {
        throw new Error("child attr getter exploded");
      },
    });
    const hostileChild = logger.child({ attrs: hostileAttrs });
    assert.equal(hostileChild.info`child safe ${1}`, true);
    assert.deepEqual(sink.records[4]!.attrs, { safe: "ok" });

    // Every internal error was surfaced via onError (no silent swallowing).
    assert.ok(errors.length >= 6);
    assert.ok(errors.every((e) => e.code === "capture_error"));

    // Throwing sink and throwing onError callback must still never throw into customer code.
    sink.throwOnEnqueue = true;
    const resilient = createLogger(sink, {
      callsite: { enabled: false },
      onError: () => {
        throw new Error("callback exploded");
      },
    });
    assert.doesNotThrow(() => {
      assert.equal(resilient.info`must not throw ${1}`, false);
    });
  });

  it("delivers tagged-template and structured-event records end-to-end over gzipped POST /v1/batch", async () => {
    const server = new FakeIngestServer();
    const url = await server.start();
    try {
      init({
        key: "bk_live_e2e",
        endpoint: url,
        service: "orders-api",
        env: "production",
        release: "v2.1.0",
        flushIntervalMs: 60_000,
      });

      const orderId = "ord_e2e_1";
      const cents = 1299;
      log.info`order ${orderId} paid ${cents} in ${42}ms`;
      log.info("order.paid", { orderId, cents, currency: "USD", retry: false });

      await flush();

      assert.equal(server.requests.length, 1);
      const req = server.requests[0]!;
      assert.equal(req.headers["content-encoding"], "gzip");
      assert.equal(req.headers.authorization, "Bearer bk_live_e2e");
      assert.equal(req.envelope.service, "orders-api");
      assert.equal(req.envelope.env, "production");
      assert.equal(req.envelope.release, "v2.1.0");
      assert.equal(req.envelope.records.length, 2);

      const tplRecord = req.envelope.records[0]!;
      assert.equal(tplRecord.severity, Severity.INFO);
      assert.equal(tplRecord.body, "order ord_e2e_1 paid 1299 in 42ms");
      assert.deepEqual(tplRecord.tpl, {
        strings: ["order ", " paid ", " in ", "ms"],
        args: ["ord_e2e_1", 1299, 42],
      });
      assert.ok(tplRecord.callsite, "expected source-mapped callsite from compiled test TS");
      assert.ok(tplRecord.callsite.file.endsWith("test/logger.test.ts"));
      assert.ok(tplRecord.callsite.line > 1);

      const evtRecord = req.envelope.records[1]!;
      assert.equal(evtRecord.severity, Severity.INFO);
      assert.deepEqual(evtRecord.body, {
        event: "order.paid",
        fields: { orderId: "ord_e2e_1", cents: 1299, currency: "USD", retry: false },
      });
      assert.deepEqual(evtRecord.tpl, {
        strings: ["order.paid"],
        args: [],
      });
      assert.ok(evtRecord.callsite, "expected source-mapped callsite for structured event");
      assert.ok(evtRecord.callsite.file.endsWith("test/logger.test.ts"));
    } finally {
      await shutdown(1_000);
      await server.close();
    }
  });
});
