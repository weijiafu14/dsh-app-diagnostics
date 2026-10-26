import { fork } from "node:child_process";
import { CdpTransport } from "./cdp.js";
import { parentPort, workerData, Worker } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import inspector from "node:inspector";
import { DatabaseSync } from "node:sqlite";
import {
  Fault,
  required,
  integer,
  record,
  text,
  endpoint,
  type DeviceConfig,
  type Job,
} from "./protocol.js";
const config = workerData as DeviceConfig;
const base = endpoint(config.serverUrl, config.allowHttpLoopback);
const parent = parentPort!;
let stopped = false;
let controller: AbortController | undefined;
fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
const dbFile = path.join(config.stateDir, "executions.db");
const journal = new DatabaseSync(dbFile);
fs.chmodSync(dbFile, 0o600);
journal.exec(
  "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY,status TEXT,result TEXT);",
);
const authFile = path.join(config.stateDir, "device.json");
let auth: { deviceId: string; token: string; serverUrl: string };
const rpcPending = new Map<
  string,
  {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }
>();
function rpc(method: string, ticket?: unknown): Promise<any> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rpcPending.delete(id);
      reject(new Fault("HOST_CALLBACK_TIMEOUT"));
    }, 5000);
    rpcPending.set(id, { resolve, reject, timer });
    parent.postMessage({ rpc: id, method, ticket });
  });
}
parent.on("message", (m) => {
  if (m.rpcResult) {
    const r = rpcPending.get(m.rpcResult);
    if (r) {
      clearTimeout(r.timer);
      rpcPending.delete(m.rpcResult);
      m.error ? r.reject(new Error(m.error)) : r.resolve(m.value);
    }
  }
  if (m.stop) {
    stopped = true;
    controller?.abort();
    void cleanup("device-disposed");
  }
});
async function request(
  route: string,
  body: unknown,
  authenticated = true,
  timeout = 30000,
) {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), timeout);
  if (route === "/poll") controller = c;
  try {
    const res = await fetch(base + route, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authenticated ? { Authorization: "Bearer " + auth.token } : {}),
      },
      body: JSON.stringify(body),
      signal: c.signal,
      redirect: "error",
    });
    const data = (await res.json()) as any;
    if (!res.ok)
      throw new Fault(
        data.error ?? "HTTP_ERROR",
        data.message ?? "Request failed",
        res.status,
      );
    return data;
  } finally {
    clearTimeout(timer);
    if (controller === c) controller = undefined;
  }
}
function allowedPath(value: unknown) {
  const target = fs.realpathSync(text(value, "PATH", 4096));
  const stateRoot = fs.realpathSync(config.stateDir);
  const privateRel = path.relative(stateRoot, target);
  if (
    privateRel === "" ||
    (!privateRel.startsWith(".." + path.sep) &&
      privateRel !== ".." &&
      !path.isAbsolute(privateRel))
  )
    throw new Fault("CONTROL_STATE_DENIED");
  const roots = [...config.roots, ...(config.logRoots ?? [])].map((r) =>
    fs.realpathSync(r),
  );
  if (
    !roots.some((r) => {
      const rel = path.relative(r, target);
      return (
        !rel.startsWith(".." + path.sep) &&
        rel !== ".." &&
        !path.isAbsolute(rel)
      );
    })
  )
    throw new Fault("PATH_DENIED");
  return target;
}
let debug:
  | {
      id: string;
      owner: string;
      grant: string;
      authorizationJob: string;
      session: inspector.Session | CdpTransport;
      target: string;
      deadline: number;
      expires: number;
      ticket: unknown;
      events: any[];
      seq: number;
      breakpoints: Set<string>;
    }
  | undefined;
