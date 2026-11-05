import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { AddressInfo } from "node:net";
import { TaskEngine } from "./engine.js";
import { BridgeError } from "./security.js";

function send(res: ServerResponse, code: number, value: unknown): void {
  const output = JSON.stringify(value);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
    "Content-Length": Buffer.byteLength(output)
  });
  res.end(output);
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let bytes = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += part.length;
    if (bytes > 64_000) throw new BridgeError("BODY_TOO_LARGE", "Request exceeds 64 KB");
    parts.push(part);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new BridgeError("INVALID_JSON", "Expected a JSON object");
  }
}

function secureEquals(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function corsSafe(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  const origin = req.headers.origin;
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  return hosts.includes(host ?? "") && (!origin || hosts.some(h => origin === `http://${h}`));
}

/** Loopback-only API. Never expose this server through a public reverse proxy without a new security review. */
export function createBridgeServer(engine: TaskEngine, token: string): Server {
  if (token.length < 32) throw new BridgeError("INVALID_TOKEN", "Bearer token must contain at least 32 characters");
  return createServer(async (req, res) => {
    const port = (req.socket.localPort ?? 0);
    if (!corsSafe(req, port)) { send(res, 403, { error: "Origin or Host forbidden" }); return; }
    const authorization = req.headers.authorization ?? "";
    if (!secureEquals(authorization, `Bearer ${token}`)) { send(res, 401, { error: "Unauthorized" }); return; }
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const path = url.pathname;
      if (req.method === "GET" && path === "/v1/projects") { send(res, 200, { projects: engine.listProjects() }); return; }
      if (req.method === "GET" && path === "/v1/tasks") { send(res, 200, { tasks: engine.listTasks() }); return; }
      if (req.method === "POST" && path === "/v1/projects") {
        const body = await jsonBody(req);
        if (typeof body.name !== "string" || typeof body.path !== "string") throw new BridgeError("INVALID_INPUT", "Expected name and path");
        send(res, 201, { project: await engine.registerProject(body.name, body.path) }); return;
      }
      if (req.method === "POST" && path === "/v1/tasks") {
        const body = await jsonBody(req);
        if (typeof body.projectId !== "string" || typeof body.prompt !== "string") throw new BridgeError("INVALID_INPUT", "Expected projectId and prompt");
        if (body.key !== undefined && typeof body.key !== "string") throw new BridgeError("INVALID_INPUT", "Invalid idempotency key");
        const task = engine.submit(body.projectId, body.prompt, typeof body.key === "string" ? body.key : null);
        send(res, 202, { task }); return;
      }
      const match = /^\/v1\/tasks\/([a-f0-9]{32})(?:\/(events|report|continue|cancel))?$/.exec(path);
      if (match) {
        const id = match[1]!;
        const action = match[2] ?? "";
        if (req.method === "GET" && action === "") { send(res, 200, { task: engine.getTask(id) }); return; }
        if (req.method === "GET" && action === "events") {
          const after = Number(url.searchParams.get("after") ?? "0");
          send(res, 200, { events: engine.events(id, after) }); return;
        }
        if (req.method === "GET" && action === "report") { send(res, 200, engine.report(id)); return; }
        if (req.method === "POST" && action === "cancel") { send(res, 202, { task: engine.cancelTask(id) }); return; }
        if (req.method === "POST" && action === "continue") {
          const body = await jsonBody(req);
          if (typeof body.prompt !== "string") throw new BridgeError("INVALID_INPUT", "Expected prompt");
          if (body.key !== undefined && typeof body.key !== "string") throw new BridgeError("INVALID_INPUT", "Invalid idempotency key");
          send(res, 202, { task: engine.continueTask(id, body.prompt, typeof body.key === "string" ? body.key : null) }); return;
        }
      }
      send(res, 404, { error: "Endpoint not found" });
    } catch (error) {
      if (error instanceof BridgeError) {
        const code = error.code === "PROJECT_BUSY" || error.code === "IDEMPOTENCY_CONFLICT" ? 409 :
          error.code.endsWith("NOT_FOUND") ? 404 : error.code === "BODY_TOO_LARGE" ? 413 : 400;
        send(res, code, { error: error.code, message: error.message });
      } else {
        send(res, 500, { error: "INTERNAL_ERROR", message: "Unexpected failure; check local service logs" });
      }
    }
  });
}

export async function listenLoopback(server: Server, port: number): Promise<{ host: string; port: number }> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new BridgeError("INVALID_PORT", "Invalid TCP port");
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  return { host: "127.0.0.1", port: address.port };
}
