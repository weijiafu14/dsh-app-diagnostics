import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { listen } from "../dist/server.js";
import { DiagnosticClient } from "../dist/client.js";
import { DeviceAgent } from "../dist/device.js";
test("real Chromium page CDP: evaluate, DOM and detach through the device relay", async (t) => {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const chrome = candidates.find((p) => fs.existsSync(p));
  if (!chrome) {
    t.skip("Chrome not installed; Node Inspector tests still run");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-cdp-test-"));
  const profile = path.join(dir, "chrome");
  fs.mkdirSync(profile);
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      "--user-data-dir=" + profile,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let service, agent;
  t.after(async () => {
    await agent?.stop();
    child.kill("SIGKILL");
    await service?.close();
    await new Promise((r) => setTimeout(r, 100));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let port;
  for (let i = 0; i < 100; i++) {
    try {
      port = Number(
        fs
          .readFileSync(path.join(profile, "DevToolsActivePort"), "utf8")
          .split("\n")[0],
      );
      break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(port, "Chrome remote-debugging port ready");
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) =>
    r.json(),
  );
  const page = pages.find((x) => x.type === "page");
  assert.ok(page);
  const token = crypto.randomBytes(32).toString("hex");
  service = await listen({
    directory: path.join(dir, "server"),
    adminToken: token,
    pollWaitMs: 20,
  });
  const admin = new DiagnosticClient(service.url, token, true);
  const op = await admin.api("/operators", { label: "developer" });
  const en = await admin.api("/enrollments", { label: "browser-app" });
  agent = new DeviceAgent({
    serverUrl: service.url,
    stateDir: path.join(dir, "device"),
    pairingCode: en.pairingCode,
    permissions: ["debug"],
    roots: [dir],
    allowHttpLoopback: true,
    pollMs: 20,
    cdpTargets: { page: page.webSocketDebuggerUrl },
  });
  const ready = once(agent, "ready");
  agent.start();
  await ready;
  const grant = await admin.api("/grants", {
    operatorId: op.operatorId,
    deviceId: en.deviceId,
    permissions: ["debug"],
    ttlMs: 30000,
  });
  const client = new DiagnosticClient(service.url, op.token, true);
  const run = async (op, args) => {
    const r = await client.request(en.deviceId, grant.grantId, op, args);
    return client.wait(r.id, 10000);
  };
  const denied = await run("debug.attach", { target: "unknown" });
  assert.equal(denied.result.error, "DEBUG_TARGET_DENIED");
  const opened = await run("debug.attach", { target: "page" });
  assert.equal(opened.result.ok, true);
  const sessionId = opened.result.value.sessionId;
  const evaluated = await run("debug.command", {
    sessionId,
    method: "Runtime.evaluate",
    params: { expression: "document.location.href", returnByValue: true },
    readOnly: true,
  });
  assert.equal(evaluated.result.value.result.value, "about:blank");
  const dom = await run("debug.command", {
    sessionId,
    method: "DOM.getDocument",
    params: { depth: 0 },
  });
  assert.equal(dom.result.value.root.nodeName, "#document");
  const detached = await run("debug.detach", { sessionId });
  assert.equal(detached.result.value.closed, true);
});
