import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { BridgeError } from "./security.js";
import type { Project, StoredEvent, Task, TaskStatus } from "./types.js";

function id(): string { return randomUUID().replaceAll("-", ""); }
function now(): string { return new Date().toISOString(); }
function ownerIsAlive(owner: string): boolean {
  const pid = Number(owner.split(":", 1)[0]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export class Store {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA busy_timeout=5000;");
    if (file !== ":memory:") chmodSync(file, 0o600);
    this.db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
        prompt TEXT NOT NULL, status TEXT NOT NULL, threadId TEXT,
        parentTaskId TEXT, idempotencyKey TEXT UNIQUE, result TEXT, error TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL REFERENCES tasks(id),
        type TEXT NOT NULL, detail TEXT NOT NULL, createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_by_task ON events(taskId,id);
      CREATE INDEX IF NOT EXISTS tasks_by_project ON tasks(projectId,createdAt);
      CREATE TABLE IF NOT EXISTS project_locks (
        projectId TEXT PRIMARY KEY REFERENCES projects(id), taskId TEXT NOT NULL,
        owner TEXT NOT NULL, acquiredAt TEXT NOT NULL, heartbeatAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, principal TEXT NOT NULL, tool TEXT NOT NULL,
        outcome TEXT NOT NULL, taskId TEXT, createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mcp_audit_recent ON mcp_audit(createdAt);
      CREATE TABLE IF NOT EXISTS mcp_rate_limits (
        principal TEXT NOT NULL, bucket TEXT NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY(principal,bucket,window)
      );`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Startup reconciliation and task registration serialize on SQLite's write lock.
      const locks = this.db.prepare("SELECT projectId,taskId,owner FROM project_locks").all() as unknown as { projectId: string; taskId: string; owner: string }[];
      for (const lock of locks) {
        if (!ownerIsAlive(lock.owner)) {
          this.db.prepare("UPDATE tasks SET status='INTERRUPTED', updatedAt=? WHERE id=? AND status IN ('RUNNING','QUEUED')").run(now(), lock.taskId);
          this.db.prepare("DELETE FROM project_locks WHERE projectId=? AND taskId=? AND owner=?").run(lock.projectId, lock.taskId, lock.owner);
        }
      }
      this.db.prepare("UPDATE tasks SET status='INTERRUPTED', updatedAt=? WHERE status IN ('RUNNING','QUEUED') AND id NOT IN (SELECT taskId FROM project_locks)").run(now());
      this.db.prepare("DELETE FROM project_locks WHERE taskId NOT IN (SELECT id FROM tasks WHERE status IN ('RUNNING','QUEUED'))").run();
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  createTaskAndReserve(projectId: string, prompt: string, owner: string, key: string | null = null,
    threadId: string | null = null, parent: string | null = null): { task: Task; created: boolean } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.getProject(projectId);
      if (key) {
        const old = this.findByKey(key);
        if (old) {
          if (old.projectId !== projectId || old.prompt !== prompt || old.parentTaskId !== parent)
            throw new BridgeError("IDEMPOTENCY_CONFLICT", "Key already used for another request");
          this.db.exec("COMMIT");
          return { task: old, created: false };
        }
      }
      const lock = this.db.prepare("SELECT taskId,owner FROM project_locks WHERE projectId=?").get(projectId) as { taskId: string; owner: string } | undefined;
      if (lock) {
        const lockedTask = this.db.prepare("SELECT status FROM tasks WHERE id=?").get(lock.taskId) as { status: TaskStatus } | undefined;
        if (!lockedTask || !["QUEUED", "RUNNING"].includes(lockedTask.status)) {
          this.db.prepare("DELETE FROM project_locks WHERE projectId=? AND taskId=? AND owner=?").run(projectId, lock.taskId, lock.owner);
        } else if (!ownerIsAlive(lock.owner)) {
          this.db.prepare("UPDATE tasks SET status='INTERRUPTED', updatedAt=? WHERE id=? AND status IN ('QUEUED','RUNNING')").run(now(), lock.taskId);
          this.db.prepare("DELETE FROM project_locks WHERE projectId=? AND taskId=? AND owner=?").run(projectId, lock.taskId, lock.owner);
        } else {
          throw new BridgeError("PROJECT_BUSY", "A task is already running for this project");
        }
      }
      const timestamp = now();
      const task: Task = { id: id(), projectId, prompt, status: "QUEUED", threadId, parentTaskId: parent,
        idempotencyKey: key, result: null, error: null, createdAt: timestamp, updatedAt: timestamp };
      this.db.prepare(`INSERT INTO tasks (id,projectId,prompt,status,threadId,parentTaskId,idempotencyKey,result,error,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(task.id, task.projectId, task.prompt, task.status, task.threadId,
        task.parentTaskId, task.idempotencyKey, task.result, task.error, task.createdAt, task.updatedAt);
      this.db.prepare("INSERT INTO project_locks(projectId,taskId,owner,acquiredAt,heartbeatAt) VALUES(?,?,?,?,?)")
        .run(projectId, task.id, owner, timestamp, timestamp);
      this.db.exec("COMMIT");
      return { task, created: true };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  touchProject(projectId: string, taskId: string, owner: string): void {
    this.db.prepare("UPDATE project_locks SET heartbeatAt=? WHERE projectId=? AND taskId=? AND owner=?")
      .run(now(), projectId, taskId, owner);
  }
  releaseProject(projectId: string, taskId: string, owner: string): void {
    this.db.prepare("DELETE FROM project_locks WHERE projectId=? AND taskId=? AND owner=?").run(projectId, taskId, owner);
  }
  projectBusy(projectId: string): boolean {
    const lock = this.db.prepare("SELECT taskId,owner FROM project_locks WHERE projectId=?").get(projectId) as { taskId: string; owner: string } | undefined;
    if (!lock || !ownerIsAlive(lock.owner)) return false;
    const task = this.db.prepare("SELECT status FROM tasks WHERE id=?").get(lock.taskId) as { status: TaskStatus } | undefined;
    return Boolean(task && ["QUEUED", "RUNNING"].includes(task.status));
  }

  addProject(name: string, path: string): Project {
    const existing = this.db.prepare("SELECT * FROM projects WHERE path=?").get(path) as unknown as Project | undefined;
    if (existing) return existing;
    const value: Project = { id: id(), name: name.slice(0, 100), path, createdAt: now() };
    this.db.prepare("INSERT INTO projects (id,name,path,createdAt) VALUES (?,?,?,?)")
      .run(value.id, value.name, value.path, value.createdAt);
    return value;
  }

  getProject(projectId: string): Project {
    const item = this.db.prepare("SELECT * FROM projects WHERE id=?").get(projectId) as unknown as Project | undefined;
    if (!item) throw new BridgeError("PROJECT_NOT_FOUND", "Unknown project");
    return item;
  }
  listProjects(): Project[] { return this.db.prepare("SELECT * FROM projects ORDER BY createdAt DESC").all() as unknown as Project[]; }

  findByKey(key: string): Task | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE idempotencyKey=?").get(key) as unknown as Task | undefined;
  }

  createTask(projectId: string, prompt: string, key: string | null = null, threadId: string | null = null, parent: string | null = null): Task {
    this.getProject(projectId);
    if (key) {
      const old = this.findByKey(key);
      if (old) {
        if (old.projectId !== projectId || old.prompt !== prompt || old.parentTaskId !== parent)
          throw new BridgeError("IDEMPOTENCY_CONFLICT", "Key already used for another request");
        return old;
      }
    }
    const date = now();
    const task: Task = { id: id(), projectId, prompt, status: "QUEUED", threadId, parentTaskId: parent,
      idempotencyKey: key, result: null, error: null, createdAt: date, updatedAt: date };
    this.db.prepare(`INSERT INTO tasks (id,projectId,prompt,status,threadId,parentTaskId,idempotencyKey,result,error,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(task.id, task.projectId, task.prompt, task.status, task.threadId,
      task.parentTaskId, task.idempotencyKey, task.result, task.error, task.createdAt, task.updatedAt);
    return task;
  }

  getTask(taskId: string): Task {
    const task = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId) as unknown as Task | undefined;
    if (!task) throw new BridgeError("TASK_NOT_FOUND", "Unknown task");
    return task;
  }
  listTasks(): Task[] { return this.db.prepare("SELECT * FROM tasks ORDER BY createdAt DESC LIMIT 100").all() as unknown as Task[]; }

  updateStatus(taskId: string, status: TaskStatus, fields: { threadId?: string; result?: string; error?: string } = {}): void {
    const current = this.getTask(taskId);
    this.db.prepare("UPDATE tasks SET status=?,threadId=?,result=?,error=?,updatedAt=? WHERE id=?")
      .run(status, fields.threadId ?? current.threadId, fields.result ?? current.result,
        fields.error ?? current.error, now(), taskId);
  }
  updateStatusOwned(taskId: string, projectId: string, owner: string, status: TaskStatus,
    fields: { threadId?: string; result?: string; error?: string } = {}): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const owns = this.db.prepare("SELECT 1 FROM project_locks WHERE projectId=? AND taskId=? AND owner=?").get(projectId, taskId, owner);
      if (!owns) { this.db.exec("ROLLBACK"); return false; }
      this.updateStatus(taskId, status, fields);
      this.db.exec("COMMIT");
      return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  setThread(taskId: string, threadId: string): void {
    this.db.prepare("UPDATE tasks SET threadId=?,updatedAt=? WHERE id=?").run(threadId, now(), taskId);
  }
  setThreadOwned(taskId: string, projectId: string, owner: string, threadId: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.db.prepare("SELECT 1 FROM project_locks WHERE projectId=? AND taskId=? AND owner=?").get(projectId, taskId, owner)) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.setThread(taskId, threadId);
      this.db.exec("COMMIT");
      return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  appendEvent(taskId: string, type: string, detail: string): void {
    this.db.prepare("INSERT INTO events(taskId,type,detail,createdAt) VALUES(?,?,?,?)")
      .run(taskId, type, detail, now());
  }
  appendEventOwned(taskId: string, projectId: string, owner: string, type: string, detail: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.db.prepare("SELECT 1 FROM project_locks WHERE projectId=? AND taskId=? AND owner=?").get(projectId, taskId, owner)) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.appendEvent(taskId, type, detail);
      this.db.exec("COMMIT");
      return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  events(taskId: string, after = 0): StoredEvent[] {
    this.getTask(taskId);
    return this.db.prepare("SELECT * FROM events WHERE taskId=? AND id>? ORDER BY id LIMIT 300")
      .all(taskId, after) as unknown as StoredEvent[];
  }
  auditMcp(principal: string, tool: string, outcome: string, taskId: string | null = null): void {
    this.db.prepare("INSERT INTO mcp_audit(principal,tool,outcome,taskId,createdAt) VALUES(?,?,?,?,?)")
      .run(principal.slice(0, 160), tool.slice(0, 80), outcome.slice(0, 80), taskId, now());
  }
  consumeMcpRate(principal: string, bucket: string, max: number, windowMs = 60_000): boolean {
    const window = Math.floor(Date.now() / windowMs);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM mcp_rate_limits WHERE window < ?").run(window - 2);
      const row = this.db.prepare("SELECT count FROM mcp_rate_limits WHERE principal=? AND bucket=? AND window=?")
        .get(principal, bucket, window) as { count: number } | undefined;
      if ((row?.count ?? 0) >= max) { this.db.exec("COMMIT"); return false; }
      this.db.prepare(`INSERT INTO mcp_rate_limits(principal,bucket,window,count) VALUES(?,?,?,1)
        ON CONFLICT(principal,bucket,window) DO UPDATE SET count=count+1`).run(principal, bucket, window);
      this.db.exec("COMMIT");
      return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  mcpAuditRows(): { principal: string; tool: string; outcome: string; taskId: string | null }[] {
    return this.db.prepare("SELECT principal,tool,outcome,taskId FROM mcp_audit ORDER BY id")
      .all() as unknown as { principal: string; tool: string; outcome: string; taskId: string | null }[];
  }
  close(): void { this.db.close(); }
}
