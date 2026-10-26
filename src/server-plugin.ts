import fs from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import "@deepseek-ai/dsh-host-webserver";
import { DiagnosticServer, type ServerConfig } from "./server.js";
import { PREFIX } from "./protocol.js";
export const name = "app-diagnostics-server";
export const inject = ["webServer"];
export type Config = Omit<ServerConfig, "adminToken"> & {
  adminTokenFile: string;
};
export function apply(ctx: Context, config: Config) {
  const broker = new DiagnosticServer({
    ...config,
    adminToken: fs.readFileSync(config.adminTokenFile, "utf8").trim(),
  });
  const remove = ctx.webServer.register({
    kind: "prefix",
    path: PREFIX,
    handler: (req, res) => broker.handle(req, res),
  });
  ctx.effect(() => () => {
    remove();
    broker.close();
    return broker.drain().then(() => broker.dispose());
  });
  return broker;
}
