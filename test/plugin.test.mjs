import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import WebServer from "@deepseek-ai/dsh-host-webserver";
import * as serverPlugin from "../dist/server-plugin.js";
import * as appPlugin from "../dist/plugin.js";
import { DiagnosticClient } from "../dist/client.js";
async function until(fn) {
  for (let i = 0; i < 200; i++) {
    const x = fn();
    if (x) return x;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("plugin startup timed out");
}
test("official Cordis and WebServer mount broker and App plugin; unload removes owned resources", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-plugin-test-"));
  const token = crypto.randomBytes(32).toString("hex");
  const file = path.join(dir, "admin.token");
  fs.writeFileSync(file, token, { mode: 0o600 });
  const host = new Context(),
    app = new Context();
  t.after(async () => {
    await app.fiber.dispose();
    await host.fiber.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  host.plugin(WebServer, { host: "127.0.0.1", port: 0 });
  await until(() => host.get("webServer", false)?.port);
  const serverFiber = host.plugin(serverPlugin, {
    directory: path.join(dir, "server"),
    adminTokenFile: file,
    pollWaitMs: 30,
  });
  await serverFiber.inertia;
  const url = `http://127.0.0.1:${host.webServer.port}/app-diagnostics/v1`;
  const admin = new DiagnosticClient(url, token, true);
  const op = await admin.api("/operators", { label: "test" });
  const enrollment = await admin.api("/enrollments", { label: "test-app" });
  const appFiber = app.plugin(appPlugin, {
    appId: "example",
    appVersion: "1.0.0",
    serverUrl: url,
    stateDir: path.join(dir, "device"),
    pairingCode: enrollment.pairingCode,
    permissions: ["inspect"],
    roots: [dir],
    allowHttpLoopback: true,
    pollMs: 20,
  });
  await appFiber.inertia;
  const service = await until(() => app.get("appDiagnostics", false));
  service.registerSnapshot("custom", () => ({ status: "ready" }));
  await once(service.agent, "ready");
  const grant = await admin.api("/grants", {
    operatorId: op.operatorId,
    deviceId: enrollment.deviceId,
    permissions: ["inspect"],
    ttlMs: 30000,
  });
  const client = new DiagnosticClient(url, op.token, true);
  const j = await client.request(
    enrollment.deviceId,
    grant.grantId,
    "snapshot",
  );
  const r = await client.wait(j.id, 10000);
  assert.equal(r.result.value.app.appId, "example");
  assert.equal(r.result.value.app.snapshots.custom.status, "ready");
  assert.equal(r.result.value.app.cordis, null);
  await appFiber.dispose();
  assert.equal(app.get("appDiagnostics", false), undefined);
  assert.equal(globalThis[Symbol.for("dsh.appDiagnostics.context")], undefined);
  await serverFiber.dispose();
  const response = await fetch(url + "/devices");
  assert.equal(response.status, 404);
});
