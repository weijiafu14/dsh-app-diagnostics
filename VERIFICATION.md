# v0.1.0 verification

Local qualification on 2026-10-26: macOS, Node.js 22.22.0.

17 tests pass without skips:

- Real outbound HTTP device registration and evidence collection.
- Per-device/operator grants, scope denial, independent local policy and revocation.
- One-use enrollment and public plaintext HTTP rejection.
- Paginated file reads, symlink escape denial and diagnostic credential exclusion.
- Actual SQLite read-only query, write/extension rejection and hard timeout of a runaway native query in an isolated subprocess.
- Duplicate request ID reuse and conflicting payload rejection.
- Offline command delivery, expiry and broker restart; uncertain execution is not replayed.
- Real Node Inspector evaluation and a real paused child Host resumed by the independent watchdog.
- Active debug grant revocation and cleanup.
- An evaluated promise that never settles reaches its deadline without replaying the side effect.
- Real Chromium page: configured CDP connection, Runtime evaluation, DOM query and detach. No external website was accessed.
- Official Cordis 4.0.5 / WebServer 0.2.1-rc.3 mount, application snapshot and disposal.
- A real MCP stdio client negotiates, lists tools and receives only authorized devices.

The synthetic example also passes after installing the built `.tgz` into a fresh temporary npm project. This checks published worker/subprocess paths as well as package exports.

Source and package scans check for application-specific identifiers, private network/domain references and credential patterns. No customer data or source application assets are used. Tests generate temporary credentials and fixtures.

CI repeats tests on Linux, macOS and Windows with Node 24. Chromium-specific test explicitly skips if no executable is installed. A submitted CI workflow is not itself evidence of a green run; see the repository Actions status.

Not claimed: production customer deployment qualification, packaged Electron installer/update qualification, all dsh version compatibility, or automatic inference of arbitrary business logic.
