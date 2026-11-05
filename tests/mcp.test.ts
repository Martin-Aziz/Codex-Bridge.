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
import { createMcpHttpServer, createJwtVerifier, requireMcpConfiguration, type TokenVerifier } from "../src/mcp.js";
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

async function jwt(scopeList = scopes, exp = Math.floor(Date.now() / 1000) + 3600, options: { issuer?: string; audience?: string; key?: CryptoKey; subject?: string } = {}) {
  const pair = privateKeyMaterial[0]!;
  return new SignJWT({ scope: scopeList.join(" "), client_id: "integration-client" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(options.issuer ?? issuer).setSubject(options.subject ?? "local-test-user")
    .setAudience(options.audience ?? audience).setExpirationTime(exp).setIssuedAt().sign(options.key ?? pair.privateKey);
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

async function testHarness(run: (base: string, client: Client, engine: TaskEngine) => Promise<void>, verifierMode: "jwt" | "inject" = "jwt", customVerifier?: TokenVerifier, expectedAudience = audience, metadataResource = expectedAudience, expectedIssuer = issuer) {
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
    ? createJwtVerifier({ issuer: expectedIssuer, audience: expectedAudience, jwksUrl: `http://127.0.0.1:${jwksPort}/jwks` })
    : async token => token === "integration-bearer-token-1234567890" ? {
      subject: "local-test-user", clientId: "integration-client", scopes, expiresAt: Math.floor(Date.now() / 1000) + 3600, resource: audience,
    } : (() => { throw new Error("invalid token"); })());
  if (verifierMode === "jwt") {
    const server = createMcpHttpServer(engine, verifier, expectedAudience, { issuer: expectedIssuer, resource: metadataResource, allowedSubjects: ["local-test-user"] });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await jwt(scopes, undefined, { audience: expectedAudience, issuer: expectedIssuer })}` } } });
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
  await testHarness(async (_base, client, engine) => {
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
    for (let index = 0; index < 350; index++) engine.store.appendEvent(started.taskId, "test.pagination", `Event ${index}`);
    let cursor = 0;
    let count = 0;
    while (true) {
      const page = value<{ events: Array<{ id: number }>; nextCursor: number | null }>(await client.callTool({ name: "get_task_events", arguments: { taskId: started.taskId, after: cursor, limit: 100 } }));
      count += page.events.length;
      if (page.nextCursor === null) break;
      assert.ok(page.nextCursor > cursor);
      cursor = page.nextCursor;
    }
    assert.equal(count, events.events.length + 350);
    const report = value<{ result: string }>(await client.callTool({ name: "get_task_report", arguments: { taskId: started.taskId } }));
    assert.match(report.result, /\[REDACTED\]/);
    const continued = value<{ taskId: string }>(await client.callTool({ name: "continue_task", arguments: { taskId: started.taskId, prompt: "Summarize the same repository" } }));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(value<{ status: string }>(await client.callTool({ name: "get_task_status", arguments: { taskId: continued.taskId } })).status, "SUCCEEDED");
  });
});

test("tunnel metadata resource is distinct from the rewritten OAuth token audience", async () => {
  privateKeyMaterial[0] = await keys();
  const tunnelAudience = "https://tunnel-resource.example.test/v1/mcp/tunnel_opaque";
  const localResource = "http://127.0.0.1:49442/mcp";
  await testHarness(async (_base, client) => {
    const projects = await client.callTool({ name: "list_projects", arguments: {} });
    assert.equal(projects.isError, undefined);
  }, "jwt", undefined, tunnelAudience, localResource);
});

test("HTTP JWT verifier preserves an Auth0 issuer trailing slash and rejects the slashless issuer", async () => {
  privateKeyMaterial[0] = await keys();
  const auth0Issuer = "https://codex-bridge-test.us.auth0.com/";
  await testHarness(async (base, client) => {
    const accepted = await client.callTool({ name: "list_projects", arguments: {} });
    assert.equal(accepted.isError, undefined, "token with the exact Auth0 issuer must be accepted");

    const wrongIssuerToken = await jwt(scopes, undefined, { issuer: auth0Issuer.slice(0, -1) });
    const rejected = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${wrongIssuerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(rejected.status, 401, "slashless issuer must be rejected by the actual MCP HTTP endpoint");
  }, "jwt", undefined, audience, audience, auth0Issuer);
});

test("HTTP auth rejects invalid JWTs, publishes path-aware metadata, refreshes expired tokens, and enforces scopes", async () => {
  privateKeyMaterial[0] = await keys();
  await testHarness(async (base, _client) => {
    const challenge = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(challenge.status, 401);
    const challengeHeader = challenge.headers.get("www-authenticate") ?? "";
    assert.match(challengeHeader, /error="invalid_token"/);
    assert.match(challengeHeader, /oauth-protected-resource\/mcp/);
    const metadataUrl = new URL((/resource_metadata="([^"]+)"/.exec(challengeHeader) ?? [])[1] ?? "");
    const metadata = await fetch(`${base}${metadataUrl.pathname}`);
    assert.equal(metadata.status, 200);
    const metadataBody = await metadata.json() as { resource: string; authorization_servers?: string[] };
    assert.equal(metadataBody.resource, audience);
    assert.deepEqual(metadataBody.authorization_servers, [issuer]);
    const rootMetadata = await fetch(`${base}/.well-known/oauth-protected-resource`);
    assert.equal(rootMetadata.status, 200);

    const { request: httpRequest } = await import("node:http");
    const forgedHostStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${base}/.well-known/oauth-protected-resource/mcp`, { headers: { Host: "attacker.invalid" } }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode ?? 0));
      });
      req.on("error", reject); req.end();
    });
    assert.equal(forgedHostStatus, 403);
    const ignoredForwardedHost = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`, { headers: { "X-Forwarded-Host": "attacker.invalid" } });
    assert.equal(ignoredForwardedHost.status, 200);

    const wrongKey = await generateKeyPair("RS256");
    const expired = await jwt(scopes, Math.floor(Date.now() / 1000) - 10);
    const wrongSignature = await jwt(scopes, Math.floor(Date.now() / 1000) + 3600, { key: wrongKey.privateKey });
    const wrongIssuer = await jwt(scopes, Math.floor(Date.now() / 1000) + 3600, { issuer: "https://wrong-issuer.example.test" });
    const wrongAudience = await jwt(scopes, Math.floor(Date.now() / 1000) + 3600, { audience: "https://wrong-resource.example.test/mcp" });
    const disallowedSubject = await jwt(scopes, Math.floor(Date.now() / 1000) + 3600, { subject: "different-operator" });
    for (const token of [expired, wrongSignature, wrongIssuer, wrongAudience, disallowedSubject]) {
      const response = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
      assert.equal(response.status, 401);
      assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata=/);
    }

    let token = expired;
    let refreshCount = 0;
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: {
      token: async () => token,
      onUnauthorized: async () => { refreshCount++; token = await jwt(); },
    } });
    const refreshingClient = new Client({ name: "refresh-test", version: "1.0.0" });
    try {
      await refreshingClient.connect(transport);
      assert.equal(refreshCount, 1);
      const projects = await refreshingClient.callTool({ name: "list_projects", arguments: {} });
      assert.equal(projects.isError, undefined);
    } finally { await refreshingClient.close(); }

    const readOnlyToken = await jwt(["projects:read"]);
    const scopeTransport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${readOnlyToken}` } } });
    const scopeClient = new Client({ name: "scope-test", version: "1.0.0" });
    try {
      await scopeClient.connect(scopeTransport);
      const denial = await scopeClient.callTool({ name: "start_task", arguments: { projectId: "a".repeat(32), prompt: "Read the repository" } });
      assert.equal(denial.isError, true);
    } finally { await scopeClient.close(); }
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
    for (const [name, arguments_] of [
      ["start_task", { projectId: "a".repeat(32), prompt: "Read files", command: "cat /etc/passwd" }],
      ["continue_task", { taskId: "b".repeat(32), prompt: "Read files", path: "/etc/passwd" }],
      ["cancel_task", { taskId: "b".repeat(32), command: "rm -rf /" }],
    ] as const) {
      let rejected = false;
      try { rejected = (await client.callTool({ name, arguments: arguments_ })).isError === true; }
      catch { rejected = true; }
      assert.equal(rejected, true, `${name} must reject additional path/shell fields`);
    }
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

test("production MCP configuration requires resource metadata and an explicit subject allowlist", () => {
  const base = { MCP_OAUTH_ISSUER: issuer, MCP_OAUTH_JWKS_URL: `${issuer}/jwks`, MCP_OAUTH_AUDIENCE: audience, MCP_OAUTH_RESOURCE: audience };
  assert.throws(() => requireMcpConfiguration(base as NodeJS.ProcessEnv), /MCP_ALLOWED_SUBJECTS/);
  const config = requireMcpConfiguration({ ...base, MCP_ALLOWED_SUBJECTS: " operator-1,operator-2 " } as NodeJS.ProcessEnv);
  assert.deepEqual(config.allowedSubjects, ["operator-1", "operator-2"]);
  assert.equal(config.resource, audience);
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
