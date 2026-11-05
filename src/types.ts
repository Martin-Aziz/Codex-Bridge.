export type TaskStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED";

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  prompt: string;
  status: TaskStatus;
  threadId: string | null;
  parentTaskId: string | null;
  idempotencyKey: string | null;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredEvent {
  id: number;
  taskId: string;
  type: string;
  detail: string;
  createdAt: string;
}

export interface AgentEvent {
  type: string;
  thread_id?: string;
  message?: string;
  error?: { message: string };
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number;
    status?: string;
    changes?: unknown;
  };
}

export interface AgentTurn {
  events: AsyncIterable<AgentEvent>;
  getThreadId(): string | null;
}

export interface AgentRunner {
  run(request: { workingDirectory: string; prompt: string; threadId: string | null; signal: AbortSignal }): Promise<AgentTurn>;
}
