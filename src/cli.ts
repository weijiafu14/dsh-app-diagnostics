#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { listen } from "./server.js";
import { DiagnosticClient } from "./client.js";
import type { Operation } from "./protocol.js";
const [command, ...argv] = process.argv.slice(2);
const opts: Record<string, string> = {};
for (let i = 0; i < argv.length; i += 2) {
  if (!argv[i].startsWith("--") || argv[i + 1] === undefined)
    throw new Error("Use --name value pairs");
  opts[argv[i].slice(2)] = argv[i + 1];
}
const readToken = () => {
  if (!opts["token-file"]) throw new Error("--token-file required");
  const s = fs.readFileSync(opts["token-file"], "utf8").trim();
  return s.startsWith("{") ? JSON.parse(s).token : s;
};
async function main() {
  if (command === "init") {
    const dir = path.resolve(opts.dir ?? ".state");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, "admin.token");
    fs.writeFileSync(file, crypto.randomBytes(32).toString("base64url"), {
      mode: 0o600,
      flag: "wx",
    });
    console.log(JSON.stringify({ adminTokenFile: file }));
    return;
  }
  if (command === "server") {
    const service = await listen(
      { directory: opts.dir ?? ".state", adminToken: readToken() },
      Number(opts.port ?? 19740),
      opts.host ?? "127.0.0.1",
    );
    console.log(JSON.stringify({ url: service.url }));
    for (const sig of ["SIGTERM", "SIGINT"] as const)
      process.once(sig, () => void service.close().then(() => process.exit(0)));
    return;
  }
  if (!opts.url)
    throw new Error("--url required (include /app-diagnostics/v1)");
  const client = new DiagnosticClient(
    opts.url,
    readToken(),
    opts["allow-http-loopback"] === "true",
  );
  let result;
  if (command === "devices") result = await client.devices();
  else if (command === "api")
    result = await client.api(
      opts.path,
      opts["data-file"]
        ? JSON.parse(fs.readFileSync(opts["data-file"], "utf8"))
        : undefined,
    );
  else if (command === "request")
    result = await client.request(
      opts.device,
      opts.grant,
      opts.operation as Operation,
      opts["args-file"]
        ? JSON.parse(fs.readFileSync(opts["args-file"], "utf8"))
        : {},
      opts.id,
      Number(opts.ttl ?? 3600000),
    );
  else if (command === "result")
    result = await client.wait(opts.id, Number(opts.wait ?? 0));
  else if (command === "mcp") {
    const { runMcp } = await import("./mcp.js");
    await runMcp(client);
    return;
  } else
    throw new Error(
      "Commands: init, server, api, devices, request, result, mcp",
    );
  const json = JSON.stringify(result, null, 2) + "\n";
  if (opts.out) fs.writeFileSync(opts.out, json, { mode: 0o600, flag: "wx" });
  else console.log(json);
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
