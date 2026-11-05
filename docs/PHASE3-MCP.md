# Phase 3: authenticated MCP

Codex Bridge exposes a separate MCP Streamable HTTP endpoint at `/mcp`. It runs on `127.0.0.1` and is intended to be reached through OpenAI Secure MCP Tunnel. It does not expose the dashboard/JSON API and does not accept paths, shell commands, or arbitrary project locations. Register repositories locally first; MCP callers use opaque project IDs. Codex remains read-only.

## Tools and permissions

| Tool | Required scope | Purpose |
| --- | --- | --- |
| `list_projects` | `projects:read` | List registered names and opaque IDs |
| `get_task_status` | `tasks:read` | Poll an asynchronous task |
| `get_task_events` | `tasks:read` | Read a bounded page of redacted events |
| `get_task_report` | `tasks:read` | Read a bounded, redacted report |
| `start_task` | `tasks:start` | Start read-only work for a registered project ID |
| `continue_task` | `tasks:continue` | Continue a completed session |
| `cancel_task` | `tasks:cancel` | Request cancellation |

Every HTTP request requires a bearer JWT. Every tool call checks token expiry, resource audience and its explicit scope again. Tokens must have `sub`, `exp`, `client_id` or `azp`, and a space-delimited `scope` (or string array `scp`) claim. The configured issuer must issue signed RS256 or ES256 JWTs and publish a JWKS. Rate limits are persisted in SQLite: 120 reads/minute/principal and 20 calls/minute for each task-changing tool. Audit rows record a pseudonymous principal, tool, result and task ID; prompts, tokens, reports and repository paths are not written to the MCP audit table. Tool request and result sizes are bounded and user-visible task text is redacted.

This deployment is intentionally single-operator: `MCP_ALLOWED_SUBJECTS` must contain the exact allowlisted OAuth `sub` identifiers. All registered repositories are visible to each allowlisted subject. Do not issue these scopes to other users or reuse this instance as a multi-user service; project-level ACLs are not implemented.

The OAuth provider must issue the scopes above and put the requested resource identifier in `aud`. The tunnel rewrites protected-resource metadata and `WWW-Authenticate` metadata URLs to tunnel-service URLs. Configure separate values: `MCP_OAUTH_RESOURCE` is the local resource identifier returned by the loopback server (for example `http://127.0.0.1:49442/mcp`); `MCP_OAUTH_AUDIENCE` is the exact tunnel-facing resource identifier that the OAuth authorization flow returns in JWT `aud`. Confirm the latter from the tunnel's rewritten PRMD and the provider's issued token claims using a safe local diagnostic; never print the token. `MCP_OAUTH_ISSUER` must match the JWT `iss`; `MCP_OAUTH_JWKS_URL` must return that issuer's current public signing keys. The local process accepts HTTP only on loopback; the remote tunnel is the only supported ingress. MCP bearer JWTs and the local dashboard `CODEX_BRIDGE_TOKEN` are separate credentials.

## macOS local setup

1. Install Node 22.13+ and Git. From a clean checkout run:

   ```sh
   npm ci
   npm run build
   npm test
   ```

2. Register each repository from the local CLI (paths are accepted only in this local administrative command):

   ```sh
   npm run bridge -- register /absolute/path/to/repository "Repository name"
   npm run bridge -- projects
   ```

3. Configure an established OAuth provider. This guide selects Auth0's current **Auth for MCP** product because its current documentation supports MCP resource identifiers and client ID metadata registration. Create/configure an Auth0 tenant and API for the exact tunnel-facing audience; use RS256, the five MCP scopes in the table, and delegated-user access. Enable its MCP resource-parameter compatibility setting. Configure authorization-code + PKCE (`S256`), the ChatGPT client registration mode offered for this connector (CIMD or DCR), and refresh-token issuance (`offline_access` or provider equivalent). Ensure provider discovery advertises refresh scope support. Allow only the intended user subjects, then set their exact Auth0 `sub` values below. These tenant settings require an Auth0 account and are not present on this Mac.

   Configure the following in a protected shell or process manager. Do not commit credentials:

   ```sh
   export MCP_OAUTH_ISSUER='https://YOUR-ISSUER'
   export MCP_OAUTH_JWKS_URL='https://YOUR-ISSUER/.well-known/jwks.json'
   export MCP_OAUTH_RESOURCE='http://127.0.0.1:49442/mcp'
   export MCP_OAUTH_AUDIENCE='https://EXACT-TUNNEL-RESOURCE-FROM-PRMD'
   export MCP_ALLOWED_SUBJECTS='EXACT_AUTH0_SUB'
   npm run bridge -- mcp-serve 49442
   ```

   The process listens only on `http://127.0.0.1:49442/mcp`. Confirm both `/.well-known/oauth-protected-resource/mcp` (path-aware RFC 9728) and the root fallback `/.well-known/oauth-protected-resource` return the local resource, issuer, and declared scopes. Anonymous POST to `/mcp` returns 401 with `WWW-Authenticate` pointing at the path-aware metadata. Keep the process terminal open while using the tunnel. `Ctrl-C` sends a graceful shutdown, aborts active tasks, and closes SQLite.

