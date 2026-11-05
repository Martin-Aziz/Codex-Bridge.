import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store.js";
import { TaskEngine } from "../src/engine.js";
import { createBridgeServer, listenLoopback } from "../src/api.js";
import type { AgentRunner } from "../src/types.js";

const neverCallAgent: AgentRunner = { async run() { throw new Error("Agent should not run in this test"); } };

test("loopback API requires bearer token and rejects forged browser origins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-api-"));
  const repo = join(dir, "repository");
  execFileSync("mkdir", [repo]);
  execFileSync("git", ["init", "-q", repo]);
  const store = new Store(join(dir, "test.sqlite"));
  const engine = new TaskEngine(store, neverCallAgent);
  const token = "a".repeat(64);
  const server = createBridgeServer(engine, token);
  try {
    const { port } = await listenLoopback(server, 0);
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/v1/projects`)).status, 401);
    assert.equal((await fetch(`${base}/v1/projects`, { headers: { Authorization: `Bearer ${token}`, Origin: "https://evil.example" } })).status, 403);
    assert.equal((await fetch(`${base}/v1/projects`, { method: "OPTIONS", headers: { Authorization: `Bearer ${token}` } })).status, 405);
    assert.equal((await fetch(`${base}/v1/tasks`, { method: "POST", headers: {
      Authorization: `Bearer ${token}`, "Content-Type": "application/json"
    }, body: "[]" })).status, 400);
    const created = await fetch(`${base}/v1/projects`, { method: "POST", headers: {
      Authorization: `Bearer ${token}`, "Content-Type": "application/json"
    }, body: JSON.stringify({ name: "Demo", path: repo }) });
    assert.equal(created.status, 201);
    const list = await fetch(`${base}/v1/projects`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await list.json() as { projects: Array<{ id: string; name: string }> };
    assert.equal(body.projects[0]?.name, "Demo");
    const dashboard = await fetch(base, { headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.headers.get("x-frame-options"), "DENY");
    assert.match(await dashboard.text(), /Codex Bridge/);
    await writeFile(join(repo, "tracked.txt"), "before\n");
    execFileSync("git", ["-C", repo, "add", "tracked.txt"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "tracked file"]);
    await writeFile(join(repo, "tracked.txt"), "after\n");
    const project = body.projects[0]!;
    const diffResponse = await fetch(`${base}/v1/projects/${project.id}/diff`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(diffResponse.status, 200);
    assert.match((await diffResponse.json() as { diff: string }).diff, /\+after/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
