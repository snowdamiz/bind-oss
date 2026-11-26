import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  CallSiteResolver,
  createClient,
  createLogger,
  init,
  log,
  shutdown,
  type BatchIdentity,
  type LogRecordInput,
  type RecordSink,
  type TransportError,
  type TransportStats,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

class CapturingSink implements RecordSink {
  readonly identity: Readonly<BatchIdentity> = Object.freeze({
    service: "orders",
    env: "test",
    release: "r1",
  });
  readonly records: LogRecordInput[] = [];

  enqueue(record: LogRecordInput): boolean {
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

class CheckoutService {
  complete(logger: ReturnType<typeof createLogger>, orderId: string, cents: number): void {
    logger.info`order ${orderId} paid ${cents}`;
  }

  emitPaid(logger: ReturnType<typeof createLogger>, orderId: string, cents: number): void {
    logger.info("order.paid", { orderId, cents });
  }
}

/**
 * Encodes a minimal single-mapping Source Map v3 where generated 1-based
 * `(genLine, genCol)` maps to original 1-based `(origLine, origCol)` in `sourceName`.
 */
function buildSinglePointSourceMap(options: {
  file: string;
  sourceName: string;
  genLine: number;
  genCol: number;
  origLine: number;
  origCol: number;
  sourceRoot?: string;
}): string {
  const vlqEncode = (num: number): string => {
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let value = num < 0 ? ((-num) << 1) | 1 : num << 1;
    let out = "";
    do {
      let digit = value & 31;
      value >>>= 5;
      if (value > 0) {
        digit |= 32;
      }
      out += alphabet[digit]!;
    } while (value > 0);
    return out;
  };

  // Mappings are 0-based; empty lines before genLine - 1 are ';' separators.
  const prefix = ";".repeat(Math.max(0, options.genLine - 1));
  const segment =
    vlqEncode(Math.max(0, options.genCol - 1)) +
    vlqEncode(0) + // source index 0
    vlqEncode(Math.max(0, options.origLine - 1)) +
    vlqEncode(Math.max(0, options.origCol - 1));

  return JSON.stringify({
    version: 3,
    file: options.file,
    ...(options.sourceRoot ? { sourceRoot: options.sourceRoot } : {}),
    sources: [options.sourceName],
    names: [],
    mappings: `${prefix}${segment}`,
  });
}

describe("source-mapped call-site capture and caching", () => {
  it("maps compiled TypeScript tagged-template and structured calls back to original .ts file, line, column, and method name", () => {
    const sink = new CapturingSink();
    const resolver = new CallSiteResolver();
    const logger = createLogger(sink, { callsite: resolver });
    const service = new CheckoutService();

    service.complete(logger, "ord_1", 1000);
    service.emitPaid(logger, "ord_1", 1000);

    assert.equal(sink.records.length, 2);

    const tplSite = sink.records[0]!.callsite;
    assert.ok(tplSite, "expected source-mapped callsite for tagged template");
    assert.ok(
      tplSite.file.endsWith(path.join("test", "callsite.test.ts")),
      `expected file ending in test/callsite.test.ts, got ${tplSite.file}`,
    );
    assert.equal(tplSite.function, "CheckoutService.complete");
    assert.ok(tplSite.line >= 60 && tplSite.line <= 75, `unexpected line ${tplSite.line}`);
    assert.ok(typeof tplSite.column === "number" && tplSite.column >= 1);

    const evtSite = sink.records[1]!.callsite;
    assert.ok(evtSite, "expected source-mapped callsite for structured event");
    assert.ok(
      evtSite.file.endsWith(path.join("test", "callsite.test.ts")),
      `expected file ending in test/callsite.test.ts, got ${evtSite.file}`,
    );
    assert.equal(evtSite.function, "CheckoutService.emitPaid");
    assert.ok(evtSite.line > tplSite.line, "emitPaid should map to a later line than complete");
  });

  it("strips internal SDK frames for module-level log, client.log, child loggers, and destructured methods", async () => {
    const captured: LogRecordInput[] = [];
    const client = createClient({
      key: "bk_test",
      flushIntervalMs: 60_000,
    });
    const origEnqueue = client.transport.enqueue.bind(client.transport);
    client.transport.enqueue = (record: LogRecordInput) => {
      captured.push(record);
      return origEnqueue(record);
    };

    function callViaClient(): void {
      client.log.info`via client ${1}`;
    }

    function callViaChild(): void {
      const child = client.log.child({ attrs: { scope: "child" } });
      child.info("child.event", { ok: true });
    }

    function callViaDestructured(): void {
      const { info } = client.log;
      info`via destructured ${2}`;
    }

    callViaClient();
    callViaChild();
    callViaDestructured();
    await client.shutdown(0);

    assert.equal(captured.length, 3);
    for (const [idx, expectedFn] of [
      [0, "callViaClient"],
      [1, "callViaChild"],
      [2, "callViaDestructured"],
    ] as const) {
      const cs = captured[idx]!.callsite;
      assert.ok(cs, `expected callsite for record ${idx}`);
      assert.ok(
        cs.file.endsWith(path.join("test", "callsite.test.ts")),
        `expected caller .ts file, got ${cs.file}`,
      );
      assert.equal(cs.function, expectedFn);
    }

    // Verify module-level `log` as well.
    const defaultClient = init({ key: "bk_default", flushIntervalMs: 60_000 });
    const modCaptured: LogRecordInput[] = [];
    defaultClient.transport.enqueue = (record: LogRecordInput) => {
      modCaptured.push(record);
      return true;
    };
    function callViaModuleLog(): void {
      log.info`via module log ${3}`;
    }
    callViaModuleLog();
    await shutdown(0);

    assert.equal(modCaptured.length, 1);
    assert.ok(modCaptured[0]!.callsite?.file.endsWith(path.join("test", "callsite.test.ts")));
    assert.equal(modCaptured[0]!.callsite?.function, "callViaModuleLog");
  });

  it("caches tagged-template call sites once per call site and keeps distinct call sites with identical literals separate", () => {
    const sink = new CapturingSink();
    const resolver = new CallSiteResolver();
    const logger = createLogger(sink, { callsite: resolver });

    for (let i = 0; i < 50; i += 1) {
      logger.info`loop item ${i}`;
    }

    const statsAfterLoop = resolver.getStats();
    assert.equal(statsAfterLoop.stackCaptures, 1);
    assert.equal(statsAfterLoop.templateMisses, 1);
    assert.equal(statsAfterLoop.templateHits, 49);
    assert.equal(sink.records.length, 50);

    const firstSite = sink.records[0]!.callsite;
    assert.ok(firstSite);
    for (const rec of sink.records) {
      assert.deepEqual(rec.callsite, firstSite);
    }

    // Two distinct call sites with the exact same literal strings must resolve separately.
    const sink2 = new CapturingSink();
    const resolver2 = new CallSiteResolver();
    const logger2 = createLogger(sink2, { callsite: resolver2 });

    function siteOne(n: number): void {
      logger2.info`same text ${n}`;
    }
    function siteTwo(n: number): void {
      logger2.info`same text ${n}`;
    }

    for (let i = 0; i < 10; i += 1) {
      siteOne(i);
      siteTwo(i);
    }

    assert.equal(resolver2.getStats().stackCaptures, 2);
    assert.equal(resolver2.getStats().templateHits, 18);
    assert.equal(sink2.records[0]!.callsite?.function, "siteOne");
    assert.equal(sink2.records[1]!.callsite?.function, "siteTwo");
    assert.notEqual(sink2.records[0]!.callsite?.line, sink2.records[1]!.callsite?.line);
  });

  it("samples structured events for the first few calls per shape key, caches consistent sites, and suppresses ambiguous multi-site shapes", () => {
    const sink = new CapturingSink();
    const resolver = new CallSiteResolver({ sampleLimit: 3 });
    const logger = createLogger(sink, { callsite: resolver });

    for (let i = 0; i < 20; i += 1) {
      logger.info("order.paid", { orderId: `ord_${i}`, cents: 100 + i });
    }

    const stats = resolver.getStats();
    assert.equal(stats.stackCaptures, 3);
    assert.equal(stats.shapeMisses, 3);
    assert.equal(stats.shapeHits, 17);
    assert.equal(sink.records.length, 20);
    const expectedSite = sink.records[0]!.callsite;
    assert.ok(expectedSite);
    for (const rec of sink.records) {
      assert.deepEqual(rec.callsite, expectedSite);
    }

    // Same shape from two different call sites: detect ambiguity on sample 2 and stop misattributing.
    const ambSink = new CapturingSink();
    const ambResolver = new CallSiteResolver({ sampleLimit: 3 });
    const ambLogger = createLogger(ambSink, { callsite: ambResolver });

    function emitFromA(id: string): void {
      ambLogger.info("shared.event", { id });
    }
    function emitFromB(id: string): void {
      ambLogger.info("shared.event", { id });
    }

    emitFromA("1"); // sample 1: site A
    emitFromB("2"); // sample 2: site B (differs from site A -> settled ambiguous)
    emitFromA("3"); // cached settled undefined -> no stack capture
    emitFromB("4"); // cached settled undefined -> no stack capture

    assert.equal(ambResolver.getStats().stackCaptures, 2);
    assert.equal(ambResolver.getStats().shapeHits, 2);
    assert.equal(ambSink.records[0]!.callsite?.function, "emitFromA");
    assert.equal(ambSink.records[1]!.callsite?.function, "emitFromB");
    assert.equal(ambSink.records[2]!.callsite, undefined);
    assert.equal(ambSink.records[3]!.callsite, undefined);
  });

  it("bounds shape cache size and supports disabling call-site capture", () => {
    const sink = new CapturingSink();
    const resolver = new CallSiteResolver({
      sampleLimit: 1,
      maxShapeCacheEntries: 4,
    });
    const logger = createLogger(sink, { callsite: resolver });

    for (let i = 0; i < 10; i += 1) {
      logger.info(`event.${i}`, { i });
    }
    assert.equal(resolver.getStats().shapeCacheSize, 4);

    const disabledSink = new CapturingSink();
    const disabledResolver = new CallSiteResolver({ enabled: false });
    const disabledLogger = createLogger(disabledSink, { callsite: disabledResolver });
    disabledLogger.info`no stack ${1}`;
    disabledLogger.info("no.stack", { a: 1 });
    assert.equal(disabledResolver.getStats().stackCaptures, 0);
    assert.equal(disabledSink.records[0]!.callsite, undefined);
    assert.equal(disabledSink.records[1]!.callsite, undefined);
  });

  it("handles external source maps, inline data-URI maps, absent maps, missing .map files, corrupt maps, and body string literals", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-sdk-sourcemap-"));
    try {
      // 1. External .mjs.map
      const extJs = path.join(tmpDir, "external.mjs");
      const extMap = path.join(tmpDir, "external.mjs.map");
      fs.writeFileSync(
        extJs,
        [
          "export function runExternal(logger) {",
          "  logger.info`ext ${1}`;",
          "}",
          "//# sourceMappingURL=external.mjs.map",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        extMap,
        buildSinglePointSourceMap({
          file: "external.mjs",
          sourceName: "src/external.ts",
          genLine: 2,
          genCol: 1,
          origLine: 42,
          origCol: 5,
        }),
      );

      // 2. Inline base64 source map
      const inlineMapJson = buildSinglePointSourceMap({
        file: "inline.mjs",
        sourceName: "src/inline.ts",
        genLine: 2,
        genCol: 1,
        origLine: 77,
        origCol: 9,
      });
      const inlineJs = path.join(tmpDir, "inline.mjs");
      fs.writeFileSync(
        inlineJs,
        [
          "export function runInline(logger) {",
          "  logger.info`inline ${2}`;",
          "}",
          `//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(inlineMapJson, "utf8").toString("base64")}`,
          "",
        ].join("\n"),
      );

      // 3. No source map deployed at all (plus a decoy string literal in code body)
      const noMapJs = path.join(tmpDir, "nomap.mjs");
      fs.writeFileSync(
        noMapJs,
        [
          "export function runNoMap(logger) {",
          '  const decoy = "//# sourceMappingURL=decoy.mjs.map";',
          "  logger.info`nomap ${decoy}`;",
          "}",
          "",
        ].join("\n"),
      );

      // 4. Missing .map file (ENOENT) -> omit callsite quietly without error
      const missingMapJs = path.join(tmpDir, "missing.mjs");
      fs.writeFileSync(
        missingMapJs,
        [
          "export function runMissingMap(logger) {",
          "  logger.info`missing ${3}`;",
          "}",
          "//# sourceMappingURL=does-not-exist.mjs.map",
          "",
        ].join("\n"),
      );

      // 5. Corrupt .map file -> must NOT throw, omits callsite, reports callsite_error once
      const corruptJs = path.join(tmpDir, "corrupt.mjs");
      const corruptMap = path.join(tmpDir, "corrupt.mjs.map");
      fs.writeFileSync(
        corruptJs,
        [
          "export function runCorruptMap(logger) {",
          "  logger.info`corrupt ${4}`;",
          "  logger.info`corrupt second site ${5}`;",
          "}",
          "//# sourceMappingURL=corrupt.mjs.map",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(corruptMap, "{not-valid-json");

      const [extMod, inlineMod, noMapMod, missingMod, corruptMod] = await Promise.all([
        import(pathToFileURL(extJs).href),
        import(pathToFileURL(inlineJs).href),
        import(pathToFileURL(noMapJs).href),
        import(pathToFileURL(missingMapJs).href),
        import(pathToFileURL(corruptJs).href),
      ]);

      const sink = new CapturingSink();
      const errors: TransportError[] = [];
      const logger = createLogger(sink, {
        onError: (err) => errors.push(err),
      });

      extMod.runExternal(logger);
      inlineMod.runInline(logger);
      noMapMod.runNoMap(logger);
      missingMod.runMissingMap(logger);
      corruptMod.runCorruptMap(logger);

      assert.equal(sink.records.length, 6);

      assert.deepEqual(sink.records[0]!.callsite, {
        file: path.resolve(tmpDir, "src/external.ts"),
        line: 42,
        column: 5,
        function: "runExternal",
      });

      assert.deepEqual(sink.records[1]!.callsite, {
        file: path.resolve(tmpDir, "src/inline.ts"),
        line: 77,
        column: 9,
        function: "runInline",
      });

      // No source map deployed -> callsite MUST be omitted per §6.
      assert.equal(sink.records[2]!.callsite, undefined);
      assert.equal(sink.records[3]!.callsite, undefined);

      // Corrupt source map -> callsite omitted, error reported once (cached on second call site in same file).
      assert.equal(sink.records[4]!.callsite, undefined);
      assert.equal(sink.records[5]!.callsite, undefined);
      assert.equal(errors.length, 1);
      assert.equal(errors[0]!.code, "callsite_error");
      assert.match(errors[0]!.message, /corrupt\.mjs\.map/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses Node's in-memory module.findSourceMap directly when --enable-source-maps is active", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-sdk-enablesm-"));
    try {
      const sdkEntryUrl = pathToFileURL(
        path.resolve(process.cwd(), "dist/esm/index.js"),
      ).href;

      const emitterJs = path.join(tmpDir, "emitter.mjs");
      const emitterMap = path.join(tmpDir, "emitter.mjs.map");
      fs.writeFileSync(
        emitterJs,
        [
          "export function emitOrder(logger) {",
          "  logger.info`order ${'ord_sm'} paid ${999}`;",
          "}",
          "//# sourceMappingURL=emitter.mjs.map",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        emitterMap,
        buildSinglePointSourceMap({
          file: "emitter.mjs",
          sourceName: "src/orders/checkout.ts",
          genLine: 2,
          genCol: 1,
          origLine: 142,
          origCol: 7,
        }),
      );

      const runnerScript = `
        import { createLogger, CallSiteResolver } from ${JSON.stringify(sdkEntryUrl)};
        import { emitOrder } from ${JSON.stringify(pathToFileURL(emitterJs).href)};
        const records = [];
        const resolver = new CallSiteResolver();
        const logger = createLogger({
          identity: { service: "svc", env: "test", release: "r1" },
          enqueue(r) { records.push(r); return true; },
          flush: async () => {},
          shutdown: async () => {},
          getStats: () => ({
            queuedRecords: 0, queuedBytes: 0, pendingDropped: 0,
            totalEnqueued: 0, totalDropped: 0, totalSentRecords: 0,
            totalSentBatches: 0, totalFailedBatches: 0, totalRetries: 0, closed: false,
          }),
        }, { callsite: resolver });
        emitOrder(logger);
        console.log(JSON.stringify({ callsite: records[0]?.callsite, stats: resolver.getStats() }));
      `;

      const { stdout } = await execFileAsync(process.execPath, [
        "--enable-source-maps",
        "--input-type=module",
        "-e",
        runnerScript,
      ]);
      const parsed = JSON.parse(stdout.trim()) as {
        callsite?: { file: string; line: number; column?: number; function?: string };
        stats: { sourceMapCacheSize: number; stackCaptures: number };
      };

      assert.deepEqual(parsed.callsite, {
        file: path.resolve(tmpDir, "src/orders/checkout.ts"),
        line: 142,
        column: 7,
        function: "emitOrder",
      });
      // Resolved directly via Node's in-memory findSourceMap with zero disk cache entries!
      assert.equal(parsed.stats.sourceMapCacheSize, 0);
      assert.equal(parsed.stats.stackCaptures, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("maps CommonJS callers using the dist/cjs build and block-comment sourceMappingURL", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-sdk-cjs-"));
    try {
      const cjsEntry = path.resolve(process.cwd(), "dist/cjs/index.js");
      const emitterCjs = path.join(tmpDir, "emitter.cjs");
      const emitterMap = path.join(tmpDir, "emitter.cjs.map");
      fs.writeFileSync(
        emitterCjs,
        [
          "exports.emitCjs = function emitCjs(logger) {",
          "  logger.info`cjs order ${'ord_cjs'} cents ${500}`;",
          "};",
          "/*# sourceMappingURL=emitter.cjs.map */",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        emitterMap,
        buildSinglePointSourceMap({
          file: "emitter.cjs",
          sourceName: "src/cjs-orders.ts",
          genLine: 2,
          genCol: 1,
          origLine: 25,
          origCol: 3,
        }),
      );

      const runner = `
        const { createLogger } = require(${JSON.stringify(cjsEntry)});
        const { emitCjs } = require(${JSON.stringify(emitterCjs)});
        const records = [];
        const logger = createLogger({
          identity: { service: "svc", env: "test", release: "r1" },
          enqueue(r) { records.push(r); return true; },
          flush: async () => {},
          shutdown: async () => {},
          getStats: () => ({
            queuedRecords: 0, queuedBytes: 0, pendingDropped: 0,
            totalEnqueued: 0, totalDropped: 0, totalSentRecords: 0,
            totalSentBatches: 0, totalFailedBatches: 0, totalRetries: 0, closed: false,
          }),
        });
        emitCjs(logger);
        console.log(JSON.stringify(records[0]));
      `;

      const { stdout } = await execFileAsync(process.execPath, ["-e", runner]);
      const record = JSON.parse(stdout.trim()) as LogRecordInput;
      assert.deepEqual(record.tpl, {
        strings: ["cjs order ", " cents ", ""],
        args: ["ord_cjs", 500],
      });
      assert.deepEqual(record.callsite, {
        file: path.resolve(tmpDir, "src/cjs-orders.ts"),
        line: 25,
        column: 3,
        function: "emitCjs",
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
