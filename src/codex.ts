import type { AgentRunner, AgentTurn, AgentEvent } from "./types.js";

type SDKThread = {
  id: string | null;
  runStreamed(input: string, options?: { signal?: AbortSignal }): Promise<{ events: AsyncIterable<AgentEvent> }>;
};
type SDKCodex = {
  startThread(options: Record<string, unknown>): SDKThread;
  resumeThread(id: string, options: Record<string, unknown>): SDKThread;
};
type SDKConstructor = new () => SDKCodex;

/**
 * Adapter to OpenAI's official Codex SDK. Deliberately read-only for Phase 1:
 * writes, git pushes and shell privilege escalation are not remote-callable.
 * A future workspace-write mode must use explicit per-task user approval.
 */
export class CodexRunner implements AgentRunner {
  private client: SDKCodex | null = null;

  private async codex(): Promise<SDKCodex> {
    if (!this.client) {
      // Install @openai/codex-sdk + @openai/codex on the user's Mac.
      const packageName = "@openai/codex-sdk";
      const sdk = await import(packageName) as { Codex: SDKConstructor };
      this.client = new sdk.Codex();
    }
    return this.client;
  }

  async run(request: { workingDirectory: string; prompt: string; threadId: string | null; signal: AbortSignal }): Promise<AgentTurn> {
    const sdk = await this.codex();
    const opts = {
      workingDirectory: request.workingDirectory,
      skipGitRepoCheck: false,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled"
    };
    const thread = request.threadId ? sdk.resumeThread(request.threadId, opts) : sdk.startThread(opts);
    const stream = await thread.runStreamed(request.prompt, { signal: request.signal });
    return { events: stream.events, getThreadId: () => thread.id };
  }
}
