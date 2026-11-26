import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createTransport,
  flush,
  getClient,
  init,
  Severity,
  shutdown,
  type LogRecordInput,
  type TransportError,
} from "../src/index.js";
import { FakeIngestServer } from "./fake-server.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("BatchTransport against deterministic fake ingest server", () => {
  let server: FakeIngestServer;

  beforeEach(async () => {
    server = new FakeIngestServer();
    await server.start();
  });

  afterEach(async () => {
    await shutdown(1_000);
    await server.close();
  });

  it("sends POST /v1/batch with Bearer auth, gzip encoding, identity, and exact wire schema", async () => {
    const exactNs = 1_795_636_277_987_654_321n;
    let tick = 0n;
    const transport = createTransport({
      key: "bk_live_secret_123",
      endpoint: server.url,
      service: "payments",
      env: "production",
      release: "sha-abc123",
      flushIntervalMs: 60_000,
      nowNs: () => exactNs + tick++,
    });

    const recordBody = { orderId: "o-42", cents: 1999 };
    const accepted = transport.enqueue({
      severity: Severity.INFO,
      body: recordBody,
      tpl: { strings: ["order ", " paid ", ""], args: ["o-42", 1999] },
      callsite: { file: "src/pay.ts", line: 17, column: 4, function: "charge" },
      attrs: { tenant: "acme" },
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      span_id: "00f067aa0ba902b7",
      edge: { template: "pay.ok", parser_version: 2, fields: { cents: 1999 } },
    });
    assert.equal(accepted, true);

    // Mutating caller object after enqueue must not affect queued payload.
    recordBody.orderId = "tampered";

    await transport.flush();
    await transport.shutdown();

    assert.equal(server.requests.length, 1);
    const req = server.requests[0]!;
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/batch");
    assert.equal(req.headers.authorization, "Bearer bk_live_secret_123");
    assert.equal(req.headers["content-type"], "application/json");
    assert.equal(req.headers["content-encoding"], "gzip");

    // Verify gzip magic header bytes (0x1f 0x8b).
    assert.equal(req.rawBody[0], 0x1f);
    assert.equal(req.rawBody[1], 0x8b);

    const env = req.envelope;
    assert.match(env.batch_id, UUID_RE);
    assert.equal(env.service, "payments");
    assert.equal(env.env, "production");
    assert.equal(env.release, "sha-abc123");
    assert.equal("dropped" in env, false);
    assert.equal(env.records.length, 1);

    const rec = env.records[0]!;
    assert.equal(rec.ts, "1795636277987654321");
    assert.equal(rec.severity, Severity.INFO);
    assert.deepEqual(rec.body, { orderId: "o-42", cents: 1999 });
    assert.deepEqual(rec.tpl, {
      strings: ["order ", " paid ", ""],
      args: ["o-42", 1999],
    });
    assert.deepEqual(rec.callsite, {
      file: "src/pay.ts",
      line: 17,
      column: 4,
      function: "charge",
    });
    assert.deepEqual(rec.attrs, { tenant: "acme" });
    assert.equal(rec.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736");
    assert.equal(rec.span_id, "00f067aa0ba902b7");
    assert.deepEqual(rec.edge, {
      template: "pay.ok",
      parser_version: 2,
      fields: { cents: 1999 },
    });
    assert.equal("project_id" in (rec as unknown as Record<string, unknown>), false);
    assert.equal("observed_ts" in (rec as unknown as Record<string, unknown>), false);
  });

  it("supports uncompressed JSON mode without Content-Encoding header", async () => {
    const transport = createTransport({
      key: "bk_plain",
      endpoint: `${server.url}/v1/batch`,
      service: "plain-svc",
      env: "test",
      release: "1.0.0",
      compression: "none",
      flushIntervalMs: 60_000,
    });

    transport.enqueue({ ts: 10n, severity: Severity.INFO, body: "hello" });
    await transport.flush();
    await transport.shutdown();

    assert.equal(server.requests.length, 1);
    const req = server.requests[0]!;
    assert.equal(req.headers["content-encoding"], undefined);
    assert.equal(req.headers["content-type"], "application/json");
    assert.equal(req.envelope.records[0]?.body, "hello");
  });

  it("flushes automatically at 500 records (default maxBatchRecords)", async () => {
    const transport = createTransport({
      key: "bk_500",
      endpoint: server.url,
      service: "batch-svc",
      env: "test",
      release: "1",
      flushIntervalMs: 60_000,
    });

    for (let i = 0; i < 500; i += 1) {
      transport.enqueue({
        ts: BigInt(1_700_000_000_000_000_000 + i),
        severity: Severity.INFO,
        body: `line-${i}`,
      });
    }

    await server.waitForRequests(1, 3_000);
    await transport.shutdown();

    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]!.envelope.records.length, 500);
    assert.equal(transport.getStats().totalSentRecords, 500);
  });

  it("keeps highly compressible >256 KiB raw records in one gzip batch under 256 KiB", async () => {
    const transport = createTransport({
      key: "bk_compressible",
      endpoint: server.url,
      service: "compress-svc",
      env: "test",
      release: "1",
      flushIntervalMs: 60_000,
    });

    // 40 records * ~8 KiB repetitive text = ~320 KiB raw (> 256 KiB),
    // but gzip compresses it well under 256 KiB so it ships as one batch.
    const repeated = "order-paid-event-payload-".repeat(320);
    for (let i = 0; i < 40; i += 1) {
      assert.equal(
        transport.enqueue({
          ts: BigInt(1_700_000_000_000_000_000 + i),
          severity: Severity.INFO,
          body: `${i}:${repeated}`,
        }),
        true,
      );
    }

    await transport.flush();
    await transport.shutdown();

    assert.equal(server.requests.length, 1);
    const req = server.requests[0]!;
    assert.ok(Buffer.byteLength(req.decompressedBody, "utf8") > 256 * 1024);
    assert.ok(req.rawBody.byteLength < 16 * 1024);
    assert.equal(req.envelope.records.length, 40);
  });

  it("flushes and splits batches to stay under maxBatchCompressedBytes (gzip)", async () => {
    const maxCompressed = 600;
    const transport = createTransport({
      key: "bk_size_gzip",
      endpoint: server.url,
      service: "size-svc",
      env: "test",
      release: "1",
      compression: "gzip",
      maxBatchRecords: 500,
      maxBatchCompressedBytes: maxCompressed,
      flushIntervalMs: 60_000,
    });

    // High-entropy hex payloads resist gzip compression so 12 records exceed 600 bytes compressed.
    const sentBodies: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const payload = `idx=${i}:${randomBytes(140).toString("hex")}`;
      sentBodies.push(payload);
      assert.equal(
        transport.enqueue({
          ts: BigInt(1_700_000_000_000_000_000 + i),
          severity: Severity.INFO,
          body: payload,
        }),
        true,
      );
    }

    // Should flush automatically via size trigger well before the 60s timer.
    await server.waitForRequests(2, 3_000);
    await transport.flush();
    await transport.shutdown();

    assert.ok(
      server.requests.length >= 2,
      `expected multiple split batches, got ${server.requests.length}`,
    );

    const receivedBodies: string[] = [];
    const seenBatchIds = new Set<string>();
    for (const req of server.requests) {
      assert.ok(
        req.rawBody.byteLength <= maxCompressed,
        `compressed batch ${req.rawBody.byteLength} exceeded limit ${maxCompressed}`,
      );
      assert.equal(seenBatchIds.has(req.envelope.batch_id), false);
      seenBatchIds.add(req.envelope.batch_id);
      for (const rec of req.envelope.records) {
        receivedBodies.push(rec.body as string);
      }
    }

    assert.deepEqual(receivedBodies, sentBodies);
  });

  it("flushes and splits batches to stay under maxBatchCompressedBytes (uncompressed)", async () => {
    const maxBytes = 400;
    const transport = createTransport({
      key: "bk_size_plain",
      endpoint: server.url,
      service: "size-plain",
      env: "test",
      release: "1",
      compression: "none",
      maxBatchRecords: 500,
      maxBatchCompressedBytes: maxBytes,
      flushIntervalMs: 60_000,
    });

    const sentBodies: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const payload = `rec-${i}-${"a".repeat(80)}`;
      sentBodies.push(payload);
      transport.enqueue({
        ts: BigInt(1000 + i),
        severity: Severity.INFO,
        body: payload,
      });
    }

    await server.waitForRequests(2, 3_000);
    await transport.flush();
    await transport.shutdown();

    assert.ok(server.requests.length >= 3);
    const receivedBodies: string[] = [];
    for (const req of server.requests) {
      assert.ok(
        req.rawBody.byteLength <= maxBytes,
        `uncompressed batch ${req.rawBody.byteLength} exceeded limit ${maxBytes}`,
      );
      for (const rec of req.envelope.records) {
        receivedBodies.push(rec.body as string);
      }
    }
    assert.deepEqual(receivedBodies, sentBodies);
  });

  it("flushes automatically on flushIntervalMs timer", async () => {
    const transport = createTransport({
      key: "bk_timer",
      endpoint: server.url,
      service: "timer-svc",
      env: "test",
      release: "1",
      maxBatchRecords: 500,
      flushIntervalMs: 40,
    });

    transport.enqueue({ ts: 1n, severity: Severity.INFO, body: "timer-log" });
    await server.waitForRequests(1, 2_000);
    await transport.shutdown();

    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]!.envelope.records[0]?.body, "timer-log");
  });

  it("retries 429, 503, 502, 504 with Retry-After and backoff while keeping batch bytes and batch_id identical", async () => {
    const fixedNow = Date.parse("2026-11-26T15:00:00.000Z");
    const sleeps: number[] = [];

    server.enqueueResponse(
      { status: 429, headers: { "retry-after": "2" } },
      { status: 503, headers: { "retry-after": "Thu, 26 Nov 2026 15:00:04 GMT" } },
      { status: 502 },
      { status: 504 },
      { status: 200 },
    );

    const transport = createTransport({
      key: "bk_retry",
      endpoint: server.url,
      service: "retry-svc",
      env: "prod",
      release: "r42",
      flushIntervalMs: 60_000,
      maxRetries: 5,
      initialBackoffMs: 100,
      maxBackoffMs: 10_000,
      nowMs: () => fixedNow,
      random: () => 1, // equal jitter max -> exact exp delay
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    transport.enqueue({ ts: 100n, severity: Severity.ERROR, body: "retry-me" });
    await transport.flush();
    await transport.shutdown();

    assert.equal(server.requests.length, 5);
    assert.deepEqual(sleeps, [
      2_000, // 429 Retry-After: 2
      4_000, // 503 Retry-After: HTTP-date (+4s)
      400, // 502 attempt index 2 -> 100 * 2^2 = 400
      800, // 504 attempt index 3 -> 100 * 2^3 = 800
    ]);

    const firstReq = server.requests[0]!;
    for (let i = 1; i < server.requests.length; i += 1) {
      const attemptReq = server.requests[i]!;
      assert.equal(
        Buffer.compare(firstReq.rawBody, attemptReq.rawBody),
        0,
        `attempt ${i + 1} raw gzip bytes differed from attempt 1`,
      );
      assert.equal(attemptReq.envelope.batch_id, firstReq.envelope.batch_id);
      assert.equal(attemptReq.envelope.service, "retry-svc");
      assert.equal(attemptReq.envelope.env, "prod");
      assert.equal(attemptReq.envelope.release, "r42");
    }

    const stats = transport.getStats();
    assert.equal(stats.totalSentBatches, 1);
    assert.equal(stats.totalSentRecords, 1);
    assert.equal(stats.totalRetries, 4);
    assert.equal(stats.totalFailedBatches, 0);
  });

  it("does not retry 200 partial_success or non-retryable 4xx/500 statuses", async () => {
    const errors: TransportError[] = [];
    const sleeps: number[] = [];

    server.enqueueResponse(
      {
        status: 200,
        body: JSON.stringify({
          partial_success: { rejected_log_records: 1, error_message: "oversize" },
        }),
      },
      { status: 400 },
      { status: 401 },
      { status: 413 },
      { status: 500 },
    );

    const transport = createTransport({
      key: "bk_nonretry",
      endpoint: server.url,
      service: "nonretry-svc",
      env: "test",
      release: "1",
      flushIntervalMs: 60_000,
      maxRetries: 3,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onError: (err) => errors.push(err),
    });

    for (const label of ["partial", "bad400", "unauth401", "big413", "err500"]) {
      transport.enqueue({ ts: 1n, severity: Severity.INFO, body: label });
      await transport.flush();
    }
    await transport.shutdown();

    assert.equal(server.requests.length, 5);
    assert.deepEqual(sleeps, []);
    assert.deepEqual(
      errors.map((e) => ({ code: e.code, status: e.status })),
      [
        { code: "http_error", status: 400 },
        { code: "http_error", status: 401 },
        { code: "http_error", status: 413 },
        { code: "http_error", status: 500 },
      ],
    );
    assert.equal(transport.getStats().totalSentBatches, 1);
    assert.equal(transport.getStats().totalFailedBatches, 4);
  });

  it("retries request timeouts and socket resets with identical batch bytes and batch_id", async () => {
    const sleeps: number[] = [];
    server.enqueueResponse(
      { hang: true },
      { destroySocket: true },
      { status: 200 },
    );

    const transport = createTransport({
      key: "bk_timeout",
      endpoint: server.url,
      service: "timeout-svc",
      env: "test",
      release: "1",
      flushIntervalMs: 60_000,
      requestTimeoutMs: 60,
      maxRetries: 3,
      initialBackoffMs: 50,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    transport.enqueue({ ts: 77n, severity: Severity.WARN, body: "slow-gateway" });
    await transport.flush();
    await transport.shutdown();

    assert.equal(server.requests.length, 3);
    assert.deepEqual(sleeps, [25, 50]);
    assert.equal(
      Buffer.compare(server.requests[0]!.rawBody, server.requests[1]!.rawBody),
      0,
    );
    assert.equal(
      Buffer.compare(server.requests[0]!.rawBody, server.requests[2]!.rawBody),
      0,
    );
    assert.equal(
      server.requests[0]!.envelope.batch_id,
      server.requests[2]!.envelope.batch_id,
    );
    assert.equal(transport.getStats().totalSentBatches, 1);
    assert.equal(transport.getStats().totalRetries, 2);
  });

  it("reports dropped counts on queue overflow and preserves drops across failed batches", async () => {
    const errors: TransportError[] = [];
    const sleeps: number[] = [];

    // First batch fails permanently (503 x 2), second batch succeeds (200).
    server.enqueueResponse({ status: 503 }, { status: 503 }, { status: 200 });

    const sample = JSON.stringify({
      ts: "100",
      severity: Severity.DEBUG,
      body: "msg-0-xxxxxxxxxx",
    });
    const recordBytes = Buffer.byteLength(sample, "utf8");

    const transport = createTransport({
      key: "bk_drop",
      endpoint: server.url,
      service: "drop-svc",
      env: "prod",
      release: "v2",
      flushIntervalMs: 60_000,
      maxQueueBytes: recordBytes * 2 + 10,
      maxRetries: 1,
      initialBackoffMs: 10,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onError: (err) => errors.push(err),
    });

    // Enqueue 2 DEBUG then 2 ERROR -> both DEBUG records evicted so both ERROR survive.
    transport.enqueue({ ts: 100n, severity: Severity.DEBUG, body: "msg-0-xxxxxxxxxx" });
    transport.enqueue({ ts: 101n, severity: Severity.DEBUG, body: "msg-1-xxxxxxxxxx" });
    transport.enqueue({ ts: 102n, severity: Severity.ERROR, body: "msg-2-xxxxxxxxxx" });
    transport.enqueue({ ts: 103n, severity: Severity.ERROR, body: "msg-3-xxxxxxxxxx" });

    assert.equal(transport.getStats().pendingDropped, 2);

    // Flush #1 fails permanently after 2 attempts (both carrying dropped: 2 and exact same bytes).
    await transport.flush();
    assert.equal(server.requests.length, 2);
    assert.equal(server.requests[0]!.envelope.dropped, 2);
    assert.deepEqual(
      server.requests[0]!.envelope.records.map((r) => r.body),
      ["msg-2-xxxxxxxxxx", "msg-3-xxxxxxxxxx"],
    );
    assert.equal(
      Buffer.compare(server.requests[0]!.rawBody, server.requests[1]!.rawBody),
      0,
    );
    assert.equal(errors.some((e) => e.code === "retries_exhausted"), true);

    // Failed batch restored its 2 prior drops + 2 lost records = 4 pendingDropped.
    assert.equal(transport.getStats().pendingDropped, 4);
    assert.equal(transport.getStats().totalDropped, 4);

    // Next record succeeds and delivers dropped: 4, then resets pendingDropped to 0.
    transport.enqueue({ ts: 104n, severity: Severity.INFO, body: "recovered" });
    await transport.flush();
    assert.equal(server.requests.length, 3);
    assert.equal(server.requests[2]!.envelope.dropped, 4);
    assert.equal(server.requests[2]!.envelope.records[0]?.body, "recovered");
    assert.equal(transport.getStats().pendingDropped, 0);

    // Following batch with no further drops omits `dropped`.
    server.enqueueResponse({ status: 200 });
    transport.enqueue({ ts: 105n, severity: Severity.INFO, body: "clean" });
    await transport.flush();
    await transport.shutdown();

    assert.equal(server.requests.length, 4);
    assert.equal("dropped" in server.requests[3]!.envelope, false);
  });

  it("supports module-level init/getClient/flush/shutdown and reuses frozen identity", async () => {
    const envSource: Record<string, string | undefined> = {
      BIND_SERVICE: "init-service",
      BIND_ENV: "staging",
      BIND_RELEASE: "rel-9",
    };

    const client = init({
      key: "bk_init",
      endpoint: server.url,
      flushIntervalMs: 60_000,
      envSource,
    });

    assert.equal(getClient(), client);

    // Mutate envSource after init; queued batches must reuse frozen identity.
    envSource.BIND_SERVICE = "mutated-service";
    envSource.BIND_ENV = "mutated-env";
    envSource.BIND_RELEASE = "mutated-release";

    assert.equal(
      client.enqueue({ ts: 500n, severity: Severity.INFO, body: "via-init" }),
      true,
    );
    await flush();

    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]!.envelope.service, "init-service");
    assert.equal(server.requests[0]!.envelope.env, "staging");
    assert.equal(server.requests[0]!.envelope.release, "rel-9");

    await shutdown();
    assert.equal(getClient(), undefined);
    assert.equal(
      client.enqueue({ ts: 501n, severity: Severity.INFO, body: "after-shutdown" }),
      false,
    );
  });

  it("aborts hung requests and long Retry-After sleeps within shutdownTimeoutMs without throwing", async () => {
    const errors: TransportError[] = [];
    server.enqueueResponse({ hang: true });

    const transport = createTransport({
      key: "bk_shutdown",
      endpoint: server.url,
      service: "shutdown-svc",
      env: "test",
      release: "1",
      flushIntervalMs: 60_000,
      requestTimeoutMs: 10_000,
      maxRetries: 3,
      onError: (err) => {
        errors.push(err);
        throw new Error("throwing user callback must be swallowed");
      },
    });

    // Invalid records and throwing toJSON() must never throw.
    const badToJson = {
      toJSON() {
        throw new Error("boom");
      },
    };
    assert.equal(
      transport.enqueue({
        severity: 99 as unknown as LogRecordInput["severity"],
        body: "bad-sev",
      }),
      false,
    );
    assert.equal(
      transport.enqueue({
        severity: Severity.INFO,
        body: badToJson as unknown as LogRecordInput["body"],
      }),
      false,
    );

    assert.equal(
      transport.enqueue({ ts: 1n, severity: Severity.INFO, body: "hang-me" }),
      true,
    );

    const started = Date.now();
    await transport.shutdown(80);
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 1_000, `shutdown took too long: ${elapsed}ms`);
    assert.equal(
      errors.some((e) => e.code === "shutdown_timeout"),
      true,
    );

    // Shutdown also interrupts an active long Retry-After backoff sleep promptly.
    server.reset();
    server.enqueueResponse({ status: 429, headers: { "retry-after": "60" } });
    const sleepTransport = createTransport({
      key: "bk_shutdown_sleep",
      endpoint: server.url,
      service: "sleep-svc",
      env: "test",
      release: "1",
      flushIntervalMs: 60_000,
      maxRetries: 3,
    });
    sleepTransport.enqueue({ ts: 2n, severity: Severity.INFO, body: "retry-sleep" });
    const flushPromise = sleepTransport.flush();
    await server.waitForRequests(1, 2_000);
    const sleepStart = Date.now();
    await sleepTransport.shutdown(60);
    await flushPromise;
    assert.ok(
      Date.now() - sleepStart < 1_000,
      "shutdown should abort Retry-After sleep promptly",
    );

    // Missing key disables cleanly without throwing.
    const missingKeyErrors: TransportError[] = [];
    const disabled = createTransport({
      key: "",
      envSource: {},
      onError: (err) => missingKeyErrors.push(err),
    });
    assert.equal(
      disabled.enqueue({ severity: Severity.INFO, body: "ignored" }),
      false,
    );
    await disabled.flush();
    await disabled.shutdown();
    assert.equal(missingKeyErrors[0]?.code, "missing_key");
  });
});
