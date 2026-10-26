import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { listen } from "../dist/server.js";
import { DiagnosticClient } from "../dist/client.js";
test("real child Host pauses at breakpoint; independent worker resumes on idle timeout", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-breakpoint-"));
  const token = crypto.randomBytes(32).toString("hex");
  const server = await listen({
    directory: path.join(dir, "server"),
    adminToken: token,
    pollWaitMs: 20,
  });
  const admin = new DiagnosticClient(server.url, token, true);
  const op = await admin.api("/operators", { label: "tester" });
  const enrollment = await admin.api("/enrollments", { label: "child" });
  const child = fork(new URL("./debug-fixture.mjs", import.meta.url), [], {
    env: {
      ...process.env,
      DIAGNOSTIC_TEST_CONFIG: JSON.stringify({
        serverUrl: server.url,
        pairingCode: enrollment.pairingCode,
        stateDir: path.join(dir, "device"),
        permissions: ["debug", "inspect"],
        roots: [dir],
        allowHttpLoopback: true,
        pollMs: 20,
        debugIdleMs: 1800,
      }),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let restored = false;
  child.on("message", (m) => {
    if (m.type === "restored") restored = true;
  });
  t.after(async () => {
    child.kill("SIGKILL");
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await once(child, "message");
  const grant = await admin.api("/grants", {
    operatorId: op.operatorId,
    deviceId: enrollment.deviceId,
    permissions: ["debug", "inspect"],
    ttlMs: 30000,
  });
  const c = new DiagnosticClient(server.url, op.token, true);
  const req = async (operation, args = {}) => {
    const j = await c.request(
      enrollment.deviceId,
      grant.grantId,
      operation,
      args,
    );
    return c.wait(j.id, 10000);
  };
  const a = await req("debug.attach");
  const sessionId = a.result.value.sessionId;
  await req("debug.command", { sessionId, method: "Debugger.enable" });
  await req("debug.command", { sessionId, method: "Debugger.pause" });
  const events = await req("debug.events", { sessionId });
  assert.ok(
    events.result.value.events.some((e) => e.method === "Debugger.paused"),
  );
  // Send no more debug heartbeats: this must work while the main thread is paused.
  for (let i = 0; i < 60 && !restored; i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(restored, true);
  const snap = await req("snapshot");
  assert.equal(snap.status, "completed");
  assert.equal(snap.result.value.app.role, "fixture");
  child.send("stop");
  await once(child, "exit");
});
