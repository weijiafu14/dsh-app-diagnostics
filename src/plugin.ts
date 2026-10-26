import { Context, Service } from "@deepseek-ai/cordis";
import { DeviceAgent, type DeviceHooks } from "./device.js";
import type { DeviceConfig } from "./protocol.js";
export const name = "app-diagnostics";
export interface Config extends DeviceConfig {
  appId: string;
  appVersion?: string;
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    appDiagnostics: AppDiagnostics;
  }
}
export class AppDiagnostics extends Service {
  private snapshots = new Map<string, () => unknown | Promise<unknown>>();
  private lifecycle: Pick<DeviceHooks, "prepareDebug" | "finishDebug"> = {};
  readonly agent: DeviceAgent;
  constructor(ctx: Context, config: Config) {
    super(ctx, "appDiagnostics");
    if (!config.appId) throw new Error("appId is required");
    const symbol = Symbol.for("dsh.appDiagnostics.context");
    if ((globalThis as any)[symbol])
      throw new Error("Only one diagnostic device per Host is supported");
    (globalThis as any)[symbol] = ctx;
    this.agent = new DeviceAgent(config, {
      snapshot: async () => {
        const custom: Record<string, unknown> = {};
        for (const [name, read] of this.snapshots) custom[name] = await read();
        // The official inspector is optional. No private internal DSH imports.
        const inspector = ctx.get("inspector" as any, false) as any;
        return {
          appId: config.appId,
          appVersion: config.appVersion ?? null,
          snapshots: custom,
          cordis: inspector?.cordis?.getTree
            ? await inspector.cordis.getTree()
            : null,
        };
      },
      prepareDebug: () => this.lifecycle.prepareDebug?.(),
      finishDebug: (ticket) => this.lifecycle.finishDebug?.(ticket),
    });
    this.agent.on("fault", (e) => ctx.logger.warn("Diagnostics: " + e.message));
    ctx.effect(() => {
      this.agent.start();
      return async () => {
        await this.agent.stop();
        if ((globalThis as any)[symbol] === ctx)
          delete (globalThis as any)[symbol];
      };
    });
  }
  /** Optional convenience snapshots; files, SQL and Inspector do not require these. */
  registerSnapshot(name: string, read: () => unknown | Promise<unknown>) {
    if (this.snapshots.has(name))
      throw new Error("Snapshot already registered");
    this.snapshots.set(name, read);
    return () => this.snapshots.delete(name);
  }
  /** Optional application-specific safe-point handling. Never invents a task model. */
  registerDebugLifecycle(
    hooks: Pick<DeviceHooks, "prepareDebug" | "finishDebug">,
  ) {
    if (this.lifecycle.prepareDebug || this.lifecycle.finishDebug)
      throw new Error("Lifecycle already registered");
    this.lifecycle = hooks;
    return () => {
      if (this.lifecycle === hooks) this.lifecycle = {};
    };
  }
}
export function apply(ctx: Context, config: Config) {
  return new AppDiagnostics(ctx, config);
}
