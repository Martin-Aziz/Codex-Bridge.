import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { createMcpHandler, McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import { TaskEngine } from "./engine.js";
import { BridgeError, redact } from "./security.js";
import type { Task } from "./types.js";

export type McpIdentity = { subject: string; clientId: string; scopes: string[]; expiresAt: number; resource: string };
export type TokenVerifier = (token: string) => Promise<McpIdentity>;
const MAX_RESULT = 12_000;
const OUTPUT_CAP = 50_000;
const allScopes = ["projects:read", "tasks:read", "tasks:start", "tasks:continue", "tasks:cancel"];

function unauthorized(metadataPath: string, resource: URL): Response {
  const metadata = new URL(metadataPath, resource).href;
  return new Response("Unauthorized", { status: 401, headers: {
    "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${metadata}", scope="${allScopes.join(" ")}"`,
    "Cache-Control": "no-store",
  } });
}

function principalId(subject: string): string { return createHash("sha256").update(subject).digest("hex").slice(0, 32); }
function jsonText(value: unknown): { content: [{ type: "text"; text: string }]; structuredContent: Record<string, unknown> } {
  const raw = JSON.stringify(value);
  if (raw.length > OUTPUT_CAP) {
    const bounded = { truncated: true, message: "Result exceeded the MCP output limit. Request a smaller page or a narrower report." };
    return { content: [{ type: "text", text: JSON.stringify(bounded) }], structuredContent: { data: bounded } };
  }
  return { content: [{ type: "text", text: raw }], structuredContent: { data: value as unknown } };
}
function safeTask(task: Task): Record<string, unknown> {
  return { taskId: task.id, projectId: task.projectId, status: task.status, threadAvailable: Boolean(task.threadId),
    parentTaskId: task.parentTaskId, createdAt: task.createdAt, updatedAt: task.updatedAt };
}
function sanitizeProjectText(text: string, projectPath: string, limit = MAX_RESULT): string {
  return redact(text, limit).replaceAll(projectPath, "[PROJECT_PATH]");
}
function toolError(message: string): { isError: true; content: [{ type: "text"; text: string }] } {
  return { isError: true, content: [{ type: "text", text: redact(message, 1000) }] };
}

export function createJwtVerifier(config: { issuer: string; jwksUrl: string; audience: string }): TokenVerifier {
  const issuer = new URL(config.issuer).toString().replace(/\/$/, "");
  const audience = new URL(config.audience).toString();
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl));
  return async token => {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience, algorithms: ["RS256", "ES256"] });
    if (typeof payload.sub !== "string" || !payload.sub || typeof payload.exp !== "number") throw new Error("Invalid bearer token claims");
    const clientId = typeof payload.client_id === "string" ? payload.client_id : typeof payload.azp === "string" ? payload.azp : "";
    const rawScopes = payload.scope ?? payload.scp;
    const scopes = typeof rawScopes === "string" ? rawScopes.split(/\s+/).filter(Boolean) : Array.isArray(rawScopes) ? rawScopes.filter((s): s is string => typeof s === "string") : [];
    return { subject: payload.sub, clientId, scopes, expiresAt: payload.exp, resource: audience };
  };
}

export type McpServerOptions = { issuer?: string; resource?: string; allowedSubjects?: string[] };

export function createMcpHttpHandler(engine: TaskEngine, verifier: TokenVerifier, audience: string, options: McpServerOptions = {}) {
  const resource = new URL(audience);
  const metadataResource = new URL(options.resource ?? audience);
  const resourceMetadataPath = `/.well-known/oauth-protected-resource${metadataResource.pathname === "/" ? "" : metadataResource.pathname}`;
  const rootMetadataPath = "/.well-known/oauth-protected-resource";
  const factory = ({ authInfo }: { authInfo?: AuthInfo }) => {
    const server = new McpServer({ name: "codex-bridge", version: "0.3.0" });
    const auth = authInfo;
    const define = (name: string, scope: string, bucket: "read" | "write", schema: z.ZodObject<any>, handler: (args: Record<string, unknown>, principal: string) => unknown) => {
      server.registerTool(name, {
        title: name.replaceAll("_", " "), description: descriptions[name]!, inputSchema: schema,
        annotations: { readOnlyHint: bucket === "read", destructiveHint: false, openWorldHint: false },
      }, async (args: unknown) => {
          const subject = auth?.clientId ?? "unauthenticated";
        const principal = principalId(subject);
        let taskId: string | null = typeof (args as Record<string, unknown> | null)?.taskId === "string" ? (args as Record<string, string>).taskId! : null;
        try {
          if (!auth || !auth.scopes.includes(scope) || !auth.expiresAt || auth.expiresAt <= Math.floor(Date.now() / 1000) || !auth.resource || auth.resource.href !== resource.href)
            throw new BridgeError("FORBIDDEN", "Authenticated token lacks required tool permission");
          const rateBucket = bucket === "read" ? "read" : name;
          const limit = engine.store.consumeMcpRate(principal, rateBucket, bucket === "read" ? 120 : 20);
          if (!limit) throw new BridgeError("RATE_LIMITED", "Tool rate limit exceeded");
          const value = await handler(args as Record<string, unknown>, principal);
          if (value && typeof value === "object" && "taskId" in value && typeof value.taskId === "string") taskId = value.taskId;
          engine.store.auditMcp(principal, name, "allowed", taskId);
          return jsonText(value);
        } catch (error) {
          engine.store.auditMcp(principal, name, error instanceof BridgeError ? `denied:${error.code}` : "failed", taskId);
          return toolError(error instanceof Error ? error.message : "Tool failed");
        }
      });
    };
    define("list_projects", "projects:read", "read", z.object({}).strict(), () => engine.listProjects().map(p => ({ projectId: p.id, name: p.name })));
    define("get_task_status", "tasks:read", "read", z.object({ taskId: z.string().regex(/^[a-f0-9]{32}$/) }).strict(), a => safeTask(engine.getTask(a.taskId as string)));
    define("get_task_report", "tasks:read", "read", z.object({ taskId: z.string().regex(/^[a-f0-9]{32}$/) }).strict(), a => {
      const report = engine.report(a.taskId as string);
      const projectPath = engine.store.getProject(report.task.projectId).path;
      return { ...safeTask(report.task), project: { projectId: report.project.id, name: report.project.name },
        result: sanitizeProjectText(report.task.result ?? "", projectPath), error: report.task.error ? sanitizeProjectText(report.task.error, projectPath, 2000) : null,
        eventCount: report.eventCount, observedCommands: report.observedCommands.slice(0, 25).map(c => ({ command: sanitizeProjectText(c.command, projectPath, 500), result: c.result })), verification: report.verification };
    });
    define("get_task_events", "tasks:read", "read", z.object({ taskId: z.string().regex(/^[a-f0-9]{32}$/), after: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50) }).strict(), a => {
      const limit = a.limit as number;
      const events = engine.events(a.taskId as string, a.after as number, limit + 1);
      const projectPath = engine.store.getProject(engine.getTask(a.taskId as string).projectId).path;
      return { events: events.slice(0, limit).map(e => ({ id: e.id, type: e.type, detail: sanitizeProjectText(e.detail, projectPath, 400), createdAt: e.createdAt })),
        nextCursor: events.length > limit ? events[limit - 1]?.id ?? a.after : null };
    });
    define("start_task", "tasks:start", "write", z.object({ projectId: z.string().regex(/^[a-f0-9]{32}$/), prompt: z.string().min(4).max(16_000), idempotencyKey: z.string().min(8).max(128).regex(/^[a-zA-Z0-9:_-]+$/).optional() }).strict(), a => {
      const task = engine.submit(a.projectId as string, a.prompt as string, (a.idempotencyKey as string | undefined) ?? null);
      return { ...safeTask(task), accepted: true, pollTool: "get_task_status" };
    });
    define("continue_task", "tasks:continue", "write", z.object({ taskId: z.string().regex(/^[a-f0-9]{32}$/), prompt: z.string().min(4).max(16_000), idempotencyKey: z.string().min(8).max(128).regex(/^[a-zA-Z0-9:_-]+$/).optional() }).strict(), a => {
      const task = engine.continueTask(a.taskId as string, a.prompt as string, (a.idempotencyKey as string | undefined) ?? null);
      return { ...safeTask(task), accepted: true, pollTool: "get_task_status" };
    });
    define("cancel_task", "tasks:cancel", "write", z.object({ taskId: z.string().regex(/^[a-f0-9]{32}$/) }).strict(), a => safeTask(engine.cancelTask(a.taskId as string)));
    return server;
  };
  const mcp = createMcpHandler(factory, { legacy: "stateless", maxRequestBodySize: 64_000, responseMode: "json" });
  return {
    async fetch(request: Request): Promise<Response> {
      if (request.method === "GET" && [resourceMetadataPath, rootMetadataPath].includes(new URL(request.url).pathname)) {
        const issuer = options.issuer ?? process.env.MCP_OAUTH_ISSUER;
        return Response.json({ resource: metadataResource.href, ...(issuer ? { authorization_servers: [issuer] } : {}), bearer_methods_supported: ["header"], scopes_supported: allScopes, scope: allScopes.join(" ") }, { headers: { "Cache-Control": "no-store" } });
      }
      if (new URL(request.url).pathname !== "/mcp") return new Response("Not found", { status: 404 });
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
      const header = request.headers.get("authorization") ?? "";
      const match = /^Bearer ([^\s]{16,8192})$/.exec(header);
      if (!match) return unauthorized(resourceMetadataPath, metadataResource);
      let identity: McpIdentity;
      try { identity = await verifier(match[1]!); }
      catch { return unauthorized(resourceMetadataPath, metadataResource); }
      if (identity.resource !== resource.href || !identity.clientId || !identity.subject || identity.expiresAt <= Math.floor(Date.now() / 1000) ||
          (options.allowedSubjects && !options.allowedSubjects.includes(identity.subject))) return unauthorized(resourceMetadataPath, metadataResource);
      const authInfo: AuthInfo = { token: "[verified]", clientId: `${identity.clientId}:${identity.subject}`, scopes: identity.scopes, expiresAt: identity.expiresAt, resource };
      return mcp.fetch(request, { authInfo });
    }, close: mcp.close,
  };
}

const descriptions: Record<string, string> = {
  list_projects: "List registered repositories available to this Codex Bridge instance. Returns opaque project IDs, never local paths.",
  get_task_status: "Poll a task by task ID. This returns immediately and never waits for Codex to finish.",
  get_task_report: "Read a bounded, redacted final task report without exposing local repository paths or the original instruction.",
  get_task_events: "Read a bounded page of redacted task events. Continue with nextCursor.",
  start_task: "Start a read-only Codex task for a registered project ID. Returns a task ID immediately; poll get_task_status and read events/report separately.",
  continue_task: "Continue a completed Codex session by task ID. Returns a task ID immediately; poll get_task_status and read events/report separately.",
  cancel_task: "Request cancellation of an active Codex task by task ID.",
};

async function readBody(req: IncomingMessage, limit = 64_000): Promise<Buffer> {
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const p = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); size += p.length; if (size > limit) throw new Error("Request too large"); parts.push(p); }
  return Buffer.concat(parts);
}
function sendWebResponse(res: ServerResponse, response: Response): void {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  void response.arrayBuffer().then(body => res.end(Buffer.from(body)), () => res.end());
}
export function createMcpHttpServer(engine: TaskEngine, verifier: TokenVerifier, audience: string, options: McpServerOptions = {}): Server {
  const handler = createMcpHttpHandler(engine, verifier, audience, options);
  const server = createServer(async (req, res) => {
    try {
      if (!req.url || req.headers.host !== `127.0.0.1:${req.socket.localPort}`) { res.writeHead(403).end(); return; }
      const url = new URL(req.url, `http://127.0.0.1:${req.socket.localPort}`);
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const request = new Request(url, { method: req.method ?? "GET", headers: req.headers as HeadersInit, ...(body ? { body, duplex: "half" } as RequestInit : {}) });
      sendWebResponse(res, await handler.fetch(request));
    } catch { res.writeHead(413).end("Request rejected"); }
  });
  server.once("close", () => { void handler.close(); });
  return server;
}

export function requireMcpConfiguration(env: NodeJS.ProcessEnv = process.env): { issuer: string; jwksUrl: string; audience: string; resource: string; allowedSubjects: string[] } {
  const issuer = env.MCP_OAUTH_ISSUER, jwksUrl = env.MCP_OAUTH_JWKS_URL, audience = env.MCP_OAUTH_AUDIENCE;
  const resource = env.MCP_OAUTH_RESOURCE;
  const allowedSubjects = env.MCP_ALLOWED_SUBJECTS?.split(",").map(value => value.trim()).filter(Boolean) ?? [];
  if (!issuer || !jwksUrl || !audience || !resource || allowedSubjects.length === 0) throw new Error("Set MCP_OAUTH_ISSUER, MCP_OAUTH_JWKS_URL, MCP_OAUTH_AUDIENCE, MCP_OAUTH_RESOURCE, and at least one MCP_ALLOWED_SUBJECTS value before starting MCP mode");
  for (const value of [issuer, jwksUrl, audience, resource]) { const url = new URL(value); if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("MCP auth URLs must use HTTPS except local test issuers"); }
  return { issuer, jwksUrl, audience, resource, allowedSubjects };
}

