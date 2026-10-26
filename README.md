# dsh-app-diagnostics

[中文](README.zh-CN.md) · MIT · Node.js 22.13+ (Node 24 recommended)

An installable **DeepSeek Harness (dsh) application plugin**, companion diagnostic service and MCP/CLI tools. A developer can request evidence from a deployed application, including one that is temporarily offline, and establish a separately authorized Node Inspector session.

This is not an official DeepSeek product. It does not add a business task model, collect every variable automatically, or claim that tool completion proves a business outcome.

## What ships

- **Device plugin**: outbound HTTPS polling, durable command receipts, file/log discovery and paginated reads, read-only SQLite queries, runtime snapshots, and Inspector debugging.
- **Server plugin**: mounts `/app-diagnostics/v1` on the official `@deepseek-ai/dsh-host-webserver`. Can share the application's existing server without replacing its routes. A standalone CLI carrier is also provided.
- **Developer client**: typed SDK, CLI and standard MCP stdio tools.
- **Authorization**: one-use pairing, independent device/operator credentials, per-device expiring grants, local permission/root policy, revocation and payload-free audit entries.

Files and SQL are not restricted to a predeclared list of collectors. Paths are checked against the **deployment's configured roots**. Optional snapshots provide convenience, not the only way to inspect an application. `debug` is explicitly high privilege: arbitrary JavaScript can read or modify anything the Host process can access, independent of file-read roots.

## Quick validation from source

```sh
npm ci
npm test
node examples/demo.mjs
```

The demo creates temporary credentials, a real HTTP broker and a real Cordis application, requests a snapshot and log, evaluates an expression through Node Inspector, detaches and cleans up. It never contacts an external service.

## Install into dsh

Install the built release directly (contains JavaScript and the device workers):

```sh
dsh plugin --profile YOUR_PROFILE add https://github.com/weijiafu14/dsh-app-diagnostics/releases/download/v0.1.0/dsh-app-diagnostics-0.1.0.tgz
```

Or build and pack the source:

```sh
npm ci
npm pack
# In your dsh environment:
dsh plugin --profile YOUR_PROFILE add /absolute/path/dsh-app-diagnostics-0.1.0.tgz
```

The bundle is initially disabled because an application owner must configure the server, credential provisioning and permissions. This is deployment setup, not a confirmation required for every diagnostic request. Target end users do not need to run the developer CLI when the application deployer provisions their configuration.

Configure the inserted `app-diagnostics` row, then enable it:

```yaml
- id: app-diagnostics
  name: dsh-app-diagnostics
  disabled: false
  config:
    appId: example-app
    appVersion: 1.0.0
    serverUrl: https://diagnostics.example.com/app-diagnostics/v1
    stateDir: /absolute/private/diagnostic-device
    pairingCode: ONE_TIME_DEPLOYMENT_CODE
    permissions: [inspect, files.read, database.read, debug]
    roots: [/absolute/app-data, /absolute/workspace]
    logRoots: [/absolute/dsh-home/logs, /absolute/dsh-home/sessions]
```

Replace the pairing placeholder during secure provisioning; never commit a real code. A consumed pairing code is not needed after `device.json` has been written. Pin one server origin per device state directory. A server change requires explicit new provisioning. Permissions listed above deliberately show all capabilities; deployments can omit capabilities they do not authorize. The plugin does not choose a consent policy or silently grant access.

Tested integration: `@deepseek-ai/cordis` **4.0.5** and `@deepseek-ai/dsh-host-webserver` **0.2.1-rc.3**. The latter is an upstream `next` version; npm's `latest` tag for individual dsh packages is not necessarily the current Harness version. Older dsh profiles must be tested before use.

## Start the service

```sh
node dist/cli.js init --dir .state
node dist/cli.js server --dir .state --token-file .state/admin.token --port 19740
```

This standalone example binds loopback. Put it behind your own HTTPS reverse proxy; do not expose plaintext HTTP. `allowHttpLoopback: true` is an explicit development-only exception in device/client configuration.

To use the official dsh WebServer instead, mount `dsh-app-diagnostics/server` in the server profile with `directory` and `adminTokenFile`. The server plugin injects `webServer`; the standalone carrier is **not** required in this mode.

The service uses SQLite WAL for request/grant state and results. Successful results are bounded to 4 MiB. Larger files use paginated reads, with offset, total size, modification time and a per-chunk SHA-256. Callers must detect a file changing between reads; a live file is not an atomic database backup. Jobs and audit records expire after seven days by default (`retentionDays`). Do not configure the state directory on an ephemeral or full filesystem.

## Provision and grant access

Use `DiagnosticClient.api()` or `dsh-diagnostics api --url URL --token-file FILE --path ROUTE --data-file JSON --out PRIVATE_OUTPUT`:

1. Admin `POST /operators {label}` → `operatorId, token`.
2. Admin `POST /enrollments {label, ttlMs?}` → `deviceId, pairingCode, expiresAt`.
3. Provision the device plugin with that one-use code. It registers without opening an inbound port.
4. Admin `POST /grants {operatorId, deviceId, permissions, ttlMs}` → `grantId`. Maximum grant lifetime: 24 hours. Deployment/user authorization must precede issuing a grant.
5. The operator uses its own token (never the admin token) to request diagnostics.
6. Admin `POST /revoke {type: "grant" | "operator" | "device", id}` revokes access.