let cleaning: Promise<void> | undefined;
function post(
  s: inspector.Session | CdpTransport,
  method: string,
  params: Record<string, unknown> = {},
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Fault(
            "DEBUG_COMMAND_OUTCOME_UNKNOWN",
            "Inspector response deadline exceeded; do not repeat side effects",
          ),
        ),
      5000,
    );
    try {
      s.post(method as any, params, (error, result) => {
        clearTimeout(timer);
        error ? reject(error) : resolve(result);
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}
async function cleanup(reason: string) {
  if (cleaning) return cleaning;
  const d = debug;
  if (!d) return;
  debug = undefined;
  cleaning = (async () => {
    try {
      await post(d.session, "Debugger.setSkipAllPauses", { skip: true }).catch(
        () => {},
      );
      for (const id of d.breakpoints)
        await post(d.session, "Debugger.removeBreakpoint", {
          breakpointId: id,
        }).catch(() => {});
      await post(d.session, "Debugger.resume").catch(() => {});
      await post(d.session, "Debugger.disable").catch(() => {});
      d.session.disconnect();
    } finally {
      await rpc("finish", d.ticket).catch((e) =>
        parent.postMessage({
          type: "fault",
          message: "Debug finish callback failed: " + e.message,
        }),
      );
      parent.postMessage({ type: "debugClosed", reason });
      cleaning = undefined;
    }
  })();
  return cleaning;
}
let verifying = false;
const watchdog = setInterval(() => {
  const d = debug;
  if (!d) return;
  if (Date.now() > Math.min(d.deadline, d.expires)) {
    void cleanup("expired");
    return;
  }
  if (!verifying) {
    verifying = true;
    void request("/authorize", { requestId: d.authorizationJob }, true, 3000)
      .catch(() => cleanup("authorization-or-transport-lost"))
      .finally(() => {
        verifying = false;
      });
  }
}, 1000);
async function dbQuery(args: Record<string, unknown>) {
  const file = allowedPath(args.path);
  const sql = text(args.sql, "SQL", 32000);
  const params = args.params ?? [];
  if (!Array.isArray(params) || params.length > 100)
    throw new Fault("INVALID_SQL_PARAMETERS");
  return new Promise((resolve, reject) => {
    const child = fork(new URL("./database-worker.js", import.meta.url), [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      execArgv: [],
    });
    let settled = false;
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Fault("QUERY_TIMEOUT")), 2000);
    child.once("message", (m: any) =>
      finish(m.ok ? null : new Fault("QUERY_FAILED", m.error), m.value),
    );
    child.once("error", (e) => finish(e));
    child.once("exit", () => finish(new Fault("QUERY_PROCESS_EXITED")));
    child.send({
      path: file,
      sql,
      params,
      limit: integer(args.limit, 1, 1000, 100),
    });
  });
}
async function execute(job: Job) {
  if (!config.permissions.includes(required[job.operation]))
    throw new Fault("LOCAL_POLICY_DENIED");
  const a = record(job.args);
  switch (job.operation) {
    case "snapshot":
      return {
        deviceId: auth.deviceId,
        at: new Date().toISOString(),
        runtime: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
        },
        roots: config.roots,
        logRoots: config.logRoots ?? [],
        app: await rpc("snapshot"),
      };
    case "file.list": {
      const dir = allowedPath(a.path);
      const offset = integer(a.offset, 0, 1e9, 0),
        limit = integer(a.limit, 1, 1000, 100);
      const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        path: dir,
        offset,
        total: entries.length,
        entries: entries.slice(offset, offset + limit).map((x) => ({
          name: x.name,
          type: x.isSymbolicLink()
            ? "symlink"
            : x.isDirectory()
              ? "directory"
              : "file",
        })),
        nextOffset: offset + limit < entries.length ? offset + limit : null,
      };
    }
    case "file.read": {
      const file = allowedPath(a.path);
      const fd = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) throw new Fault("NOT_REGULAR_FILE");
        const offset = integer(a.offset, 0, Number.MAX_SAFE_INTEGER, 0),
          limit = integer(a.limit, 1, 1048576, 262144);
        const b = Buffer.alloc(
          Math.min(limit, Math.max(0, stat.size - offset)),
        );
        const n = fs.readSync(fd, b, 0, b.length, offset);
        const data = b.subarray(0, n);
        return {
          path: file,
          offset,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          sha256: crypto.createHash("sha256").update(data).digest("hex"),
          encoding: "base64",
          data: data.toString("base64"),
          nextOffset: offset + n < stat.size ? offset + n : null,
        };
      } finally {
        fs.closeSync(fd);
      }
    }
    case "database.query":
      return dbQuery(a);
    case "debug.attach": {
      if (debug || cleaning) throw new Fault("DEBUG_BUSY");
      const target = a.target === undefined ? "host" : text(a.target, "TARGET");
      if (target !== "host" && !config.cdpTargets?.[target])
        throw new Fault("DEBUG_TARGET_DENIED");
      const ticket = await rpc("prepare");
      let s: inspector.Session | CdpTransport;
      try {
        if (target === "host") {
          s = new inspector.Session();
          s.connectToMainThread();
        } else {
          s = await CdpTransport.connect(config.cdpTargets![target]);
        }
        const d = (debug = {
          id: crypto.randomUUID(),
          owner: job.operatorId,
          grant: job.grantId,
          authorizationJob: job.id,
          session: s,
          target,
          deadline: Date.now() + (config.debugIdleMs ?? 30000),
          expires: Math.min(
            job.expiresAt,
            Date.now() + (config.debugMaxMs ?? 300000),
          ),
          ticket,
          events: [] as any[],
          seq: 0,
          breakpoints: new Set<string>(),
        });
        s.on("inspectorNotification", (m: any) => {
          const event = { seq: ++d.seq, ...m };
          if (Buffer.byteLength(JSON.stringify(event)) < 65536) {
            d.events.push(event);
            while (d.events.length > 100) d.events.shift();
          }
        });
        if (s instanceof CdpTransport)
          s.once("closed", () => void cleanup("target-disconnected"));
        return {
          target,
          sessionId: d.id,
          expiresAt: d.expires,
          idleMs: config.debugIdleMs ?? 30000,
          contextExpression:
            'globalThis[Symbol.for("dsh.appDiagnostics.context")]',
        };
      } catch (e) {
        s!?.disconnect();
        await rpc("finish", ticket);
        throw e;
      }
    }
    case "debug.command":
    case "debug.events":
    case "debug.detach": {
      const d = debug;
      if (
        !d ||
        d.id !== a.sessionId ||
        d.owner !== job.operatorId ||
        d.grant !== job.grantId
      )
        throw new Fault("DEBUG_SESSION_DENIED");
      d.deadline = Date.now() + (config.debugIdleMs ?? 30000);
      if (job.operation === "debug.detach") {
        await cleanup("requested");
        return { closed: true };
      }
      if (job.operation === "debug.events") {
        const after = integer(a.after, 0, Number.MAX_SAFE_INTEGER, 0);
        return {
          events: d.events.filter((e) => e.seq > after),
          cursor: d.seq,
          truncated:
            d.seq > after && (!d.events.length || after < d.events[0].seq - 1),
        };
      }
      const method = text(a.method, "METHOD");
      if (
        !(
          d.target === "host"
            ? /^(Runtime|Debugger|Profiler)\.[A-Za-z]+$/
            : /^(Runtime|Debugger|Profiler|DOM|Page|Network|Input)\.[A-Za-z]+$/
        ).test(method)
      )
        throw new Fault("DEBUG_METHOD_DENIED");
      const params = record(a.params ?? {});
      if (
        [
          "Runtime.evaluate",
          "Runtime.callFunctionOn",
          "Debugger.evaluateOnCallFrame",
        ].includes(method)
      ) {
        params.timeout = integer(params.timeout, 1, 3000, 1000);
        params.throwOnSideEffect =
          a.readOnly === true || params.throwOnSideEffect === true;
      }
      const result = await post(d.session, method, params);
      if (result?.breakpointId) d.breakpoints.add(result.breakpointId);
      return result;
    }
  }
  throw new Fault("UNKNOWN_OPERATION");
}
async function deliverSaved() {
  for (const row of journal
    .prepare("SELECT * FROM executions WHERE status='finished' LIMIT 20")
    .all() as any[]) {
    await request("/results", {
      requestId: row.id,
      result: JSON.parse(row.result),
    });
    journal
      .prepare("UPDATE executions SET status='acknowledged' WHERE id=?")
      .run(row.id);
  }
}
async function main() {
  if (fs.existsSync(authFile)) {
    auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
    if (auth.serverUrl !== base)
      throw new Fault("SERVER_CHANGED_REENROLL_REQUIRED");
  } else {
    if (!config.pairingCode) throw new Fault("PAIRING_REQUIRED");
    auth = {
      ...(await request("/enroll", { pairingCode: config.pairingCode }, false)),
      serverUrl: base,
    };
    fs.writeFileSync(authFile, JSON.stringify(auth), {
      mode: 0o600,
      flag: "wx",
    });
  }
  journal
    .prepare(
      "UPDATE executions SET status='finished',result=? WHERE status='started'",
    )
    .run(
      JSON.stringify({
        ok: false,
        error: "EXECUTION_OUTCOME_UNKNOWN",
        message: "Device restarted; command was not repeated",
      }),
    );
  parent.postMessage({ type: "ready", deviceId: auth.deviceId });
  while (!stopped) {
    try {
      await deliverSaved();
      const response = await request(
        "/poll",
        {
          metadata: {
            appId: config.appId ?? null,
            appVersion: config.appVersion ?? null,
            node: process.version,
            platform: process.platform,
            permissions: config.permissions,
          },
        },
        true,
        30000,
      );
      for (const job of response.jobs as Job[]) {
        if (stopped) break;
        const known = journal
          .prepare("SELECT * FROM executions WHERE id=?")
          .get(job.id) as any;
        if (known) {
          if (known.status === "finished") await deliverSaved();
          continue;
        }
        await request("/authorize", { requestId: job.id, start: true });
        journal
          .prepare("INSERT INTO executions VALUES(?,'started',NULL)")
          .run(job.id);
        let result: unknown;
        try {
          const value = await execute(job);
          const data = JSON.stringify({ ok: true, value: value ?? null });
          if (Buffer.byteLength(data) > 4 * 1024 * 1024)
            throw new Fault("RESULT_TOO_LARGE");
          result = JSON.parse(data);
        } catch (e) {
          result = {
            ok: false,
            error: e instanceof Fault ? e.code : "EXECUTION_FAILED",
            message: String((e as Error).message),
          };
        }
        journal
          .prepare(
            "UPDATE executions SET status='finished',result=? WHERE id=?",
          )
          .run(JSON.stringify(result), job.id);
        await deliverSaved();
      }
    } catch (e) {
      if (stopped) break;
      parent.postMessage({
        type: "transport",
        code: e instanceof Fault ? e.code : "TRANSPORT_ERROR",
      });
      if (debug) await cleanup("transport-lost");
      await new Promise((r) => setTimeout(r, config.pollMs ?? 2000));
    }
  }
}
main()
  .catch((e) =>
    parent.postMessage({
      type: "fault",
      message: e instanceof Fault ? e.code : "DEVICE_START_FAILED",
    }),
  )
  .finally(async () => {
    clearInterval(watchdog);
    await cleanup("shutdown");
    journal.close();
    parent.close();
  });
