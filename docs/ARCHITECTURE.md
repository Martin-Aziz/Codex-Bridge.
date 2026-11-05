# Architecture and decisions — 2026-11-05

## Intended end state

ChatGPT (eligible custom MCP tools) → authenticated remote MCP proxy/tunnel → local Codex Bridge → official Codex SDK → approved local Git repository → durable report. A standalone local dashboard provides the same interaction independently of the ChatGPT plan.

## Phase 1 implemented

- `src/cli.ts`: local administrative CLI and service lifecycle. Only the CLI, not remote code, chooses a filesystem project path.
- `src/api.ts`: JSON HTTP interface bound to `127.0.0.1`, authenticated with an opaque bearer token, no permissive CORS, 64KB request cap.
- `src/engine.ts`: project-scoped task reservation, lifecycle management, cancellation, continuation, idempotency and basic evidence reports.
- `src/store.ts`: synchronous SQLite data store, restart reconciliation, event timeline.
- `src/codex.ts`: Codex SDK adapter: `startThread` / `resumeThread`, `runStreamed`, read-only sandbox, network disabled, no approvals.
- `src/security.ts`: git-root validation, input constraints, event field allowlist and best-effort secret redaction.

The SQLite backing store uses the built-in `node:sqlite` module (Node 22.13+). This keeps the local foundation small; production release should pin/test a specific supported Node version and generate a lockfile.

The official TypeScript Codex SDK uses a child CLI process and structured JSONL events; it persists sessions in the Codex home directory. Session IDs are stored in our own SQLite DB. `turn.completed` must be observed before success is recorded.

## Contracts

- Project registration yields an opaque ID and validated git-root path.
- A new task receives a project ID, a prompt, and optional idempotency key. Task ID is 32 lowercase hex chars.
- Continuation requests refer to a completed/failed/interrupted task with a stored Codex thread ID.
- Each task is a single turn; later turns are separate linked tasks, sharing the Codex session ID.
- SDK events are summarized rather than copied verbatim; output and error text are size-limited and redacted on a best-effort basis.
- `GET /v1/tasks/:id/report` is not independent test verification; it states that limitation explicitly.

## Deferred architecture choices

A future remote MCP server must not expose `POST /v1/projects` nor arbitrary file paths. Keep local registration administrative. For writable tasks, use isolated Git worktrees, per-task approval gates, branch protection and strict consequences review. A secure tunnel is not by itself sufficient authentication; require user identity and tool authorization.