## OpenAI Secure MCP Tunnel

Secure MCP Tunnel needs Platform Tunnels Read and Use access, a tunnel ID, and a **runtime** `CONTROL_PLANE_API_KEY`. The runtime key is not `OPENAI_ADMIN_KEY` and is not a client credential for this server. Associate the Platform organization and ChatGPT workspace using the OpenAI tunnel setup. Install the supported macOS binary with the official Homebrew tap:

```sh
brew install openai/tools/tunnel-client
tunnel-client profiles samples list
tunnel-client help quickstart
```

Use the current HTTP MCP binding and a provisioned tunnel ID. Materialize the official OAuth/DCR profile; it stores the local MCP URL and an environment-variable reference for the runtime key, never the key itself:

```sh
tunnel-client help quickstart
tunnel-client init --sample sample_mcp_with_dcr --profile codex-bridge --tunnel-id 'YOUR_TUNNEL_ID' --mcp-server-url 'http://127.0.0.1:49442/mcp'
tunnel-client doctor --profile codex-bridge --explain
read -rs 'CONTROL_PLANE_API_KEY?Runtime API key: '
echo
export CONTROL_PLANE_API_KEY
tunnel-client run --profile codex-bridge
```

The `read` command prompts without echoing the key and avoids placing it in shell history. Clear it from the environment when the tunnel exits with `unset CONTROL_PLANE_API_KEY`.

`CONTROL_PLANE_TUNNEL_ID` is also accepted as an environment setting by the runtime, but a generated profile is the documented repeatable setup. The local HTTP request target is the configured MCP URL (`127.0.0.1:<port>`), which is the authority accepted by the bridge's loopback Host guard. This matches the tunnel client's documented HTTP target behavior; the Host forwarding still needs an end-to-end check after the organization's tunnel and runtime key are provisioned. Arbitrary and forwarded Host values are not trusted. Verify the local protected-resource metadata and 401 challenge before connecting.

The client initiates outbound TLS to OpenAI; it does not require a public listener or router port-forward. Keep the local `mcp-serve` process running. On failure, check `tunnel-client doctor`, verify tunnel ID/runtime key/Platform permissions, verify the local loopback endpoint, issuer metadata and token audience, then restart the profile. Stop with `Ctrl-C` in both terminal sessions. Avoid downloading an unsigned release binary and bypassing macOS Gatekeeper; the official project documents the Homebrew install path.

The tunnel itself does not authenticate application users. The MCP resource server must validate every JWT. The current implementation uses an external issuer/JWKS and validates its signature, issuer, audience and expiry. Protected-resource metadata is served locally at `/.well-known/oauth-protected-resource`; ensure the OAuth issuer's discovery and authorization endpoints are reachable to the MCP client, or configure an issuer integration supported by the current ChatGPT connector. A private tunnel does not make an unreachable authorization server reachable.

## ChatGPT connection and exact workflow

In ChatGPT web, open **Plugins → + → Add custom MCP server**, select **Tunnel**, choose or enter the tunnel ID, configure OAuth, acknowledge the risk warning, choose **Create as a plugin**, review discovered tools, and install the plugin. The current custom-server flow does not require Developer Mode. Business and Enterprise/Edu support full MCP; Enterprise/Edu admins control creation/publishing through RBAC. Then use `@` in a chat to select the installed plugin and provide an instruction such as:

> Use Codex Bridge to inspect the repository named “Repository name”. First list registered repositories, then start a read-only task to summarize its test structure. Return the task ID, poll until it finishes, inspect its events, and retrieve the report.

