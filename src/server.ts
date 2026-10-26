import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  PREFIX,
  Fault,
  record,
  text,
  integer,
  permissions,
  required,
  type Permission,
  type Operation,
} from "./protocol.js";
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const secret = () => crypto.randomBytes(32).toString("base64url");
const id = () => crypto.randomUUID();
export interface ServerConfig {
  directory: string;
  adminToken: string;
  pollWaitMs?: number;
  maxBodyBytes?: number;
  retentionDays?: number;
}
export class DiagnosticServer {
  private db: DatabaseSync;
  private closed = false;
  private active = 0;
  private waiters = new Set<() => void>();
  private maxBody: number;
  private pollWait: number;
  constructor(private config: ServerConfig) {
    if (config.adminToken.length < 32) throw new Fault("ADMIN_TOKEN_TOO_SHORT");
    fs.mkdirSync(config.directory, { recursive: true, mode: 0o700 });
    const file = path.join(config.directory, "diagnostics.db");
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS operators(id TEXT PRIMARY KEY,label TEXT,hash TEXT UNIQUE,active INTEGER);
   CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,label TEXT,hash TEXT UNIQUE,active INTEGER,last_seen INTEGER,metadata TEXT);
   CREATE TABLE IF NOT EXISTS enrollments(hash TEXT PRIMARY KEY,device_id TEXT,label TEXT,expires INTEGER,used INTEGER);
   CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY,operator_id TEXT,device_id TEXT,permissions TEXT,expires INTEGER,active INTEGER);
   CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,device_id TEXT,operator_id TEXT,grant_id TEXT,operation TEXT,args TEXT,expires INTEGER,status TEXT,result TEXT,created INTEGER,hash TEXT);
   CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER,actor TEXT,action TEXT,target TEXT,outcome TEXT);
  `);
    this.maxBody = config.maxBodyBytes ?? 5 * 1024 * 1024;
    this.pollWait = config.pollWaitMs ?? 20000;
    // Running commands are never replayed after an uncertain process/server restart.
    this.db
      .prepare("UPDATE jobs SET status='unknown' WHERE status='running'")
      .run();
  }
  private log(actor: string, action: string, target: string, outcome = "ok") {
    this.db
      .prepare(
        "INSERT INTO audit(at,actor,action,target,outcome) VALUES(?,?,?,?,?)",
      )
      .run(Date.now(), actor, action, target, outcome);
  }
  private auth(req: IncomingMessage): {
    kind: "admin" | "operator" | "device";
    id: string;
  } {
    const token = String(req.headers.authorization ?? "").replace(
      /^Bearer /,
      "",
    );
    const h = hash(token);
    if (
      crypto.timingSafeEqual(
        Buffer.from(h),
        Buffer.from(hash(this.config.adminToken)),
      )
    )
      return { kind: "admin", id: "admin" };
    for (const kind of ["operator", "device"] as const) {
      const row = this.db
        .prepare(`SELECT id FROM ${kind}s WHERE hash=? AND active=1`)
        .get(h) as any;
      if (row) return { kind, id: row.id };
    }
    throw new Fault("UNAUTHORIZED", "Unauthorized", 401);
  }
  private grant(
    gid: string,
    operatorId: string,
    deviceId: string,
    permission?: Permission,
  ) {
    const g = this.db
      .prepare(
        "SELECT * FROM grants WHERE id=? AND operator_id=? AND device_id=? AND active=1 AND expires>?",
      )
      .get(gid, operatorId, deviceId, Date.now()) as any;
    if (!g || (permission && !JSON.parse(g.permissions).includes(permission)))
      throw new Fault("GRANT_DENIED", "Grant absent, expired or revoked", 403);
    return g;
  }
  private job(jid: string) {
    const j = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(jid) as any;
    if (!j) throw new Fault("NOT_FOUND", "Not found", 404);
    return j;
  }
  private publicJob(j: any) {
    return {
      id: j.id,
      deviceId: j.device_id,
      operatorId: j.operator_id,
      grantId: j.grant_id,
      operation: j.operation,
      args: JSON.parse(j.args),
      expiresAt: j.expires,
      status: j.status,
      ...(j.result ? { result: JSON.parse(j.result) } : {}),
    };
  }
  private prune() {
    const cutoff = Date.now() - (this.config.retentionDays ?? 7) * 86400000;
    this.db.prepare("DELETE FROM jobs WHERE created<?").run(cutoff);
    this.db.prepare("DELETE FROM audit WHERE at<?").run(cutoff);
    this.db.prepare("DELETE FROM enrollments WHERE expires<?").run(cutoff);
    this.db
      .prepare(
        "UPDATE jobs SET status='expired' WHERE expires<=? AND status IN ('queued','delivered')",
      )
      .run(Date.now());
  }
  async handle(req: IncomingMessage, res: ServerResponse) {
    this.active++;
    let actor = "unauthenticated",
      route = "";
    try {
      const url = new URL(req.url ?? "/", "http://local");
      if (!(url.pathname === PREFIX || url.pathname.startsWith(PREFIX + "/"))) {
        res.writeHead(404).end();
        return;
      }
      route = url.pathname.slice(PREFIX.length);
      res.setHeader("Cache-Control", "no-store");
      if (this.closed) throw new Fault("CLOSED", "Server closed", 503);
      let body: Record<string, any> = {};
      if (req.method === "POST") {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > this.maxBody)
            throw new Fault("BODY_TOO_LARGE", "Body too large", 413);
          chunks.push(chunk);
        }
        try {
          body = record(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
        } catch (e) {
          if (e instanceof Fault) throw e;
          throw new Fault("INVALID_JSON");
        }
      }
      this.prune();
      let result: any;
      if (route === "/enroll" && req.method === "POST") {
        const pairing = text(body.pairingCode, "PAIRING");
        const row = this.db
          .prepare(
            "SELECT * FROM enrollments WHERE hash=? AND used=0 AND expires>?",
          )
          .get(hash(pairing), Date.now()) as any;
        if (!row)
          throw new Fault("PAIRING_DENIED", "Invalid or consumed pairing", 403);
        const token = secret();
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db
            .prepare("UPDATE enrollments SET used=1 WHERE hash=?")
            .run(hash(pairing));
          this.db
            .prepare("INSERT INTO devices VALUES(?,?,?,1,0,?)")
            .run(row.device_id, row.label, hash(token), "{}");
          this.db.exec("COMMIT");
        } catch (e) {
          this.db.exec("ROLLBACK");
          throw e;
        }
        result = { deviceId: row.device_id, token };
        this.log(row.device_id, "enroll", row.device_id);
      } else {
        const who = this.auth(req);
        actor = who.id;
        if (who.kind === "admin") {
          if (route === "/operators" && req.method === "POST") {
            const token = secret(),
              oid = id();
            this.db
              .prepare("INSERT INTO operators VALUES(?,?,?,1)")
              .run(oid, text(body.label, "LABEL"), hash(token));
            result = { operatorId: oid, token };
          } else if (route === "/enrollments" && req.method === "POST") {
            const code = secret(),
              did = id(),
              expires = Date.now() + integer(body.ttlMs, 1000, 3600000, 900000);
            this.db
              .prepare("INSERT INTO enrollments VALUES(?,?,?,?,0)")
              .run(hash(code), did, text(body.label, "LABEL"), expires);
            result = { deviceId: did, pairingCode: code, expiresAt: expires };
          } else if (route === "/grants" && req.method === "POST") {
            const oid = text(body.operatorId, "OPERATOR"),
              did = text(body.deviceId, "DEVICE");
            if (
              !this.db
                .prepare("SELECT id FROM operators WHERE id=? AND active=1")
                .get(oid) ||
              !this.db
                .prepare("SELECT id FROM devices WHERE id=? AND active=1")
                .get(did)
            )
              throw new Fault("NOT_FOUND");
            if (
              !Array.isArray(body.permissions) ||
              !body.permissions.length ||
              body.permissions.some((p: any) => !permissions.includes(p))
            )
              throw new Fault("INVALID_PERMISSIONS");
            const gid = id(),
              expires =
                Date.now() + integer(body.ttlMs, 1000, 86400000, 3600000);
            this.db
              .prepare("INSERT INTO grants VALUES(?,?,?,?,?,1)")
              .run(
                gid,
                oid,
                did,
                JSON.stringify([...new Set(body.permissions)]),
                expires,
              );
            result = { grantId: gid, expiresAt: expires };
          } else if (route === "/revoke" && req.method === "POST") {
            const type = text(body.type, "TYPE");
            if (!["device", "operator", "grant"].includes(type))
              throw new Fault("INVALID_TYPE");
            const target = text(body.id, "ID");
            this.db
              .prepare(`UPDATE ${type}s SET active=0 WHERE id=?`)
              .run(target);
            result = { revoked: true };
            this.log(actor, "revoke-" + type, target);
          } else if (route === "/audit" && req.method === "GET")
            result = this.db
              .prepare("SELECT * FROM audit WHERE seq>? ORDER BY seq LIMIT 200")
              .all(
                integer(
                  url.searchParams.get("after") ?? undefined,
                  0,
                  Number.MAX_SAFE_INTEGER,
                  0,
                ),
              );
          else if (route === "/devices" && req.method === "GET")
            result = this.db
              .prepare("SELECT id,label,active,last_seen,metadata FROM devices")
              .all();
          else throw new Fault("ADMIN_ROUTE_NOT_FOUND", "Not found", 404);
          this.log(
            actor,
            route,
            String(
              result?.grantId ?? result?.deviceId ?? result?.operatorId ?? "",
            ),
          );
        } else if (who.kind === "operator") {
          if (route === "/devices" && req.method === "GET")
            result = this.db
              .prepare(
                "SELECT DISTINCT d.id,d.label,d.last_seen,d.metadata FROM devices d JOIN grants g ON g.device_id=d.id WHERE g.operator_id=? AND g.active=1 AND g.expires>? AND d.active=1",
              )
              .all(who.id, Date.now());
          else if (route === "/requests" && req.method === "POST") {
            const did = text(body.deviceId, "DEVICE"),
              gid = text(body.grantId, "GRANT"),
              op = text(body.operation, "OPERATION") as Operation;
            if (!Object.hasOwn(required, op))
              throw new Fault("INVALID_OPERATION");
            const grant = this.grant(gid, who.id, did, required[op]);
            const args = record(body.args ?? {});
            const jid = text(body.requestId, "REQUEST_ID", 128);
            if (!/^[A-Za-z0-9_-]+$/.test(jid))
              throw new Fault("INVALID_REQUEST_ID");
            const sig = hash(JSON.stringify([who.id, did, gid, op, args]));
            const old = this.db
              .prepare("SELECT * FROM jobs WHERE id=?")
              .get(jid) as any;
            if (old) {
              if (old.hash !== sig)
                throw new Fault(
                  "IDEMPOTENCY_CONFLICT",
                  "Request ID reused with different payload",
                  409,
                );
              result = this.publicJob(old);
            } else {
              const expires = Math.min(
                grant.expires,
                Date.now() + integer(body.ttlMs, 1000, 86400000, 3600000),
              );
              this.db
                .prepare(
                  "INSERT INTO jobs VALUES(?,?,?,?,?,?,?,'queued',NULL,?,?)",
                )
                .run(
                  jid,
                  did,
                  who.id,
                  gid,
                  op,
                  JSON.stringify(args),
                  expires,
                  Date.now(),
                  sig,
                );
              this.log(actor, "request:" + op, jid);
              result = this.publicJob(this.job(jid));
              for (const wake of this.waiters) wake();
            }
          } else if (route.startsWith("/requests/") && req.method === "GET") {
            const j = this.job(route.slice(10));
            if (j.operator_id !== who.id)
              throw new Fault("FORBIDDEN", "Forbidden", 403);
            this.grant(j.grant_id, who.id, j.device_id);
            result = this.publicJob(j);
          } else throw new Fault("NOT_FOUND", "Not found", 404);
        } else {
          if (route === "/poll" && req.method === "POST") {
            this.db
              .prepare("UPDATE devices SET last_seen=?,metadata=? WHERE id=?")
              .run(
                Date.now(),
                JSON.stringify(record(body.metadata ?? {})),
                who.id,
              );
            const pending = () =>
              this.db
                .prepare(
                  "SELECT j.* FROM jobs j JOIN grants g ON g.id=j.grant_id JOIN operators o ON o.id=j.operator_id WHERE j.device_id=? AND j.status IN ('queued','delivered') AND j.expires>? AND g.active=1 AND g.expires>? AND o.active=1 ORDER BY j.created LIMIT 1",
                )
                .all(who.id, Date.now(), Date.now()) as any[];
            let jobs = pending();
            if (!jobs.length && this.pollWait > 0)
              await new Promise<void>((resolve) => {
                let done = false;
                const wake = () => {
                  if (done) return;
                  done = true;
                  clearTimeout(timer);
                  this.waiters.delete(wake);
                  resolve();
                };
                const timer = setTimeout(wake, this.pollWait);
                this.waiters.add(wake);
                res.once("close", wake);
              });
            if (
              !this.db
                .prepare("SELECT id FROM devices WHERE id=? AND active=1")
                .get(who.id)
            )
              throw new Fault("DEVICE_REVOKED", "Device revoked", 403);
            jobs = pending();
            for (const j of jobs)
              this.db
                .prepare("UPDATE jobs SET status='delivered' WHERE id=?")
                .run(j.id);
            result = { jobs: jobs.map((j) => this.publicJob(j)) };
          } else if (route === "/authorize" && req.method === "POST") {
            const j = this.job(text(body.requestId, "REQUEST_ID"));
            if (j.device_id !== who.id || j.expires <= Date.now())
              throw new Fault("REQUEST_DENIED", "Request denied", 403);
            this.grant(
              j.grant_id,
              j.operator_id,
              j.device_id,
              required[j.operation as Operation],
            );
            if (
              !this.db
                .prepare("SELECT id FROM operators WHERE id=? AND active=1")
                .get(j.operator_id)
            )
              throw new Fault("OPERATOR_REVOKED", "Operator revoked", 403);
            const start = body.start === true;
            if (start) {
              if (!["queued", "delivered"].includes(j.status))
                throw new Fault("ALREADY_STARTED", "Do not replay", 409);
              this.db
                .prepare("UPDATE jobs SET status='running' WHERE id=?")
                .run(j.id);
              this.log(who.id, "execute:" + j.operation, j.id);
            }
            result = {
              authorized: true,
              expiresAt: j.expires,
              operatorId: j.operator_id,
              grantId: j.grant_id,
            };
          } else if (route === "/results" && req.method === "POST") {
            const j = this.job(text(body.requestId, "REQUEST_ID"));
            if (j.device_id !== who.id)
              throw new Fault("FORBIDDEN", "Forbidden", 403);
            if (!["completed", "failed"].includes(j.status)) {
              if (!["running", "unknown"].includes(j.status))
                throw new Fault("INVALID_STATE");
              const value = record(body.result);
              const encoded = JSON.stringify(value);
              this.db
                .prepare("UPDATE jobs SET status=?,result=? WHERE id=?")
                .run(value.ok === true ? "completed" : "failed", encoded, j.id);
              this.log(
                who.id,
                "result",
                j.id,
                value.ok === true ? "ok" : "failed",
              );
            }
            result = { accepted: true };
          } else throw new Fault("NOT_FOUND", "Not found", 404);
        }
      }
      if (!res.writableEnded)
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify(result));
    } catch (e) {
      const err =
        e instanceof Fault
          ? e
          : new Fault("INTERNAL_ERROR", "Internal error", 500);
      if (actor !== "unauthenticated") {
        try {
          this.log(actor, route, "", err.code);
        } catch {
          /* A full disk must not prevent the failure response. */
        }
      }
      if (!res.writableEnded)
        res
          .writeHead(err.status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          })
          .end(JSON.stringify({ error: err.code, message: err.message }));
    } finally {
      this.active--;
    }
  }
  close() {
    this.closed = true;
    for (const wake of this.waiters)
      wake(); /* The HTTP owner drains requests before dispose(). */
  }
  async drain() {
    const until = Date.now() + 10000;
    while (this.active && Date.now() < until)
      await new Promise((r) => setTimeout(r, 20));
    if (this.active) throw new Error("Requests still draining");
  }
  dispose() {
    this.db.close();
  }
}
export async function listen(
  config: ServerConfig,
  port = 0,
  host = "127.0.0.1",
) {
  const broker = new DiagnosticServer(config);
  const server = http.createServer((req, res) => void broker.handle(req, res));
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.maxConnections = 256;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    broker,
    server,
    url: `http://${host}:${(server.address() as any).port}${PREFIX}`,
    close: async () => {
      broker.close();
      server.closeIdleConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      broker.dispose();
    },
  };
}
