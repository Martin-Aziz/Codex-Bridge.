# Security model and current limitations

## Implemented for Phase 1

- Default to Codex SDK `sandboxMode: read-only`, `approvalPolicy: never` and network access disabled. No unrestricted command API.
- Operate only on user-registered Git roots. Paths are canonicalized and revalidated before execution. Remote requests identify a project by ID.
- Local HTTP is bound to 127.0.0.1 and requires a random bearer token; Host and Origin checks reduce browser-origin abuse and DNS rebinding exposure.
- Bearer tokens are generated into a private directory (file mode 0600), never printed except on an explicit `token` command.
- Idempotency keys, per-repository execution locks, cancellation and interrupt marking prevent common duplicate/execution-state errors.
- Bounded JSON request size, restricted IDs and input lengths, event allowlisting, best-effort log redaction.

## Important warnings

**A local API token grants control over all registered projects. Treat it as a secret.** Do not forward the local service through ngrok, a public reverse proxy, a VS Code port forward, or a cloud tunnel without redesigning authentication/authorization. The current JSON API is NOT an internet-facing remote MCP server.

**Read-only is a Codex sandbox configuration, not proof of perfect isolation.** Repositories may contain untrusted instructions, malicious build scripts or sensitive files. Only register repositories you trust and use system-level sandboxing where appropriate. Codex may make external model-provider requests for processing repository content. `networkAccessEnabled: false` refers to sandbox network permission, not the Codex model connection.

Do not store secrets in Codex task prompts. SQLite stores original prompts and the last assistant response. Event redaction uses heuristics and is not a DLP guarantee. Protect filesystem access to the local data directory and never automatically transmit reports to untrusted clients.

Task reports summarize observed SDK events. A reported command exit code is not a complete independent test verification. The agent's textual completion statement is not a trusted security review.

## Required before remote access / writing

- OAuth or equivalent trusted identity-based authentication at an MCP endpoint, scoped authorization and audited per-tool permissions.
- CSRF/CORS review, replay protections, rate limits, secure token rotation, TLS, resilient request validation and end-to-end negative tests.
- Interactive approvals; policy-enforced write scopes and git-worktree isolation.
- No arbitrary shell tools in external connectors. No automatic PR merge, push, deployment or destructive actions.
- Observability and incident response procedures for long-running workers.