The model receives a task ID immediately; it should poll `get_task_status`, use `get_task_events` as useful, and call `get_task_report` at completion. For continuation, request `continue_task` with the prior task ID and a new instruction, then poll and retrieve that report. Cancellation uses `cancel_task` with the active task ID.

OpenAI's current help page says full custom MCP is available on Business and Enterprise/Edu web workspaces. Workspace admins may restrict custom connectors and write actions. Starting or continuing a Codex job is an MCP write action even though Codex repository access is read-only. OAuth discovery and authorization must work end-to-end: ChatGPT uses code + PKCE, and refresh access requires `offline_access` (or the provider equivalent) advertised and issued by the provider. The official `tunnel-client` binary is installed on this Mac and its quickstart/profile commands were inspected. No tunnel ID/runtime key, OAuth issuer configuration, OpenAI API key, or Auth0 tenant values are configured, so no remote call or ChatGPT connector was verified.

## Local test and verification commands

```sh
npm run test:mcp       # MCP client lifecycle, mock runner and negative security tests
npm run test:mcp:real  # real Codex start+continue (requires `codex login status` to succeed)
npm test               # all Node tests and Playwright smoke tests
npm audit --audit-level=moderate
```

The real test uses a temporary Git repository and removes it after confirming `git status --porcelain` stays empty. A local test issuer signs short-lived RS256 JWTs for the MCP end-to-end test. The remote tunnel/API/actual ChatGPT connection must be validated in the target organization using its own OAuth issuer and entitlements.

## Credential lifecycle, shutdown and recovery

- **Startup:** start `mcp-serve` with the OAuth settings and allowlisted subject IDs; confirm loopback-only bind, path-aware metadata, and anonymous 401 challenge. Start `tunnel-client` with its runtime key supplied through a hidden prompt or a protected process manager. Confirm the tunnel is healthy before installing its connector in ChatGPT.
- **Shutdown:** send `Ctrl-C` to `tunnel-client`, then `Ctrl-C` to `mcp-serve`. MCP shutdown aborts active Codex jobs and closes SQLite. Verify the processes exited; do not terminate only one while assuming the other is still serving.
- **Runtime key rotation/revocation:** issue a replacement tunnel runtime key in the authorized OpenAI Platform organization, stop the client, replace the key in the protected environment, and restart. Revoke the old key immediately in Platform. To revoke access, remove the connector/user authorization in ChatGPT and revoke the OAuth provider's user grants/refresh tokens; remove that user's `sub` from `MCP_ALLOWED_SUBJECTS` and restart the bridge. For suspected compromise, stop the tunnel first, revoke both credential sets, then rotate and reconnect.
- **OAuth signing key rotation:** publish the new key in issuer JWKS before signing with it; keep the prior public key available through the maximum token lifetime, then remove it. The verifier uses remote JWKS and honors key IDs. Rotate issuer client/API secrets only in the provider's protected console and never place them in this repository.
- **Failure recovery:** run `tunnel-client doctor`; verify tunnel ID, runtime key entitlements, local loopback endpoint, issuer discovery/JWKS, audience and required scopes. Tasks survive process restart in SQLite. An interrupted active task is marked `INTERRUPTED`; inspect its events/report and confirm the project is idle before starting a new task or continuing a completed session. Restart the MCP process and tunnel after correcting configuration. Never expose `src/api.ts` through the tunnel or a reverse proxy.

## Current upstream references

- [MCP TypeScript SDK v2](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP SDK authorization](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/authorization.md)
- [MCP SDK HTTP serving](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md)
- [OpenAI Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [OpenAI custom MCP server guide](https://developers.openai.com/api/docs/guides/custom-mcp-server)
- [OpenAI MCP with Responses API](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
- [ChatGPT custom MCP plan availability](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
- [OpenAI tunnel-client onboarding](https://github.com/openai/tunnel-client/blob/master/docs/onboarding.md)
- [OpenAI tunnel-client configuration](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md)
- [OpenAI tunnel-client architecture](https://github.com/openai/tunnel-client/blob/master/docs/architecture.md)
- [OpenAI ChatGPT custom MCP setup](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
- [Auth0 Auth for MCP](https://auth0.com/blog/auth0-auth-for-mcp-servers-generally-available/)
- [MCP authorization and protected-resource metadata](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/authorization/authorization.mdx)
- [RFC 9728 OAuth protected-resource metadata](https://www.rfc-editor.org/rfc/rfc9728.html)
