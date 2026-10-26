import { EventEmitter } from "node:events";
/** Connect only to a deployment-configured endpoint; request payloads cannot supply a URL. */
export class CdpTransport extends EventEmitter {
  private ws: WebSocket;
  private next = 0;
  private pending = new Map<
    number,
    { callback: (e: Error | null, r?: any) => void; timer: NodeJS.Timeout }
  >();
  private constructor(url: string) {
    super();
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (e) => {
      try {
        const msg = JSON.parse(String(e.data));
        if (msg.id) {
          const p = this.pending.get(msg.id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(msg.id);
            p.callback(
              msg.error ? new Error(msg.error.message) : null,
              msg.result,
            );
          }
        } else if (msg.method) this.emit("inspectorNotification", msg);
      } catch {
        /* Ignore malformed unsolicited events. */
      }
    });
    this.ws.addEventListener("close", () => {
      this.fail(new Error("CDP disconnected"));
      this.emit("closed");
    });
    this.ws.addEventListener("error", () =>
      this.fail(new Error("CDP transport error")),
    );
  }
  static async connect(url: string) {
    const parsed = new URL(url);
    if (
      !["ws:", "wss:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      throw new Error("Invalid configured CDP URL");
    if (
      parsed.protocol === "ws:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
    )
      throw new Error("Plain CDP must be loopback");
    const t = new CdpTransport(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        t.disconnect();
        reject(new Error("CDP connect timeout"));
      }, 5000);
      t.ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      t.ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("CDP connection failed"));
        },
        { once: true },
      );
    });
    return t;
  }
  post(
    method: string,
    params: object,
    callback: (e: Error | null, r?: any) => void,
  ) {
    if (this.ws.readyState !== WebSocket.OPEN) {
      callback(new Error("CDP not open"));
      return;
    }
    const id = ++this.next;
    const timer = setTimeout(() => {
      this.pending.delete(id);
      callback(new Error("CDP response timeout; do not repeat side effects"));
    }, 5000);
    this.pending.set(id, { callback, timer });
    this.ws.send(JSON.stringify({ id, method, params }));
  }
  private fail(error: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.callback(error);
    }
    this.pending.clear();
  }
  disconnect() {
    this.fail(new Error("CDP detached"));
    this.ws.close();
  }
}
