import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { listen } from "../dist/server.js";
import { DiagnosticClient } from "../dist/client.js";
import { DeviceAgent } from "../dist/device.js";
async function fixture(
  t,
  {
    start = true,
    localPermissions = ["inspect", "files.read", "database.read", "debug"],
    idle = 30000,
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-diagnostics-test-"));
  const adminToken = crypto.randomBytes(32).toString("hex");
  const service = await listen({
    directory: path.join(dir, "server"),
    adminToken,
    pollWaitMs: 30,
  });
  const admin = new DiagnosticClient(service.url, adminToken, true);
  const operator = await admin.api("/operators", { label: "developer" });
  const enrollment = await admin.api("/enrollments", {
    label: "example-device",
  });
  const client = new DiagnosticClient(service.url, operator.token, true);
  let agent;
  let ticketCount = 0,
    finishCount = 0;
  const config = {
    serverUrl: service.url,
    pairingCode: enrollment.pairingCode,
    stateDir: path.join(dir, "device"),
    permissions: localPermissions,
    roots: [dir],
    allowHttpLoopback: true,
    pollMs: 25,
    debugIdleMs: idle,
    debugMaxMs: 60000,
  };
  const launch = async () => {
    agent = new DeviceAgent(config, {
      snapshot: () => ({ feature: "example", count: 7 }),
      prepareDebug: () => ({ generation: ++ticketCount }),
      finishDebug: (ticket) => {
        assert.ok(ticket.generation);
        finishCount++;
      },
    });
    const ready = once(agent, "ready");
    agent.start();
    await ready;
    return agent;
  };
  if (start) await launch();
  let grant;
  const authorize = async (
    perms = ["inspect", "files.read", "database.read", "debug"],
    ttlMs = 60000,
  ) => {
    grant = await admin.api("/grants", {
      operatorId: operator.operatorId,
      deviceId: enrollment.deviceId,
      permissions: perms,
      ttlMs,
    });
    return grant;
  };
  if (start) await authorize();
  t.after(async () => {
    await agent?.stop();
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    service,
    admin,
    client,
    operator,
    enrollment,
    launch,
    authorize,
    config,
    stop: async () => {
      await agent?.stop();
      agent = undefined;
    },
    finishCount: () => finishCount,
    request: async (op, args = {}, requestId = crypto.randomUUID()) => {
      const j = await client.request(
        enrollment.deviceId,
        grant.grantId,
        op,
        args,
        requestId,
      );
      return client.wait(j.id, 10000);
    },
    grant: () => grant,
  };
}
test("real device: enrollment, snapshot, arbitrary file pagination, read-only SQL", async (t) => {
  const f = await fixture(t);
  const snap = await f.request("snapshot");
  assert.equal(snap.result.value.app.count, 7);
  fs.writeFileSync(path.join(f.dir, "example.log"), "0123456789");
  const read = await f.request("file.read", {
    path: path.join(f.dir, "example.log"),
    offset: 2,
    limit: 4,
  });
  assert.equal(
    Buffer.from(read.result.value.data, "base64").toString(),
    "2345",
  );
  assert.equal(read.result.value.nextOffset, 6);
  const db = new DatabaseSync(path.join(f.dir, "sample.db"));
  db.exec(
    "CREATE TABLE records(value TEXT); INSERT INTO records VALUES ('one'),('two');",
  );
  db.close();
  const q = await f.request("database.query", {
    path: path.join(f.dir, "sample.db"),
    sql: "SELECT * FROM records",
    limit: 1,
  });
  assert.equal(q.result.value.rows[0].value, "one");
  assert.equal(q.result.value.truncated, true);
  const write = await f.request("database.query", {
    path: path.join(f.dir, "sample.db"),
    sql: "DELETE FROM records",
  });
  assert.equal(write.status, "failed");
});
test("authorization: wrong operator, absent scope, revoked grant, symlink escape", async (t) => {
  const f = await fixture(t);
  await f.authorize(["inspect"]);
  await assert.rejects(
    f.client.request(f.enrollment.deviceId, f.grant().grantId, "file.read", {
      path: "/etc/hosts",
    }),
    /GRANT_DENIED/,
  );
  const outsider = await f.admin.api("/operators", { label: "other" });
  const c = new DiagnosticClient(f.service.url, outsider.token, true);
  await assert.rejects(
    c.request(f.enrollment.deviceId, f.grant().grantId, "snapshot"),
    /GRANT_DENIED/,
  );
  await f.authorize(["files.read"]);
  fs.symlinkSync(os.tmpdir(), path.join(f.dir, "escape"), "dir");
  const r = await f.request("file.list", { path: path.join(f.dir, "escape") });
  assert.equal(r.result.error, "PATH_DENIED");
  await f.admin.api("/revoke", { type: "grant", id: f.grant().grantId });
  await assert.rejects(
    f.client.request(f.enrollment.deviceId, f.grant().grantId, "snapshot"),
    /GRANT_DENIED/,
  );
});
test("local device policy independently rejects server grant", async (t) => {
  const f = await fixture(t, { localPermissions: ["inspect"] });
  const r = await f.request("debug.attach");
  assert.equal(r.result.error, "LOCAL_POLICY_DENIED");
});
test("idempotency: completed execution is reused, changed payload refused; audit excludes payload", async (t) => {
  const f = await fixture(t);
  const id = crypto.randomUUID();
  const one = await f.request("snapshot", {}, id);
  const two = await f.request("snapshot", {}, id);
  assert.deepEqual(one.result, two.result);
  await assert.rejects(
    f.request("snapshot", { different: true }, id),
    /IDEMPOTENCY_CONFLICT/,
  );
  const audit = await f.admin.api("/audit");
  assert.equal(
    audit.filter((r) => r.target === id && r.action === "execute:snapshot")
      .length,
    1,
  );
  assert.ok(!JSON.stringify(audit).includes("example-device"));
});
test("offline queue: resumes on same device without a new request", async (t) => {
  const f = await fixture(t);
  await f.stop();
  const j = await f.client.request(
    f.enrollment.deviceId,
    f.grant().grantId,
    "snapshot",
  );
  assert.equal(j.status, "queued");
  await f.launch();
  const r = await f.client.wait(j.id, 10000);
  assert.equal(r.status, "completed");
  assert.equal(r.result.value.app.count, 7);
});
test("enrollment is one-use and plain external HTTP is rejected", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.admin.api("/enroll", { pairingCode: f.enrollment.pairingCode }),
    /PAIRING_DENIED/,
  );
  assert.throws(
    () => new DiagnosticClient("http://example.com", "token", true),
    /HTTPS_REQUIRED/,
  );
});
test("real Node Inspector evaluates a field, owns session, detaches and finishes lifecycle", async (t) => {
  const f = await fixture(t);
  globalThis.__diagnosticFixture = { value: 42 };
  t.after(() => delete globalThis.__diagnosticFixture);
  const attach = await f.request("debug.attach");
  assert.equal(attach.status, "completed");
  const sessionId = attach.result.value.sessionId;
  const evalResult = await f.request("debug.command", {
    sessionId,
    method: "Runtime.evaluate",
    params: {
      expression: "globalThis.__diagnosticFixture.value",
      returnByValue: true,
    },
    readOnly: true,
  });
  assert.equal(evalResult.result.value.result.value, 42);
  const denied = await f.request("debug.command", {
    sessionId: "other",
    method: "Runtime.evaluate",
    params: { expression: "1" },
  });
  assert.equal(denied.result.error, "DEBUG_SESSION_DENIED");
  const detached = await f.request("debug.detach", { sessionId });
  assert.equal(detached.result.value.closed, true);
  assert.equal(f.finishCount(), 1);
});
test("revocation cleans an active debug session without trusting the next operator command", async (t) => {
  const f = await fixture(t);
  const r = await f.request("debug.attach");
  assert.equal(r.status, "completed");
  await f.admin.api("/revoke", { type: "grant", id: f.grant().grantId });
  for (let i = 0; i < 40 && !f.finishCount(); i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(f.finishCount(), 1);
});

test("plugin credentials are not exposed by a file-read grant", async (t) => {
  const f = await fixture(t);
  const r = await f.request("file.read", {
    path: path.join(f.dir, "device", "device.json"),
  });
  assert.equal(r.result.error, "CONTROL_STATE_DENIED");
});
test("expired offline requests are terminal, not executed on reconnection", async (t) => {
  const f = await fixture(t);
  await f.stop();
  const j = await f.client.request(
    f.enrollment.deviceId,
    f.grant().grantId,
    "snapshot",
    {},
    crypto.randomUUID(),
    1000,
  );
  await new Promise((r) => setTimeout(r, 1100));
  await f.launch();
  const r = await f.client.result(j.id);
  assert.equal(r.status, "expired");
});
test("read-only SQL bounds runaway queries and never enables extension loading", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.dir, "q.db");
  const db = new DatabaseSync(file);
  db.close();
  const ext = await f.request("database.query", {
    path: file,
    sql: "SELECT load_extension('anything')",
  });
  assert.equal(ext.status, "failed");
  const r = await f.request("database.query", {
    path: file,
    sql: "WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x) SELECT SUM(n) FROM x",
  });
  assert.equal(r.result.error, "QUERY_TIMEOUT");
  const snap = await f.request("snapshot");
  assert.equal(snap.status, "completed");
});

test("an unresolved evaluated promise has a deadline and is never blindly replayed", async (t) => {
  const f = await fixture(t);
  globalThis.__diagnosticOnce = 0;
  t.after(() => delete globalThis.__diagnosticOnce);
  const a = await f.request("debug.attach");
  const sessionId = a.result.value.sessionId;
  const id = crypto.randomUUID();
  const args = {
    sessionId,
    method: "Runtime.evaluate",
    params: {
      expression: "globalThis.__diagnosticOnce++; new Promise(() => {})",
      awaitPromise: true,
      returnByValue: true,
    },
  };
  const r = await f.request("debug.command", args, id);
  assert.equal(r.result.error, "DEBUG_COMMAND_OUTCOME_UNKNOWN");
  assert.equal(globalThis.__diagnosticOnce, 1);
  const again = await f.request("debug.command", args, id);
  assert.deepEqual(again.result, r.result);
  assert.equal(globalThis.__diagnosticOnce, 1);
  await f.request("debug.detach", { sessionId });
});
