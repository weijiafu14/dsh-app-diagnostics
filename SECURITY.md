# Security model

This is a privileged, self-hosted developer support channel, not a safe public playground.

- Administrators are trusted to pair devices and grant operators permissions. Application/device owners must authorize that deployment and its data handling.
- Device credentials and operator credentials are independent. Pairing codes are random, expire and can be consumed once. Server credential databases store token hashes; local device tokens are owner-only.
- A grant binds one operator to one device, scopes and expiry. The device also enforces its configured scope/roots policy. An admin token is never included in an App package or model tool configuration.
- `debug` is arbitrary Host-process code execution. Do not issue it to untrusted operators. It can bypass file-only restrictions and disclose secrets available to the process. Inspector readOnly/throwOnSideEffect is not a sandbox.
- File-only access follows canonical paths and refuses escaped symlinks and non-regular files. Diagnostic credential/journal state is excluded. This is not a sandbox against a malicious local user concurrently replacing filesystem ancestors; the device OS and configured root owners are trusted.
- SQLite is opened read-only with query_only and trusted_schema disabled, extensions are not enabled, rows are bounded and an isolated subprocess is killed after two seconds.
- HTTPS is required except explicitly enabled loopback development. TLS should terminate at a trusted reverse proxy or the official WebServer. The server can read collected data; there is no claim of end-to-end encryption from it.
- Request IDs deduplicate delivery. Started commands whose outcome cannot be proved are not rerun automatically. Side effects are not promised exactly once.
- Debug events are bounded and report gaps. Idle/absolute expiry, revocation or failed authorization checks clean up Inspector sessions. In-flight actions cannot be recalled. A crashed OS/process cannot be restored by this plugin.
- Local audit records exclude command arguments, credentials and result payloads. Evidence results can contain arbitrary sensitive application data; restrict the state directory, set retention and encrypt the storage volume where needed.
- Do not expose the standalone HTTP listener to the internet. Apply reverse-proxy request/concurrency limits and administrative network access policy. Audit data is not tamper-proof against administrators.

Report vulnerabilities privately through the repository's Security Advisories. Do not post credentials, customer data or raw diagnostic bundles in public issues.
