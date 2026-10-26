import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DiagnosticClient } from "./client.js";
export async function runMcp(client: DiagnosticClient) {
  const s = new McpServer({ name: "dsh-app-diagnostics", version: "0.1.0" });
  const result = (v: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(v) }],
  });
  s.registerTool(
    "diagnostics_devices",
    {
      description:
        "List devices authorized for this operator. Offline is not zero activity.",
    },
    async () => result(await client.devices()),
  );
  s.registerTool(
    "diagnostics_request",
    {
      description:
        "Submit one authorized collection/debug request. Reuse requestId after uncertainty. Debug may execute code and interrupt the target.",
      inputSchema: {
        deviceId: z.string(),
        grantId: z.string(),
        requestId: z.string(),
        operation: z.enum([
          "snapshot",
          "file.list",
          "file.read",
          "database.query",
          "debug.attach",
          "debug.command",
          "debug.events",
          "debug.detach",
        ]),
        args: z.record(z.string(), z.unknown()).optional(),
        ttlMs: z.number().int().min(1000).max(86400000).optional(),
      },
    },
    async (x) =>
      result(
        await client.request(
          x.deviceId,
          x.grantId,
          x.operation,
          x.args ?? {},
          x.requestId,
          x.ttlMs,
        ),
      ),
  );
  s.registerTool(
    "diagnostics_result",
    {
      description:
        "Read request status/result; unknown means execution may have happened and must not be repeated.",
      inputSchema: { requestId: z.string() },
    },
    async (x) => result(await client.result(x.requestId)),
  );
  await s.connect(new StdioServerTransport());
  return s;
}
