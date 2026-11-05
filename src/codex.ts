import { Codex, type Thread, type ThreadEvent, type ThreadOptions } from "@openai/codex-sdk";
import type { AgentRunner, AgentTurn } from "./types.js";

/**
 * Adapter to OpenAI's official Codex SDK. Deliberately read-only for Phase 1:
 * writes, git pushes and shell privilege escalation are not remote-callable.
 * A future workspace-write mode must use explicit per-task user approval.
 */
export class CodexRunner implements AgentRunner {
  private readonly client = new Codex();

  async run(request: { workingDirectory: string; prompt: string; threadId: string | null; signal: AbortSignal }): Promise<AgentTurn> {
    const opts: ThreadOptions = {
      workingDirectory: request.workingDirectory,
      skipGitRepoCheck: false,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled"
    };
    const thread: Thread = request.threadId ? this.client.resumeThread(request.threadId, opts) : this.client.startThread(opts);
    const stream = await thread.runStreamed(request.prompt, { signal: request.signal });
    return { events: stream.events as AsyncIterable<ThreadEvent>, getThreadId: () => thread.id };
  }
}
