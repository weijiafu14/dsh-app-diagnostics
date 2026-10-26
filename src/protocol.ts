export const PREFIX = "/app-diagnostics/v1";
export type Permission = "inspect" | "files.read" | "database.read" | "debug";
export const permissions: Permission[] = [
  "inspect",
  "files.read",
  "database.read",
  "debug",
];
export type Operation =
  | "snapshot"
  | "file.list"
  | "file.read"
  | "database.query"
  | "debug.attach"
  | "debug.command"
  | "debug.events"
  | "debug.detach";
export const required: Record<Operation, Permission> = {
  snapshot: "inspect",
  "file.list": "files.read",
  "file.read": "files.read",
  "database.query": "database.read",
  "debug.attach": "debug",
  "debug.command": "debug",
  "debug.events": "debug",
  "debug.detach": "debug",
};
export interface Job {
  id: string;
  deviceId: string;
  operatorId: string;
  grantId: string;
  operation: Operation;
  args: Record<string, unknown>;
  expiresAt: number;
  status: string;
  result?: unknown;
}
export interface DeviceConfig {
  appId?: string;
  appVersion?: string;
  serverUrl: string;
  stateDir: string;
  pairingCode?: string;
  permissions: Permission[];
  roots: string[];
  logRoots?: string[];
  pollMs?: number;
  debugIdleMs?: number;
  debugMaxMs?: number;
  cdpTargets?: Record<string, string>;
  allowHttpLoopback?: boolean;
}
export class Fault extends Error {
  constructor(
    public code: string,
    message = code,
    public status = 400,
  ) {
    super(message);
  }
}
export function record(x: unknown): Record<string, any> {
  if (!x || typeof x !== "object" || Array.isArray(x))
    throw new Fault("INVALID_OBJECT");
  return x as Record<string, any>;
}
export function text(x: unknown, key: string, max = 512): string {
  if (typeof x !== "string" || !x.length || x.length > max)
    throw new Fault("INVALID_" + key);
  return x;
}
export function integer(
  x: unknown,
  min: number,
  max: number,
  fallback: number,
) {
  const n = x === undefined ? fallback : Number(x);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Fault("INVALID_NUMBER");
  return n;
}
export function endpoint(value: string, allowHttpLoopback = false) {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !["https:", "http:"].includes(u.protocol)
  )
    throw new Fault("INVALID_SERVER_URL");
  if (
    u.protocol !== "https:" &&
    !(
      allowHttpLoopback &&
      ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname)
    )
  )
    throw new Fault("HTTPS_REQUIRED");
  return value.replace(/\/$/, "");
}
