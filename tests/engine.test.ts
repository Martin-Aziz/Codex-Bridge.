import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store.js";
import { TaskEngine } from "../src/engine.js";
import { redact, validatePrompt } from "../src/security.js";
import type { AgentRunner, AgentTurn } from "../src/types.js";

class FakeRunner implements AgentRunner {
  calls: { threadId: string | null; prompt: string }[] = [];
  async run({ threadId, prompt, signal }: { workingDirectory: string; threadId: string | null; prompt: string; signal: AbortSignal }): Promise<AgentTurn> {
    this.calls.push({ threadId, prompt });
    const id = threadId ?? "fake-thread-1";
    return {
      getThreadId: () => id,
      events: (async function*() {
        yield { type: "thread.started", thread_id: id };
        yield { type: "turn.started" };
        if (prompt.includes("slow")) {
          await new Promise(resolve => setTimeout(resolve, 80));
          if (signal.aborted) throw new DOMException("cancelled", "AbortError");
        }
        if (prompt.includes("fail")) { yield { type: "turn.failed", error: { message: "Task failed" } }; return; }
        yield { type: "item.completed", item: { type: "agent_message", text: `Finished: ${prompt}` } };
        yield { type: "turn.completed" };
      })()
    };
  }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
  const repo = join(dir, "test-repo");
  execFileSync("mkdir", [repo]);
  execFileSync("git", ["init", "-q", repo]);
  const store = new Store(join(dir, "tasks.sqlite"));
  const runner = new FakeRunner();
  const engine = new TaskEngine(store, runner);
  const project = await engine.registerProject("Test repo", repo);
  const cleanup = async () => { store.close(); await rm(dir, { recursive: true, force: true }); };
  return { dir, repo, store, runner, engine, project, cleanup };
}

test("persists a finished task and resumes its Codex thread after engine restart", async () => {
  const f = await fixture();
  try {
    const first = f.engine.submit(f.project.id, "Inspect this repository", "request-001");
    assert.equal((await f.engine.wait(first.id)).status, "SUCCEEDED");
    assert.equal(f.engine.getTask(first.id).threadId, "fake-thread-1");
    assert.equal(f.engine.events(first.id).length, 6);
    assert.equal(f.engine.submit(f.project.id, "Inspect this repository", "request-001").id, first.id);
    const next = f.engine.continueTask(first.id, "Explain the design", "request-002");
    assert.equal((await f.engine.wait(next.id)).status, "SUCCEEDED");
    assert.equal(f.runner.calls.at(-1)?.threadId, "fake-thread-1");
    assert.match(f.engine.report(next.id).task.result ?? "", /Finished/);
    f.store.close();
    const reopened = new Store(join(f.dir, "tasks.sqlite"));
    assert.equal(reopened.getTask(next.id).threadId, "fake-thread-1");
    reopened.close();
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("rejects conflicting duplicate requests and overlapping tasks", async () => {
  const f = await fixture();
  try {
    const task = f.engine.submit(f.project.id, "slow repository inspection", "request-999");
    assert.throws(() => f.engine.submit(f.project.id, "Different instruction", "request-999"), /Key already used/);
    assert.throws(() => f.engine.submit(f.project.id, "Another inspection"), /already running/);
    assert.equal((await f.engine.wait(task.id)).status, "SUCCEEDED");
  } finally { await f.cleanup(); }
});

test("cancellation is terminal and failed turns do not become successful", async () => {
  const f = await fixture();
  try {
    const slow = f.engine.submit(f.project.id, "slow repository inspection");
    f.engine.cancelTask(slow.id);
    assert.equal((await f.engine.wait(slow.id)).status, "CANCELLED");
    const failed = f.engine.submit(f.project.id, "fail this inspection");
    assert.equal((await f.engine.wait(failed.id)).status, "FAILED");
  } finally { await f.cleanup(); }
});

test("does not register a nested directory, reject invalid prompt and redact secrets", async () => {
  const f = await fixture();
  try {
    assert.rejects(() => f.engine.registerProject("Nested", join(f.repo, ".git")), /Git repository|repository root/);
    assert.throws(() => validatePrompt("no"), /Prompt must/);
    assert.ok(!redact("my key is sk-proj-abcdefghijklmnopqrstuvwxyz").includes("abcdefghijklmnopqrstuvwxyz"));
  } finally { await f.cleanup(); }
});

test("restart marks abandoned active tasks as interrupted", async () => {
  const f = await fixture();
  try {
    const queued = f.store.createTask(f.project.id, "Inspect repository");
    f.store.updateStatus(queued.id, "RUNNING");
    f.store.close();
    const restored = new Store(join(f.dir, "tasks.sqlite"));
    assert.equal(restored.getTask(queued.id).status, "INTERRUPTED");
    restored.close();
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("project reservation is shared across engine instances and recovered after restart", async () => {
  const f = await fixture();
  try {
    const task = f.engine.submit(f.project.id, "slow read-only inspection");
    const secondStore = new Store(join(f.dir, "tasks.sqlite"));
    const secondEngine = new TaskEngine(secondStore, new FakeRunner());
    assert.throws(() => secondEngine.submit(f.project.id, "another read-only inspection"), /already running/);
    await f.engine.wait(task.id);
    secondStore.close();
    assert.equal(f.store.projectBusy(f.project.id), false);
  } finally { await f.cleanup(); }
});

test("stream failure and cancellation persist terminal lifecycle events", async () => {
  const f = await fixture();
  try {
    const cancelled = f.engine.submit(f.project.id, "slow inspection");
    f.engine.cancelTask(cancelled.id);
    assert.equal((await f.engine.wait(cancelled.id)).status, "CANCELLED");
    assert.ok(f.engine.events(cancelled.id).some(e => e.type === "task.cancelled"));
    const failed = f.engine.submit(f.project.id, "fail inspection");
    assert.equal((await f.engine.wait(failed.id)).status, "FAILED");
    assert.ok(f.engine.events(failed.id).some(e => e.type === "task.failed"));
  } finally { await f.cleanup(); }
});

test("persisted database uses private file permissions", async () => {
  const f = await fixture();
  try {
    const { stat } = await import("node:fs/promises");
    assert.equal((await stat(join(f.dir, "tasks.sqlite"))).mode & 0o777, 0o600);
  } finally { await f.cleanup(); }
});
