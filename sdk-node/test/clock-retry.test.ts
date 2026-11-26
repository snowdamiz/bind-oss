import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildIdentityPayloadFragment,
  computeBackoffMs,
  createNanosecondClock,
  formatTimestampNs,
  isRetryableStatus,
  nowEpochNs,
  parseRetryAfterMs,
  resolveBatchUrl,
  resolveIdentity,
} from "../src/index.js";

describe("clock and timestamp formatting", () => {
  it("captures BigInt epoch nanoseconds without float precision loss", () => {
    const clock = createNanosecondClock();
    const beforeMs = BigInt(Date.now()) * 1_000_000n;
    const t1 = clock();
    const t2 = clock();
    const t3 = nowEpochNs();
    const afterMs = BigInt(Date.now()) * 1_000_000n;

    assert.equal(typeof t1, "bigint");
    assert.ok(t2 >= t1, "consecutive clock reads should be monotonic");
    assert.ok(
      t1 >= beforeMs - 2_000_000_000n && t1 <= afterMs + 2_000_000_000n,
      "epoch nanoseconds should align with current wall clock",
    );
    assert.ok(t3 > 0n);
  });

  it("preserves exact nanosecond precision above Number.MAX_SAFE_INTEGER", () => {
    // 1795636277123456789 cannot be represented accurately in IEEE-754 float64
    // (Number(1795636277123456789n) rounds to 1795636277123456768).
    const exactNs = 1_795_636_277_123_456_789n;
    assert.notEqual(BigInt(Number(exactNs)), exactNs);

    assert.equal(formatTimestampNs(exactNs), "1795636277123456789");
    assert.equal(formatTimestampNs("1795636277123456789"), "1795636277123456789");
    assert.equal(formatTimestampNs("0001795636277123456789"), "1795636277123456789");
    assert.equal(
      formatTimestampNs(undefined, () => exactNs),
      "1795636277123456789",
    );
  });

  it("converts Date using pure BigInt multiplication", () => {
    const d = new Date("2026-11-26T14:51:17.123Z");
    const expected = (BigInt(d.getTime()) * 1_000_000n).toString(10);
    assert.equal(formatTimestampNs(d), expected);
  });

  it("rejects JS numbers and malformed timestamps", () => {
    assert.throws(
      () => formatTimestampNs(1795636277123456789 as unknown as string),
      TypeError,
    );
    assert.throws(() => formatTimestampNs(-1n), RangeError);
    assert.throws(() => formatTimestampNs("-5"), RangeError);
    assert.throws(() => formatTimestampNs("1.79e18"), RangeError);
    assert.throws(() => formatTimestampNs("123.45"), RangeError);
    assert.throws(() => formatTimestampNs(""), RangeError);
    assert.throws(() => formatTimestampNs(new Date(Number.NaN)), RangeError);
  });
});

describe("identity and endpoint resolution", () => {
  it("resolves frozen identity from explicit options and environment fallbacks", () => {
    const fromEnv = resolveIdentity({
      envSource: {
        BIND_SERVICE: "checkout-api",
        NODE_ENV: "production",
        GITHUB_SHA: "deadbeef1234",
      },
    });
    assert.deepEqual(fromEnv, {
      service: "checkout-api",
      env: "production",
      release: "deadbeef1234",
    });
    assert.equal(Object.isFrozen(fromEnv), true);

    const explicit = resolveIdentity({
      service: "explicit-svc",
      env: "staging",
      release: "v1.2.3",
      envSource: {
        BIND_SERVICE: "ignored",
        BIND_ENV: "ignored",
        BIND_RELEASE: "ignored",
      },
    });
    assert.deepEqual(explicit, {
      service: "explicit-svc",
      env: "staging",
      release: "v1.2.3",
    });

    const fragment = buildIdentityPayloadFragment(explicit);
    assert.deepEqual(JSON.parse(`{"batch_id":"u"${fragment}}`), {
      batch_id: "u",
      service: "explicit-svc",
      env: "staging",
      release: "v1.2.3",
    });
  });

  it("normalizes base URLs and /v1/batch URLs", () => {
    assert.equal(
      resolveBatchUrl("https://ingest.bind.dev"),
      "https://ingest.bind.dev/v1/batch",
    );
    assert.equal(
      resolveBatchUrl("https://ingest.bind.dev/"),
      "https://ingest.bind.dev/v1/batch",
    );
    assert.equal(
      resolveBatchUrl("http://127.0.0.1:4318/v1/batch"),
      "http://127.0.0.1:4318/v1/batch",
    );
    assert.equal(
      resolveBatchUrl("http://127.0.0.1:4318/ingest/"),
      "http://127.0.0.1:4318/ingest/v1/batch",
    );
  });
});

describe("retry rules, Retry-After, and backoff", () => {
  it("marks only 429, 502, 503, and 504 as retryable", () => {
    for (const status of [429, 502, 503, 504]) {
      assert.equal(isRetryableStatus(status), true, `expected ${status} retryable`);
    }
    for (const status of [200, 202, 400, 401, 403, 404, 408, 413, 422, 500, 501]) {
      assert.equal(
        isRetryableStatus(status),
        false,
        `expected ${status} non-retryable`,
      );
    }
  });

  it("parses Retry-After delay-seconds and HTTP-date with upper cap", () => {
    const now = Date.parse("2026-11-26T12:00:00.000Z");

    assert.equal(parseRetryAfterMs("0", now, 60_000), 0);
    assert.equal(parseRetryAfterMs(" 5 ", now, 60_000), 5_000);
    assert.equal(parseRetryAfterMs("9999999999999", now, 60_000), 60_000);

    assert.equal(
      parseRetryAfterMs("Thu, 26 Nov 2026 12:00:07 GMT", now, 60_000),
      7_000,
    );
    assert.equal(
      parseRetryAfterMs("Thu, 26 Nov 2026 11:59:50 GMT", now, 60_000),
      0,
    );
    assert.equal(
      parseRetryAfterMs("Thu, 26 Nov 2026 13:00:00 GMT", now, 60_000),
      60_000,
    );

    assert.equal(parseRetryAfterMs(null, now, 60_000), undefined);
    assert.equal(parseRetryAfterMs("", now, 60_000), undefined);
    assert.equal(parseRetryAfterMs("-5", now, 60_000), undefined);
    assert.equal(parseRetryAfterMs("not-a-date", now, 60_000), undefined);
  });

  it("computes bounded exponential backoff with equal jitter deterministically", () => {
    assert.equal(computeBackoffMs(0, 100, 1_000, () => 0), 50);
    assert.equal(computeBackoffMs(0, 100, 1_000, () => 1), 100);
    assert.equal(computeBackoffMs(1, 100, 1_000, () => 1), 200);
    assert.equal(computeBackoffMs(2, 100, 1_000, () => 0.5), 300);
    assert.equal(computeBackoffMs(10, 100, 1_000, () => 1), 1_000);
  });
});
