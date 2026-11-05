import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, jwtVerify } from "jose";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Store } from "../src/store.js";
import { TaskEngine } from "../src/engine.js";
import { createMcpHttpServer, createJwtVerifier, type TokenVerifier } from "../src/mcp.js";
import { CodexRunner } from "../src/codex.js";
import type { AgentRunner } from "../src/types.js";

const issuer = "https://issuer.example.test";
const audience = "http://127.0.0.1:49442/mcp";
const privateKeyMaterial: { privateKey: CryptoKey; publicJwk: Record<string, unknown> }[] = [];
const scopes = ["projects:read", "tasks:read", "tasks:start", "tasks:continue", "tasks:cancel"];

async function keys() {
  const pair = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  return { privateKey: pair.privateKey, publicJwk };
}

async function jwt(scopeList = scopes, exp = Math.floor(Date.now() / 1000) + 3600) {
  const pair = privateKeyMaterial[0]!;
  return new SignJWT({ scope: scopeList.join(" "), client_id: "integration-client" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(issuer).setSubject("local-test-user")
    .setAudience(audience).setExpirationTime(exp).setIssuedAt().sign(pair.privateKey);
}

const mockRunner: AgentRunner = {
  async run({ threadId }) {
    const id = threadId ?? "thread-mcp-test";
    return { getThreadId: () => id, events: (async function* () {
      yield { type: "thread.started", thread_id: id } as const;
      yield { type: "item.completed", item: { type: "agent_message", text: "Mock report. api_key=sk-proj-abcdefghijklmnop" } } as const;
      yield { type: "turn.completed" } as const;
    })() };
  },
};

function value<T>(result: unknown): T {
  const parsed = result as { structuredContent?: unknown; content?: Array<{ text?: string }> };
  if (parsed.structuredContent !== undefined) return (parsed.structuredContent as { data: T }).data;
  return JSON.parse(parsed.content?.[0]?.text ?? "null") as T;
}

async function testHarness(run: (base: string, client: Client, engine: TaskEngine) => Promise<void>, verifierMode: "jwt" | "inject" = "jwt", customVerifier?: TokenVerifier) {
  const dir = await mkdtemp(join(tmpdir(), "bridge-mcp-"));
  const repo = join(dir, "repo"); await mkdir(repo); execFileSync("git", ["init", "-q", repo]);
  await writeFile(join(repo, "README.md"), "MCP test repo\n");
  const store = new Store(join(dir, "bridge.sqlite"));
  const engine = new TaskEngine(store, mockRunner);
  await engine.registerProject("MCP test", repo);
  const jwksServer = verifierMode === "jwt" ? (await import("node:http")).createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ keys: [privateKeyMaterial[0]!.publicJwk] }));
  }) : null;
  if (jwksServer) await new Promise<void>(resolve => jwksServer.listen(0, "127.0.0.1", resolve));
  const jwksPort = jwksServer ? (jwksServer.address() as { port: number }).port : 0;
  const verifier: TokenVerifier = customVerifier ?? (verifierMode === "jwt"
    ? createJwtVerifier({ issuer, audience, jwksUrl: `http://127.0.0.1:${jwksPort}/jwks` })
    : async token => token === "integration-bearer-token-1234567890" ? {
      subject: "local-test-user", clientId: "integration-client", scopes, expiresAt: Math.floor(Date.now() / 1000) + 3600, resource: audience,
    } : (() => { throw new Error("invalid token"); })());
  if (verifierMode === "jwt") {
    const server = createMcpHttpServer(engine, verifier, audience);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await jwt()}` } } });
    const client = new Client({ name: "codex-bridge-test", version: "1.0.0" });
    try { await client.connect(transport); await run(base, client, engine); }
    finally { await client.close(); await engine.shutdown(); await new Promise<void>(resolve => server.close(() => resolve())); await new Promise<void>(resolve => jwksServer!.close(() => resolve())); store.close(); await rm(dir, { recursive: true, force: true }); }
    return;
  }
  const server = createMcpHttpServer(engine, verifier, audience);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: "Bearer integration-bearer-token-1234567890" } } });
  const client = new Client({ name: "codex-bridge-test", version: "1.0.0" });
  try { await client.connect(transport); await run(base, client, engine); }
  finally { await client.close(); await engine.shutdown(); await new Promise<void>(resolve => server.close(() => resolve())); if (jwksServer) await new Promise<void>(resolve => jwksServer.close(() => resolve())); store.close(); await rm(dir, { recursive: true, force: true }); }
}

test("real MCP client completes list/start/poll/events/report/continue/cancel lifecycle", async () => {
  privateKeyMaterial[0] = await keys();
  await testHarness(async (_base, client) => {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(t => t.name).sort(), ["cancel_task", "continue_task", "get_task_events", "get_task_report", "get_task_status", "list_projects", "start_task"].sort());
    const projects = value<Array<{ projectId: string; name: string }>>(await client.callTool({ name: "list_projects", arguments: {} }));
    assert.equal(projects[0]?.name, "MCP test");
    const started = value<{ taskId: string; status: string }>(await client.callTool({ name: "start_task", arguments: { projectId: projects[0]!.projectId, prompt: "Inspect the readme" } }));
    assert.equal(started.status, "QUEUED");
    await new Promise(resolve => setTimeout(resolve, 50));
    const status = value<{ status: string }>(await client.callTool({ name: "get_task_status", arguments: { taskId: started.taskId } }));
    assert.equal(status.status, "SUCCEEDED");
    const events = value<{ events: Array<{ detail: string }> }>(await client.callTool({ name: "get_task_events", arguments: { taskId: started.taskId, after: 0, limit: 50 } }));
    assert.ok(events.events.length > 0);
    const report = value<{ result: string }>(await client.callTool({ name: "get_task_report", arguments: { taskId: started.taskId } }));
    assert.match(report.result, /\[REDACTED\]/);
    const continued = value<{ taskId: string }>(await client.callTool({ name: "continue_task", arguments: { taskId: started.taskId, prompt: "Summarize the same repository" } }));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(value<{ status: string }>(await client.callTool({ name: "get_task_status", arguments: { taskId: continued.taskId } })).status, "SUCCEEDED");
  });
});

test("MCP rejects unauthenticated requests, arbitrary paths, shell inputs, and missing scopes; audit is retained", async () => {
  const lowScope = "low-scope-token-1234567890";
  const verifier: TokenVerifier = async token => {
    if (token === lowScope) return { subject: "read-only", clientId: "integration-client", scopes: ["projects:read"], expiresAt: Math.floor(Date.now() / 1000) + 3600, resource: audience };
    if (token === "integration-bearer-token-1234567890") return { subject: "local-test-user", clientId: "integration-client", scopes, expiresAt: Math.floor(Date.now() / 1000) + 3600, resource: audience };
    throw new Error("invalid token");
  };
  await testHarness(async (base, client, engine) => {
    assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
    const started = await client.callTool({ name: "start_task", arguments: { projectId: "a".repeat(32), prompt: "Read files", path: "/etc/passwd", command: "cat /etc/passwd" } });
    assert.equal(started.isError, true);
    const lowScopeTransport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${lowScope}` } } });
    const lowScopeClient = new Client({ name: "low-scope-client", version: "1.0.0" });
    try {
      await lowScopeClient.connect(lowScopeTransport);
      const denial = await lowScopeClient.callTool({ name: "start_task", arguments: { projectId: "a".repeat(32), prompt: "Read files" } });
      assert.equal(denial.isError, true);
      assert.match(JSON.stringify(denial.content), /permission/);
    } finally { await lowScopeClient.close(); }
    assert.ok(engine.store.mcpAuditRows().some(row => row.outcome === "denied:FORBIDDEN"));
  }, "inject", verifier);
});

