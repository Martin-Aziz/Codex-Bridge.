# Product roadmap

## Phase 1 — Local Codex task engine (this PR)

- [x] Strict TypeScript project; official Codex SDK adapter
- [x] Register explicit Git repositories and maintain opaque IDs
- [x] SQLite-backed tasks, events, idempotency and thread persistence
- [x] Stream Codex progress, capture completion/failure, support continuation
- [x] Cancel tasks; mark abandoned tasks interrupted after restart
- [x] Loopback bearer-authenticated local HTTP API
- [x] CLI, core tests and setup/security documentation
- [x] Real authenticated Codex start and continuation smoke test against a disposable read-only repository
- [x] Generate and commit a reproducible package-lock.json

## Phase 2 — Local dashboard and inspection (implemented)

- [x] React+Vite projects, task history, event timeline, report views
- [x] Read-only tracked-file diff view and SDK-observed command results
- [ ] Independent test-run evidence and task-scoped diff snapshots
- [ ] Persistent provenance, event retention and pagination
- [ ] Playwright UI tests

## Phase 3 — Remote MCP connectivity

- [ ] Implement MCP with current supported SDK/transport
- [ ] Authenticated, approval-aware access; tool annotation correctness
- [ ] Read-only tools and state-changing tools clearly differentiated
- [ ] Local-to-remote secure tunnel where supported
- [ ] ChatGPT workspace compatibility matrix and integration test

## Phase 4 — Secure work mode

- [ ] Workspace write permissions gated by explicit human approval
- [ ] Isolated worktrees and dirty-tree preservation
- [ ] Approval and rollback test coverage
- [ ] Hardened macOS service lifecycle, signing, and auto-update review
