import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { listen } from "../dist/server.js";
import { DiagnosticClient } from "../dist/client.js";
test("broker restart preserves offline queue; already-started command becomes unknown, never redispatched", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-restart-"));
  const config = {
    directory: dir,
    adminToken: crypto.randomBytes(32).toString("hex"),
    pollWaitMs: 0,
  };
  let s = await listen(config);
  t.after(async () => {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let admin = new DiagnosticClient(s.url, config.adminToken, true);
  const op = await admin.api("/operators", { label: "dev" });
  const en = await admin.api("/enrollments", { label: "target" });
  const device = await admin.api("/enroll", { pairingCode: en.pairingCode });
  const grant = await admin.api("/grants", {
    operatorId: op.operatorId,
    deviceId: device.deviceId,
    permissions: ["inspect"],
    ttlMs: 60000,
  });
  let c = new DiagnosticClient(s.url, op.token, true);
  const j = await c.request(device.deviceId, grant.grantId, "snapshot");
  const port = s.server.address().port;
  await s.close();
  s = await listen(config, port);
  c = new DiagnosticClient(s.url, op.token, true);
  assert.equal((await c.result(j.id)).status, "queued");
  const d = new DiagnosticClient(s.url, device.token, true);
  const poll = await d.api("/poll", {});
  assert.equal(poll.jobs[0].id, j.id);
  await d.api("/authorize", { requestId: j.id, start: true });
  await s.close();
  s = await listen(config, port);
  c = new DiagnosticClient(s.url, op.token, true);
  assert.equal((await c.result(j.id)).status, "unknown");
  const d2 = new DiagnosticClient(s.url, device.token, true);
  assert.deepEqual((await d2.api("/poll", {})).jobs, []);
});