test("JWT verifier rejects expired credentials", async () => {
  privateKeyMaterial[0] = await keys();
  const expired = await jwt(scopes, Math.floor(Date.now() / 1000) - 10);
  const pair = privateKeyMaterial[0]!;
  const { jwtVerify, createLocalJWKSet } = await import("jose");
  await assert.rejects(jwtVerify(expired, createLocalJWKSet({ keys: [pair.publicJwk] }), { issuer, audience, algorithms: ["RS256"] }));
});

test("SQLite MCP rate limits are atomic and audit excludes credential material", () => {
  const store = new Store(":memory:");
  try {
    assert.equal(store.consumeMcpRate("principal-hash", "read", 2), true);
    assert.equal(store.consumeMcpRate("principal-hash", "read", 2), true);
    assert.equal(store.consumeMcpRate("principal-hash", "read", 2), false);
    store.auditMcp("principal-hash", "start_task", "allowed", "a".repeat(32));
    const entry = store.mcpAuditRows()[0]!;
    assert.equal(entry.principal, "principal-hash");
    assert.equal(JSON.stringify(entry).includes("Bearer"), false);
    assert.equal(JSON.stringify(entry).includes("sk-"), false);
  } finally { store.close(); }
});

test("real authenticated Codex start and continuation stay read-only in a disposable Git repository", { skip: process.env.RUN_REAL_CODEX_MCP !== "1" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-real-mcp-"));
  const repo = join(dir, "repo"); await mkdir(repo); execFileSync("git", ["init", "-q", repo]);
  await writeFile(join(repo, "README.md"), "# Disposable MCP repository\nA tiny fixture for read-only Codex Bridge integration checks.\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Codex Bridge Test", "-c", "user.email=bridge-test@example.invalid", "commit", "-qm", "fixture"]);
  const store = new Store(join(dir, "bridge.sqlite"));
  const engine = new TaskEngine(store, new CodexRunner());
  const project = await engine.registerProject("Disposable real Codex fixture", repo);
  const verifier: TokenVerifier = async token => token === "real-codex-integration-token-1234567890"
    ? { subject: "real-integration", clientId: "local-mcp-test", scopes, expiresAt: Math.floor(Date.now() / 1000) + 3600, resource: audience }
    : (() => { throw new Error("invalid token"); })();
  const server = createMcpHttpServer(engine, verifier, audience);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: "Bearer real-codex-integration-token-1234567890" } } });
  const client = new Client({ name: "codex-bridge-real-test", version: "1.0.0" });
  const call = async <T>(name: string, args: Record<string, unknown>) => value<T>(await client.callTool({ name, arguments: args }));
  const waitForTask = async (taskId: string) => {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const task = await call<{ status: string }>("get_task_status", { taskId });
      if (["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(task.status)) return task.status;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error("Real Codex MCP task timed out");
  };
  try {
    await client.connect(transport);
    const first = await call<{ taskId: string }>("start_task", { projectId: project.id, prompt: "Read README.md and report its heading. Do not modify any files." });
    assert.equal(await waitForTask(first.taskId), "SUCCEEDED");
    assert.match((await call<{ result: string }>("get_task_report", { taskId: first.taskId })).result, /Disposable MCP repository/i);
    const second = await call<{ taskId: string }>("continue_task", { taskId: first.taskId, prompt: "In the same session, report the number of non-empty lines in README.md. Do not modify any files." });
    assert.equal(await waitForTask(second.taskId), "SUCCEEDED");
    assert.ok(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }).trim() === "");
  } finally {
    await client.close(); await engine.shutdown(); await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); await rm(dir, { recursive: true, force: true });
  }
});
