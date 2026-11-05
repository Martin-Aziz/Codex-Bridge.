import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";

const exec = promisify(execFile);

export class BridgeError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

/** Registration is a *local-only* administrative operation. Never use arbitrary paths from MCP. */
export async function validateProjectPath(input: string): Promise<string> {
  if (!input || input.length > 4096 || input.includes("\0")) throw new BridgeError("INVALID_PATH", "Invalid project path");
  const actual = await realpath(resolve(input));
  if (!(await stat(actual)).isDirectory()) throw new BridgeError("INVALID_PATH", "Not a directory");
  let root: string;
  try {
    const output = await exec("git", ["-C", actual, "rev-parse", "--show-toplevel"], { timeout: 8000 });
    root = await realpath(output.stdout.trim());
  } catch {
    throw new BridgeError("NOT_GIT", "Project must be an existing Git repository");
  }
  if (root !== actual) throw new BridgeError("NOT_GIT_ROOT", "Register the repository root, not a nested folder");
  return actual;
}

export function validatePrompt(input: unknown): string {
  if (typeof input !== "string" || input.trim().length < 4 || input.length > 16_000) {
    throw new BridgeError("INVALID_PROMPT", "Prompt must be 4–16000 characters");
  }
  return input.trim();
}

export function validateId(input: unknown): string {
  if (typeof input !== "string" || !/^[0-9a-f]{32}$/.test(input)) {
    throw new BridgeError("INVALID_ID", "Invalid identifier");
  }
  return input;
}

const secrets = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[opsu]_[A-Za-z0-9_]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~-]{8,}\b/gi,
  /((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)[^\s,;]+/gi,
];
export function redact(input: string, limit = 3200): string {
  let result = input;
  for (const pattern of secrets) result = result.replace(pattern, (_match, capture: string | number) =>
    typeof capture === "string" ? capture + "[REDACTED]" : "[REDACTED]");
  return result.length > limit ? result.slice(0, limit) + "… [TRUNCATED]" : result;
}

/** Only deliberately selected fields are persisted, not arbitrary SDK events or source files. */
export function summarizeEvent(event: import("./types.js").AgentEvent): { type: string; detail: string } {
  switch (event.type) {
    case "thread.started": return { type: event.type, detail: "Thread created" };
    case "turn.started": return { type: event.type, detail: "Codex is processing the task" };
    case "turn.completed": return { type: event.type, detail: "Codex finished the turn" };
    case "turn.failed": return { type: event.type, detail: redact(event.error?.message ?? "Turn failed") };
    case "error": return { type: event.type, detail: redact(event.message ?? "Agent error") };
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = event.item;
      if (item?.type === "agent_message") return { type: event.type, detail: redact(item.text ?? "", 2000) };
      if (item?.type === "command_execution") return { type: event.type, detail: redact(`Command ${item.status ?? ""}: ${item.command ?? ""}; exit=${item.exit_code ?? "?"}`, 1200) };
      return { type: event.type, detail: `Item ${String(item?.type ?? "unknown").slice(0, 80)}` };
    }
    default: return { type: "unknown", detail: "Unsupported agent event" };
  }
}
