# Codex Bridge — Phase 1

A private, **local-first bridge** for supervising an OpenAI Codex coding session and retrieving structured task reports. Built for Node.js on macOS. **Phase 1 is read-only**: no remote project writes, Git pushes, deployments or arbitrary shell endpoint.

> **Implementation status:** CLI + local JSON API + SQLite task engine are implemented and mock-tested. The official Codex SDK adapter is implemented but a real authenticated Mac/Codex smoke test has **not** been executed. MCP integration and the web dashboard are **not in Phase 1**; do not claim ChatGPT web can control Codex yet.

## Prerequisites

- macOS or another Unix system with Node.js **22.13+**, npm, Git
- Codex authentication (via installed Codex CLI / the current SDK-supported mechanism)
- An existing **local** Git repository you explicitly choose to register

The Codex SDK delegates to the Codex CLI. The upstream package currently expects the CLI package to be installed; both are dependencies. Official SDK: https://github.com/openai/codex/tree/main/sdk/typescript

## Start locally

```bash
# Clone the actual repository name (including its trailing period):
git clone 'https://github.com/Martin-Aziz/Codex-Bridge..git'
cd 'Codex-Bridge.'
npm install
npm run build
npm test

# Register one local repo, then copy the returned project id:
npm run bridge -- register "$HOME/Developer/Arash_Kamangir" "Arash Kamangir"
npm run bridge -- projects

# Execute a real read-only Codex task (Codex authentication required):
npm run bridge -- start <projectId> "Inspect this repository and report its architecture and test risks"
npm run bridge -- tasks
npm run bridge -- report <taskId>

# Continue the same persisted Codex thread in a new task:
npm run bridge -- continue <taskId> "Explain the highest priority risk in more detail"
```

The first live run requires working Codex auth and network access to the model provider. To use Codex from the terminal, follow its official CLI sign-in instructions. Never commit credentials. The `--` in `npm run bridge --` forwards the remaining arguments to the CLI.

## Local API (for future MCP adapter)

```bash
npm run bridge -- serve           # loopback interface only: 127.0.0.1:49441
npm run bridge -- token           # explicitly display the local bearer token
```

Use the token locally (never paste it into a chat or commit it to a repository):

```bash
export CODEX_BRIDGE_TOKEN="$(npm run --silent bridge -- token)"
curl -H "Authorization: Bearer $CODEX_BRIDGE_TOKEN" \
  http://127.0.0.1:49441/v1/projects
```

API endpoints:

| Method | Path | Description |
|---|---|---|
| GET | `/v1/projects` | Registered projects |
| POST | `/v1/projects` | Register a local git-root; local administrative use only |
| GET | `/v1/tasks` | Last 100 task records |
| POST | `/v1/tasks` | Start a read-only Codex task (`projectId`, `prompt`, optional `key`) |
| GET | `/v1/tasks/:id` | Task status |
| GET | `/v1/tasks/:id/events?after=N` | Paginated sanitized events |
| GET | `/v1/tasks/:id/report` | Agent report and observed events |
| POST | `/v1/tasks/:id/continue` | Continue source Codex thread with `prompt` |
| POST | `/v1/tasks/:id/cancel` | Request cancellation |

`POST /v1/tasks` returns **202 Accepted** with task metadata; poll `GET /v1/tasks/:id` until terminal. Request bodies are JSON up to 64KB. All endpoints require bearer auth, strict Host/Origin validation, and are bound to loopback only. No wildcard CORS. These are **local control APIs**, not public remote endpoints.

## Persistence and recovery

Tasks, project registrations and sanitized SDK event summaries are stored in SQLite:

- macOS: `~/Library/Application Support/CodexBridge/bridge.sqlite`
- Other systems: `~/.local/share/codex-bridge/bridge.sqlite`

A separate `access-token` file is generated in that directory with restricted permissions. Override with `CODEX_BRIDGE_DATA_DIR` for tests.

If the bridge restarts during an active task, the previous task becomes `INTERRUPTED`, not `SUCCEEDED`. If its Codex thread ID was saved, use `continue` after confirming what the previous session may have changed. Old task events remain inspectable.

Per-project execution locks prevent simultaneous Codex turns in one registered repository. Repeated requests can use idempotency keys. Interrupted tasks are never silently retried.

## Limitations and planned phases

- **Phase 1 delivered:** registered Git roots, read-only Codex SDK adapter, SQLite state, streamed progress summaries, continuation, cancellation, local CLI/API, tests and documentation.
- **Phase 2:** rich dashboard, diff/test visualization, robust independent verification, UI/E2E coverage.
- **Phase 3:** authenticated MCP interface and supported ChatGPT integration, with strict read-only/write tool annotations.
- **Phase 4:** explicit-approval workspace-write tasks, isolated worktrees, secure deployment workflow and service hardening.

The word *bridge* does not mean an existing ChatGPT browser session can call the local daemon today. That requires Phase 3 plus an eligible ChatGPT environment and a secure remote MCP connection. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/SECURITY.md](docs/SECURITY.md).

## Tests

`npm test` builds TypeScript and runs the Node test runner against mock Codex sessions. It tests idempotency, cancellation, thread resume, restart recovery, path validation, bearer-token enforcement, and browser origin rejection. A real Codex session is intentionally **not part of automated CI** because it needs authenticated credentials and can incur usage costs.

## License

MIT for project source code. The name and official Codex SDK belong to their respective owners; this is an independent project, not an official OpenAI product.
