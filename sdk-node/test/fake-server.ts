import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { gunzipSync } from "node:zlib";
import type { BatchEnvelope } from "../src/types.js";

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly rawBody: Buffer;
  readonly decompressedBody: string;
  readonly envelope: BatchEnvelope;
  readonly receivedAtMs: number;
}

export interface FakeResponsePlan {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  /** Delay before sending response headers/body in milliseconds. */
  readonly delayMs?: number;
  /** Hold connection open without responding until aborted or closed. */
  readonly hang?: boolean;
  /** Abruptly destroy the underlying TCP socket to simulate a network reset. */
  readonly destroySocket?: boolean;
}

export class FakeIngestServer {
  private readonly server: http.Server;
  private readonly sockets = new Set<Socket>();
  private readonly plannedResponses: FakeResponsePlan[] = [];
  private readonly waiters: Array<{
    targetCount: number;
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  readonly requests: RecordedRequest[] = [];
  private _url = "";

  constructor() {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => {
        this.sockets.delete(socket);
      });
    });
  }

  get url(): string {
    return this._url;
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address() as AddressInfo;
    this._url = `http://127.0.0.1:${address.port}`;
    return this._url;
  }

  async close(): Promise<void> {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("FakeIngestServer closed while waiting for requests"));
    }
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  enqueueResponse(...plans: FakeResponsePlan[]): void {
    this.plannedResponses.push(...plans);
  }

  reset(): void {
    this.requests.length = 0;
    this.plannedResponses.length = 0;
  }

  waitForRequests(count: number, timeoutMs = 5_000): Promise<void> {
    if (this.requests.length >= count) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
        }
        reject(
          new Error(
            `Timed out waiting for ${count} requests (received ${this.requests.length})`,
          ),
        );
      }, timeoutMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      this.waiters.push({ targetCount: count, resolve, reject, timer });
    });
  }

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      const encoding = req.headers["content-encoding"];
      const decompressedBuffer =
        encoding === "gzip" ? gunzipSync(rawBody) : rawBody;
      const decompressedBody = decompressedBuffer.toString("utf8");
      const envelope = JSON.parse(decompressedBody) as BatchEnvelope;

      this.requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: { ...req.headers },
        rawBody,
        decompressedBody,
        envelope,
        receivedAtMs: Date.now(),
      });
      this.notifyWaiters();

      const plan = this.plannedResponses.shift() ?? { status: 200 };

      if (plan.destroySocket) {
        req.socket.destroy();
        return;
      }

      if (plan.hang) {
        // Leave connection open until client aborts or server closes.
        return;
      }

      const send = () => {
        if (res.writableEnded || req.socket.destroyed) {
          return;
        }
        const status = plan.status ?? 200;
        const headers: Record<string, string> = {
          "content-type": "application/json",
          ...(plan.headers ?? {}),
        };
        res.writeHead(status, headers);
        res.end(plan.body ?? "{}");
      };

      if (plan.delayMs && plan.delayMs > 0) {
        const timer = setTimeout(send, plan.delayMs);
        if (typeof timer.unref === "function") {
          timer.unref();
        }
        res.once("close", () => clearTimeout(timer));
      } else {
        send();
      }
    });
  }

  private notifyWaiters(): void {
    for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.waiters[i]!;
      if (this.requests.length >= waiter.targetCount) {
        clearTimeout(waiter.timer);
        this.waiters.splice(i, 1);
        waiter.resolve();
      }
    }
  }
}
