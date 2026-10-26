import crypto from "node:crypto";
import { endpoint, type Operation } from "./protocol.js";
export class DiagnosticClient {
  readonly url: string;
  constructor(
    url: string,
    private token: string,
    allowHttpLoopback = false,
  ) {
    this.url = endpoint(url, allowHttpLoopback);
  }
  async api(route: string, body?: unknown) {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(this.url + route, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: "Bearer " + this.token,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        });
        break;
      } catch (error) {
        if (body !== undefined || attempt) throw error;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const data = (await response!.json()) as any;
    if (!response!.ok) throw new Error(data.error ?? "REQUEST_FAILED");
    return data;
  }
  devices() {
    return this.api("/devices");
  }
  request(
    deviceId: string,
    grantId: string,
    operation: Operation,
    args: Record<string, unknown> = {},
    requestId: string = crypto.randomUUID(),
    ttlMs = 3600000,
  ) {
    return this.api("/requests", {
      deviceId,
      grantId,
      operation,
      args,
      requestId,
      ttlMs,
    });
  }
  result(id: string) {
    return this.api("/requests/" + encodeURIComponent(id));
  }
  async wait(id: string, timeoutMs = 30000) {
    const until = Date.now() + timeoutMs;
    while (true) {
      const r = await this.result(id);
      if (
        ["completed", "failed", "expired", "unknown"].includes(r.status) ||
        Date.now() >= until
      )
        return r;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}
