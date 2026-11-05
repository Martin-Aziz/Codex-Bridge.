import { Store } from "./store.js";
import { BridgeError, redact, summarizeEvent, validateId, validateProjectPath, validatePrompt } from "./security.js";
import type { AgentRunner, Project, Task, StoredEvent } from "./types.js";

export class TaskEngine {
  private readonly active = new Map<string, { taskId: string; abort: AbortController; work: Promise<void> }>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(public readonly store: Store, private readonly agent: AgentRunner) {}

  async registerProject(name: string, path: string): Promise<Project> {
    if (typeof name !== "string" || name.trim().length < 2 || name.length > 100)
      throw new BridgeError("INVALID_NAME", "Project name must be 2–100 characters");
    return this.store.addProject(name.trim(), await validateProjectPath(path));
  }

  listProjects(): Project[] { return this.store.listProjects(); }
  listTasks(): Task[] { return this.store.listTasks(); }
  getTask(id: string): Task { return this.store.getTask(validateId(id)); }
  events(id: string, after = 0): StoredEvent[] {
    if (!Number.isInteger(after) || after < 0) throw new BridgeError("INVALID_CURSOR", "Invalid event cursor");
    return this.store.events(validateId(id), after);
  }

  submit(projectId: string, prompt: string, key: string | null = null): Task {
    const project = this.store.getProject(validateId(projectId));
    const instruction = validatePrompt(prompt);
    const existing = key ? this.store.findByKey(key) : undefined;
    if (existing) {
      if (existing.projectId !== project.id || existing.prompt !== instruction || existing.parentTaskId !== null)
        throw new BridgeError("IDEMPOTENCY_CONFLICT", "Key already used for different task");
      return existing;
    }
    this.requireIdle(project.id);
    const task = this.store.createTask(project.id, instruction, this.validateKey(key));
    this.schedule(task);
    return task;
  }

  continueTask(sourceTaskId: string, prompt: string, key: string | null = null): Task {
    const previous = this.getTask(sourceTaskId);
    const instruction = validatePrompt(prompt);
    if (!previous.threadId) throw new BridgeError("NO_THREAD", "Source task has no resumable Codex thread");
    if (!["SUCCEEDED", "FAILED", "INTERRUPTED"].includes(previous.status))
      throw new BridgeError("NOT_FINISHED", "Cannot continue an active or cancelled task");
    const existing = key ? this.store.findByKey(key) : undefined;
    if (existing) {
      if (existing.projectId !== previous.projectId || existing.prompt !== instruction || existing.parentTaskId !== previous.id)
        throw new BridgeError("IDEMPOTENCY_CONFLICT", "Key already used for different task");
      return existing;
    }
    this.requireIdle(previous.projectId);
    const task = this.store.createTask(previous.projectId, instruction, this.validateKey(key), previous.threadId, previous.id);
    this.schedule(task);
    return task;
  }

  cancelTask(taskId: string): Task {
    const task = this.getTask(taskId);
    const work = this.active.get(task.projectId);
    if (!work || work.taskId !== task.id || !["RUNNING", "QUEUED"].includes(task.status))
      throw new BridgeError("NOT_ACTIVE", "Task is not active in this bridge process");
    work.abort.abort();
    this.store.appendEvent(task.id, "task.cancel_requested", "User requested cancellation");
    return this.store.getTask(task.id);
  }

  async shutdown(): Promise<void> {
    const running = [...this.active.values()];
    for (const work of running) work.abort.abort();
    await Promise.allSettled(running.map(work => work.work));
  }

  async wait(taskId: string): Promise<Task> {
    await this.pending.get(validateId(taskId));
    return this.getTask(taskId);
  }

  report(taskId: string): {
    task: Task;
    project: { id: string; name: string };
    eventCount: number;
    observedCommands: { command: string; result: string }[];
    verification: string;
  } {
    const task = this.getTask(taskId);
    const project = this.store.getProject(task.projectId);
    const all = this.store.events(task.id);
    const observedCommands = all.filter(e => e.detail.startsWith("Command ")).map(e => ({
      command: e.detail, result: e.detail.includes("exit=0") ? "observed-exit-zero" : "not-verified"
    }));
    return {
      task,
      project: { id: project.id, name: project.name },
      eventCount: all.length,
      observedCommands,
      verification: "This report is agent output plus observed SDK events; no independent code review or test verification is implied."
    };
  }

  private validateKey(value: string | null): string | null {
    if (value === null) return null;
    if (typeof value !== "string" || !/^[a-zA-Z0-9:_-]{8,128}$/.test(value))
      throw new BridgeError("INVALID_KEY", "Idempotency key must be 8–128 safe characters");
    return value;
  }

  private requireIdle(projectId: string): void {
    if (this.active.has(projectId)) throw new BridgeError("PROJECT_BUSY", "A task is already running for this project");
  }

  private schedule(task: Task): void {
    const abort = new AbortController();
    // Reserve the project synchronously: two API requests cannot start overlapping Codex turns.
    const work = Promise.resolve().then(() => this.execute(task.id, abort));
    this.active.set(task.projectId, { taskId: task.id, abort, work });
    this.pending.set(task.id, work);
    const cleanup = () => {
      const current = this.active.get(task.projectId);
      if (current?.taskId === task.id) this.active.delete(task.projectId);
      this.pending.delete(task.id);
    };
    void work.then(cleanup, cleanup);
  }

  private async execute(taskId: string, abort: AbortController): Promise<void> {
    const task = this.store.getTask(taskId);
    try {
      if (abort.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const project = this.store.getProject(task.projectId);
      // The registered path may have moved or been replaced since registration.
      const currentPath = await validateProjectPath(project.path);
      if (currentPath !== project.path) throw new BridgeError("PROJECT_CHANGED", "Project real path changed");
      this.store.updateStatus(task.id, "RUNNING");
      this.store.appendEvent(task.id, "task.running", "Codex task started in read-only mode");
      const turn = await this.agent.run({ workingDirectory: project.path, prompt: task.prompt,
        threadId: task.threadId, signal: abort.signal });
      let complete = false;
      let finalResponse = "";
      for await (const event of turn.events) {
        if (abort.signal.aborted) throw new DOMException("Cancelled", "AbortError");
        if (event.type === "thread.started" && event.thread_id) this.store.setThread(task.id, event.thread_id);
        const { type, detail } = summarizeEvent(event);
        if (type !== "unknown") this.store.appendEvent(task.id, type, detail);
        if (event.type === "item.completed" && event.item?.type === "agent_message") {
          finalResponse = redact(event.item.text ?? "", 20_000);
        }
        if (event.type === "turn.failed" || event.type === "error") {
          throw new BridgeError("AGENT_FAILED", event.error?.message ?? event.message ?? "Codex execution error");
        }
        if (event.type === "turn.completed") complete = true;
      }
      const resumedId = turn.getThreadId();
      if (resumedId) this.store.setThread(task.id, resumedId);
      if (abort.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      if (!complete) throw new BridgeError("INCOMPLETE_STREAM", "Codex event stream ended without turn.completed");
      this.store.updateStatus(task.id, "SUCCEEDED", { result: finalResponse });
    } catch (error) {
      if (abort.signal.aborted) {
        this.store.updateStatus(task.id, "CANCELLED", { error: "Cancelled by user" });
      } else {
        const reason = error instanceof Error ? error.message : "Unknown error";
        this.store.updateStatus(task.id, "FAILED", { error: redact(reason) });
      }
    }
  }
}
