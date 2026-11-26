import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BoundedRecordQueue,
  serializeRecordInput,
  Severity,
  type LogRecordInput,
  type WireRecord,
} from "../src/index.js";

describe("record serialization and bounded queue", () => {
  it("serializes full wire record shape and isolates from caller mutation", () => {
    const bodyObj = { orderId: "ord-1", cents: 4200 };
    const attrs = { region: "us-east" };
    const args = ["ord-1", 4200];
    const input = {
      ts: 1_795_636_277_123_456_789n,
      severity: Severity.INFO,
      body: bodyObj,
      tpl: { strings: ["order ", " paid ", ""], args },
      callsite: { file: "src/orders.ts", line: 42, column: 7, function: "pay" },
      attrs,
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789abcdef",
      edge: {
        template: "order.paid",
        parser_version: 3,
        fields: { cents: 4200 },
      },
      // Server-injected fields must not be forwarded even if present on input object.
      project_id: 999,
      observed_ts: "1",
    } as unknown as LogRecordInput;

    const serialized = serializeRecordInput(input, () => 1n);

    // Mutate caller inputs after serialization.
    bodyObj.orderId = "mutated";
    attrs.region = "mutated";
    args[0] = "mutated";

    const parsed = JSON.parse(serialized.json) as Record<string, unknown>;
    assert.equal(parsed.ts, "1795636277123456789");
    assert.equal(parsed.severity, Severity.INFO);
    assert.deepEqual(parsed.body, { orderId: "ord-1", cents: 4200 });
    assert.deepEqual(parsed.tpl, {
      strings: ["order ", " paid ", ""],
      args: ["ord-1", 4200],
    });
    assert.deepEqual(parsed.callsite, {
      file: "src/orders.ts",
      line: 42,
      column: 7,
      function: "pay",
    });
    assert.deepEqual(parsed.attrs, { region: "us-east" });
    assert.equal(parsed.trace_id, "0123456789abcdef0123456789abcdef");
    assert.equal(parsed.span_id, "0123456789abcdef");
    assert.deepEqual(parsed.edge, {
      template: "order.paid",
      parser_version: 3,
      fields: { cents: 4200 },
    });
    assert.equal("project_id" in parsed, false);
    assert.equal("observed_ts" in parsed, false);
  });

  it("handles circular references and BigInt values in body safely", () => {
    const circular: Record<string, unknown> = { count: 42n };
    circular.self = circular;
    const serialized = serializeRecordInput(
      {
        ts: 100n,
        severity: Severity.WARN,
        body: circular as unknown as WireRecord["body"],
      },
      () => 100n,
    );
    const parsed = JSON.parse(serialized.json) as WireRecord;
    assert.deepEqual(parsed.body, { count: "42", self: "[Circular]" });
  });

  it("evicts oldest debug-level records first before INFO/ERROR and tracks drops", () => {
    const rDebug1 = serializeRecordInput(
      { ts: 1n, severity: Severity.DEBUG, body: "d1-xxxxxxxxxx" },
      () => 1n,
    );
    const rInfo1 = serializeRecordInput(
      { ts: 2n, severity: Severity.INFO, body: "i1-xxxxxxxxxx" },
      () => 2n,
    );
    const rTrace1 = serializeRecordInput(
      { ts: 3n, severity: Severity.TRACE, body: "t1-xxxxxxxxxx" },
      () => 3n,
    );
    const rError1 = serializeRecordInput(
      { ts: 4n, severity: Severity.ERROR, body: "e1-xxxxxxxxxx" },
      () => 4n,
    );

    // Budget fits exactly 3 records including 2-digit severity (ERROR=17 / FATAL=21), not 4.
    const maxQueueBytes = rError1.byteLength * 3;
    const queue = new BoundedRecordQueue({
      maxQueueBytes,
      maxRecordBytes: 64 * 1024,
    });

    assert.equal(queue.enqueue(rDebug1).accepted, true);
    assert.equal(queue.enqueue(rInfo1).accepted, true);
    assert.equal(queue.enqueue(rTrace1).accepted, true);
    assert.equal(queue.pendingDropped, 0);

    // Adding rError1 should evict rDebug1 (oldest debug-level) while keeping rInfo1 and rTrace1.
    const outcome1 = queue.enqueue(rError1);
    assert.equal(outcome1.accepted, true);
    assert.equal(outcome1.evictedCount, 1);
    assert.equal(queue.pendingDropped, 1);
    assert.equal(queue.totalDropped, 1);
    assert.ok(queue.queuedBytes <= maxQueueBytes);

    let bodies = queue
      .peekPrefix(10)
      .map((r) => (JSON.parse(r.json) as WireRecord).body);
    assert.deepEqual(bodies, ["i1-xxxxxxxxxx", "t1-xxxxxxxxxx", "e1-xxxxxxxxxx"]);

    // Adding another INFO evicts rTrace1 (remaining debug-level), keeping rInfo1 and rError1.
    const rInfo2 = serializeRecordInput(
      { ts: 5n, severity: Severity.INFO, body: "i2-xxxxxxxxxx" },
      () => 5n,
    );
    const outcome2 = queue.enqueue(rInfo2);
    assert.equal(outcome2.accepted, true);
    assert.equal(outcome2.evictedCount, 1);
    assert.equal(queue.pendingDropped, 2);

    bodies = queue
      .peekPrefix(10)
      .map((r) => (JSON.parse(r.json) as WireRecord).body);
    assert.deepEqual(bodies, ["i1-xxxxxxxxxx", "e1-xxxxxxxxxx", "i2-xxxxxxxxxx"]);

    // Queue is now full of non-debug records: an incoming DEBUG must be dropped,
    // never evicting INFO/ERROR.
    const rDebug2 = serializeRecordInput(
      { ts: 6n, severity: Severity.DEBUG, body: "d2-xxxxxxxxxx" },
      () => 6n,
    );
    const outcome3 = queue.enqueue(rDebug2);
    assert.equal(outcome3.accepted, false);
    assert.equal(outcome3.rejectedReason, "queue_full");
    assert.equal(queue.pendingDropped, 3);
    assert.equal(queue.totalDropped, 3);

    // An incoming FATAL with no debug records left falls back to evicting oldest non-debug (rInfo1).
    const rFatal = serializeRecordInput(
      { ts: 7n, severity: Severity.FATAL, body: "f1-xxxxxxxxxx" },
      () => 7n,
    );
    const outcome4 = queue.enqueue(rFatal);
    assert.equal(outcome4.accepted, true);
    assert.equal(outcome4.evictedCount, 1);
    assert.equal(queue.pendingDropped, 4);
    assert.equal(queue.totalDropped, 4);

    bodies = queue
      .peekPrefix(10)
      .map((r) => (JSON.parse(r.json) as WireRecord).body);
    assert.deepEqual(bodies, ["e1-xxxxxxxxxx", "i2-xxxxxxxxxx", "f1-xxxxxxxxxx"]);
  });

  it("rejects oversize single records without evicting existing entries", () => {
    const queue = new BoundedRecordQueue({
      maxQueueBytes: 1024,
      maxRecordBytes: 128,
    });
    const small = serializeRecordInput(
      { ts: 1n, severity: Severity.INFO, body: "ok" },
      () => 1n,
    );
    const huge = serializeRecordInput(
      { ts: 2n, severity: Severity.ERROR, body: "x".repeat(200) },
      () => 2n,
    );

    assert.equal(queue.enqueue(small).accepted, true);
    const outcome = queue.enqueue(huge);
    assert.equal(outcome.accepted, false);
    assert.equal(outcome.rejectedReason, "record_too_large");
    assert.equal(queue.length, 1);
    assert.equal(queue.pendingDropped, 1);
    assert.equal(queue.totalDropped, 1);
  });

  it("restores failed batch drop counts without double-counting totalDropped", () => {
    const queue = new BoundedRecordQueue({
      maxQueueBytes: 64,
      maxRecordBytes: 64,
    });
    const oversize = serializeRecordInput(
      { ts: 1n, severity: Severity.INFO, body: "x".repeat(100) },
      () => 1n,
    );
    queue.enqueue(oversize);
    queue.enqueue(oversize);
    assert.equal(queue.pendingDropped, 2);
    assert.equal(queue.totalDropped, 2);

    const taken = queue.takePendingDropped();
    assert.equal(taken, 2);
    assert.equal(queue.pendingDropped, 0);

    // Batch carrying `dropped: 2` and `3` records failed permanently.
    queue.restoreFailedBatch(taken, 3);
    assert.equal(queue.pendingDropped, 5);
    assert.equal(queue.totalDropped, 5);
  });
});
