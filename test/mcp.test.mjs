import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { listen } from "../dist/server.js";
import { DiagnosticClient } from "../dist/client.js";
test("real MCP stdio client negotiates and lists only authorized devices", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-mcp-"));
  const token = crypto.randomBytes(32).toString("hex");
  const service = await listen({
    directory: path.join(dir, "server"),
    adminToken: token,
    pollWaitMs: 0,
  });
  const admin = new DiagnosticClient(service.url, token, true);
  const op = await admin.api("/operators", { label: "model-operator" });
  const file = path.join(dir, "operator.json");
  fs.writeFileSync(file, JSON.stringify(op), { mode: 0o600 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "dist/cli.js",
      "mcp",
      "--url",
      service.url,
      "--token-file",
      file,
      "--allow-http-loopback",
      "true",
    ],
    stderr: "pipe",
  });
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((x) => x.name).sort(), [
    "diagnostics_devices",
    "diagnostics_request",
    "diagnostics_result",
  ]);
  const result = await client.callTool({
    name: "diagnostics_devices",
    arguments: {},
  });
  assert.deepEqual(JSON.parse(result.content[0].text), []);
});
