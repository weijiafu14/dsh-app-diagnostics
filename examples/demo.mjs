// A complete disposable example. It contains no application-specific integration.
import { Context } from "@deepseek-ai/cordis";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as plugin from "../dist/plugin.js";
import { listen } from "../dist/server.js";
import { DiagnosticClient } from "../dist/client.js";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-diagnostics-demo-"));
const token = crypto.randomBytes(32).toString("hex");
const server = await listen({
  directory: path.join(root, "server"),
  adminToken: token,
  pollWaitMs: 50,
});
const app = new Context();
try {
  const admin = new DiagnosticClient(server.url, token, true);
  const developer = await admin.api("/operators", {
    label: "Example developer",
  });
  const enrollment = await admin.api("/enrollments", { label: "Example App" });
  const fiber = app.plugin(plugin, {
    appId: "example-app",
    appVersion: "1.0.0",
    serverUrl: server.url,
    pairingCode: enrollment.pairingCode,
    stateDir: path.join(root, "device"),
    permissions: ["inspect", "files.read", "debug"],
    roots: [path.join(root, "app")],
    allowHttpLoopback: true,
  });
  fs.mkdirSync(path.join(root, "app"));
  fs.writeFileSync(
    path.join(root, "app", "app.log"),
    "An example application event\n",
  );
  await fiber.inertia;
  await once(app.appDiagnostics.agent, "ready");
  app.appDiagnostics.registerSnapshot("example", () => ({ counter: 7 }));
  const grant = await admin.api("/grants", {
    operatorId: developer.operatorId,
    deviceId: enrollment.deviceId,
    permissions: ["inspect", "files.read", "debug"],
    ttlMs: 60000,
  });
  const client = new DiagnosticClient(server.url, developer.token, true);
  const execute = async (operation, args = {}) => {
    const j = await client.request(
      enrollment.deviceId,
      grant.grantId,
      operation,
      args,
    );
    return client.wait(j.id, 10000);
  };
  const snapshot = await execute("snapshot");
  if (snapshot.result?.value.app.snapshots.example.counter !== 7)
    throw Error("Snapshot failed");
  const log = await execute("file.read", {
    path: path.join(root, "app", "app.log"),
  });
  if (!log.result?.ok) throw Error("Log failed");
  const debug = await execute("debug.attach");
  const sessionId = debug.result.value.sessionId;
  const evaluated = await execute("debug.command", {
    sessionId,
    method: "Runtime.evaluate",
    params: { expression: "2 + 3", returnByValue: true },
    readOnly: true,
  });
  if (evaluated.result?.value.result.value !== 5) throw Error("Debug failed");
  await execute("debug.detach", { sessionId });
  console.log(
    JSON.stringify({
      snapshot: "passed",
      fileRead: "passed",
      inspector: "passed",
      cleanup: "passed",
    }),
  );
} finally {
  await app.fiber.dispose();
  await server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
