import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { BridgeError } from "./security.js";
import type { Project, StoredEvent, Task, TaskStatus } from "./types.js";

function id(): string { return randomUUID().replaceAll("-", ""); }
function now(): string { return new Date().toISOString(); }

export class Store {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
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
      );`);
    // A dead bridge process cannot reattach to its Codex subprocess; release and interrupt its tasks.
    const locks = this.db.prepare("SELECT projectId,taskId,owner,heartbeatAt FROM project_locks").all() as unknown as { projectId: string; taskId: string; owner: string; heartbeatAt: string }[];
    for (const lock of locks) {
      const pid = Number(lock.owner.split(":", 1)[0]);
      let alive = Number.isInteger(pid) && pid > 0;
      if (alive) { try { process.kill(pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code === "EPERM"; } }
      const stale = Date.now() - Date.parse(lock.heartbeatAt) > 30_000;
      if (!alive || stale) {
        this.db.prepare("UPDATE tasks SET status='INTERRUPTED', updatedAt=? WHERE id=? AND status IN ('RUNNING','QUEUED')").run(now(), lock.taskId);
        this.db.prepare("DELETE FROM project_locks WHERE projectId=? AND taskId=?").run(lock.projectId, lock.taskId);
      }
    }
    this.db.prepare("UPDATE tasks SET status='INTERRUPTED', updatedAt=? WHERE status IN ('RUNNING','QUEUED') AND id NOT IN (SELECT taskId FROM project_locks)").run(now());
    this.db.prepare("DELETE FROM project_locks WHERE taskId NOT IN (SELECT id FROM tasks WHERE status IN ('RUNNING','QUEUED'))").run();
  }

  reserveProject(projectId: string, taskId: string, owner: string): boolean {
    this.db.prepare("DELETE FROM project_locks WHERE projectId=? AND taskId NOT IN (SELECT id FROM tasks WHERE status IN ('QUEUED','RUNNING'))").run(projectId);
    try {
      const timestamp = now();
      this.db.prepare("INSERT INTO project_locks(projectId,taskId,owner,acquiredAt,heartbeatAt) VALUES(?,?,?,?,?)")
        .run(projectId, taskId, owner, timestamp, timestamp);
      return true;
    } catch { return false; }
  }
  touchProject(projectId: string, taskId: string, owner: string): void {
    this.db.prepare("UPDATE project_locks SET heartbeatAt=? WHERE projectId=? AND taskId=? AND owner=?")
      .run(now(), projectId, taskId, owner);
  }
  releaseProject(projectId: string, taskId: string): void {
    this.db.prepare("DELETE FROM project_locks WHERE projectId=? AND taskId=?").run(projectId, taskId);
  }
  projectBusy(projectId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM project_locks WHERE projectId=?").get(projectId));
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
  setThread(taskId: string, threadId: string): void {
    this.db.prepare("UPDATE tasks SET threadId=?,updatedAt=? WHERE id=?").run(threadId, now(), taskId);
  }
  appendEvent(taskId: string, type: string, detail: string): void {
    this.db.prepare("INSERT INTO events(taskId,type,detail,createdAt) VALUES(?,?,?,?)")
      .run(taskId, type, detail, now());
  }
  events(taskId: string, after = 0): StoredEvent[] {
    this.getTask(taskId);
    return this.db.prepare("SELECT * FROM events WHERE taskId=? AND id>? ORDER BY id LIMIT 300")
      .all(taskId, after) as unknown as StoredEvent[];
  }
  close(): void { this.db.close(); }
}
