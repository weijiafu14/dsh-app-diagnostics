import { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { endpoint, type DeviceConfig } from "./protocol.js";
export interface DeviceHooks {
  snapshot?: () => unknown | Promise<unknown>;
  prepareDebug?: () => unknown | Promise<unknown>;
  finishDebug?: (ticket: unknown) => void | Promise<void>;
}
export class DeviceAgent extends EventEmitter {
  private worker?: Worker;
  constructor(
    public config: DeviceConfig,
    private hooks: DeviceHooks = {},
  ) {
    super();
    endpoint(config.serverUrl, config.allowHttpLoopback);
  }
  start() {
    if (this.worker) throw new Error("Device already started");
    const worker = new Worker(new URL("./device-worker.js", import.meta.url), {
      workerData: this.config,
    });
    this.worker = worker;
    worker.on("message", async (m) => {
      if (m.rpc) {
        try {
          const value =
            m.method === "snapshot"
              ? await this.hooks.snapshot?.()
              : m.method === "prepare"
                ? await this.hooks.prepareDebug?.()
                : await this.hooks.finishDebug?.(m.ticket);
          worker.postMessage({ rpcResult: m.rpc, value: value ?? null });
        } catch (e) {
          worker.postMessage({
            rpcResult: m.rpc,
            error: String((e as Error).message),
          });
        }
      } else this.emit(m.type, m);
    });
    worker.on("error", (e) => this.emit("fault", { message: e.message }));
    worker.once("exit", () => {
      if (this.worker === worker) this.worker = undefined;
    });
    return this;
  }
  async stop() {
    const w = this.worker;
    if (!w || w.threadId === -1) return;
    this.worker = undefined;
    w.postMessage({ stop: true });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              "Device shutdown timed out; worker was not forcibly killed while debugging",
            ),
          ),
        15000,
      );
      w.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