Credential values are returned only on creation. `--out` creates a new owner-only file and refuses overwriting it. Do not put tokens in command-line arguments, logs or model prompts. Server audit entries include actor, operation, request identifier and outcome, not collected content or tokens.

## Operations

| Operation        | Grant           | Arguments / behavior                                                                                            |
| ---------------- | --------------- | --------------------------------------------------------------------------------------------------------------- |
| `snapshot`       | `inspect`       | Runtime, app version and optional app/official-inspector snapshot                                               |
| `file.list`      | `files.read`    | `path`, optional `offset`, `limit`; paginated file names                                                        |
| `file.read`      | `files.read`    | `path`, optional `offset`, `limit`; base64 bytes, maximum 1 MiB per read                                        |
| `database.query` | `database.read` | `path`, `sql`, optional `params`, `limit`; SQLite read-only, maximum 1,000 rows, two-second subprocess deadline |
| `debug.attach`   | `debug`         | Creates a session after the optional application safe-point hook                                                |
| `debug.command`  | `debug`         | `sessionId`, `method`, `params`, optional `readOnly`; Runtime/Debugger/Profiler commands                        |
| `debug.events`   | `debug`         | `sessionId`, optional `after`; bounded events with truncation indicator; also refreshes idle deadline           |
| `debug.detach`   | `debug`         | `sessionId`; removes owned breakpoints, resumes debugger, disconnects and calls finish hook                     |

`Runtime.evaluate` accepts arbitrary expressions under a **debug** grant. `readOnly: true` requests Inspector's `throwOnSideEffect`; it is not an independent security sandbox. For dsh Hosts, the context expression is `globalThis[Symbol.for("dsh.appDiagnostics.context")]`.

Every submitted request needs a stable `requestId`. Repeat that **same identifier and payload** to recover status; conflicting reuse fails. Completed results are not re-executed. A crash after execution started is reported as `unknown`/`EXECUTION_OUTCOME_UNKNOWN`, never blindly replayed. This is not an exactly-once side-effect guarantee.

## AI integration

```sh
node dist/cli.js mcp --url https://diagnostics.example.com/app-diagnostics/v1 --token-file /private/operator.json
```

Tools: `diagnostics_devices`, `diagnostics_request`, `diagnostics_result`. No admin/enrollment/grant-management tool is exposed to the model. Evidence returned by an application is untrusted data, not instructions.

CLI equivalents: `devices`, `request --device ID --grant ID --operation snapshot --id UNIQUE_ID`, and `result --id UNIQUE_ID --wait 10000`. Use `--args-file` for file/SQL/Inspector arguments.

## Optional application integration

```ts
ctx.appDiagnostics.registerSnapshot("health", () => myService.status());
ctx.appDiagnostics.registerDebugLifecycle({
  prepareDebug: async () => myService.pauseAtSafePoint(),
  finishDebug: async (ticket) => myService.resumeIfStillOwned(ticket),
});
```

Register the returned disposers with the owning plugin's Cordis effect. No task/queue abstraction is imposed. Without hooks, debugger pause/resume affects the JavaScript process only; the plugin does not pretend it has safely paused or restored application business work. An app hook must preserve a user's intervening stop. Failed finish hooks are reported, not a promise that business recovery succeeded.

Official Session logs are read from the configured log/session paths; their existing format, compression and retention are preserved. When the official Inspector service is mounted, `snapshot` uses its public `cordis.getTree()` API. Active Host debugging uses Node's standard Inspector from a dedicated Worker. This release does **not** mount the official developer UI or proxy its CDP endpoint.

## Scope and limitations

- Node Host debugging and deployment-configured CDP targets are implemented. Set `cdpTargets: { renderer: "ws://127.0.0.1:PORT/devtools/page/ID" }` and attach with `{ "target": "renderer" }`. The App owns discovering and refreshing endpoint URLs. This plugin never launches a browser or exposes its debug port. Request arguments cannot supply arbitrary endpoint URLs. Host allows Runtime/Debugger/Profiler; configured CDP targets additionally allow DOM/Page/Network/Input. Raw CDP is high privilege.
- No all-variable recording, automatic business-reason inference, or retroactive recovery of missing logs.
- HTTPS protects transport; the self-hosted server can read evidence. This is not end-to-end encryption against the server operator.
- The standalone server has no public TLS termination, SSO or multi-tenant administration UI; deploy behind HTTPS with endpoint limits. Audit entries are local, not tamper-proof.
- Debug sessions default to a 30-second idle timeout and five-minute maximum; expiry, revocation and transport loss trigger cleanup from the Worker even while the Host is paused.
- No updater is included. The route plugin can coexist with an existing update server; ordinary feeds and update policy remain owned by that service.
- Tests exercise real Node processes, real HTTP, real SQLite, real Inspector breakpoints and official Cordis/WebServer. No claim of packaged Electron or third-party production application qualification.

See [SECURITY.md](SECURITY.md) for the trust model. Contributions should keep examples synthetic and application-neutral.

See [VERIFICATION.md](VERIFICATION.md) for the exact tested scope.
