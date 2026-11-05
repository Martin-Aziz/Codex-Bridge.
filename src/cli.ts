#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, lstatSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, platform } from "node:os";
import { basename, join } from "node:path";
import { CodexRunner } from "./codex.js";
import { Store } from "./store.js";
import { TaskEngine } from "./engine.js";
import { createBridgeServer, listenLoopback } from "./api.js";
import { createJwtVerifier, createMcpHttpServer, requireMcpConfiguration } from "./mcp.js";

const home = platform() === "darwin"
  ? join(homedir(), "Library", "Application Support", "CodexBridge")
  : join(homedir(), ".local", "share", "codex-bridge");
const dataDir = process.env.CODEX_BRIDGE_DATA_DIR ?? home;
const tokenFile = join(dataDir, "access-token");
const dbFile = join(dataDir, "bridge.sqlite");

function token(): string {
  if (process.env.CODEX_BRIDGE_TOKEN) {
    if (process.env.CODEX_BRIDGE_TOKEN.length < 32) throw new Error("CODEX_BRIDGE_TOKEN must contain at least 32 characters");
    return process.env.CODEX_BRIDGE_TOKEN;
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(dataDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Data path must be a real directory");
  chmodSync(dataDir, 0o700);
  if (!existsSync(tokenFile)) {
    try { writeFileSync(tokenFile, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
    catch (e) { if (!existsSync(tokenFile)) throw e; }
  }
  const info = lstatSync(tokenFile);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Token path must be a regular file");
  if (info.nlink !== 1) throw new Error("Token path must not be hard-linked");
  chmodSync(tokenFile, 0o600);
  const value = readFileSync(tokenFile, "utf8").trim();
  if (value.length < 32) throw new Error("Token file is invalid; remove it and run the token command to regenerate");
  return value;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "help" || !cmd) {
    console.log(`Codex Bridge (read-only)
  npm run bridge -- register <absolute-git-repo-path> [display-name]
  npm run bridge -- projects | tasks | report <taskId> | events <taskId>
  npm run bridge -- start <projectId> <instruction>
  npm run bridge -- continue <taskId> <instruction>
  npm run bridge -- serve [port]  # local-only authenticated HTTP API
  npm run bridge -- mcp-serve [port]  # scoped OAuth MCP endpoint for private tunnels
  npm run bridge -- token         # show local API token; never share it`);
    return;
  }
  if (cmd === "token") { console.log(token()); return; }
  const store = new Store(dbFile);
  const engine = new TaskEngine(store, new CodexRunner());
  if (cmd === "mcp-serve") {
    try {
      const config = requireMcpConfiguration();
      const server = createMcpHttpServer(engine, createJwtVerifier(config), config.audience);
      const address = await listenLoopback(server, Number(args[0] ?? "49442"));
      console.log(`Authenticated MCP endpoint listening only on http://${address.host}:${address.port}/mcp`);
      console.log(`OAuth issuer: ${config.issuer}; required tool scopes are listed in docs/PHASE3-MCP.md`);
      let stopping = false;
      const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        server.close();
        await engine.shutdown();
        store.close();
      };
      process.once("SIGINT", () => { void shutdown().then(() => { process.exitCode = 0; }); });
      process.once("SIGTERM", () => { void shutdown().then(() => { process.exitCode = 0; }); });
      return;
    } catch (error) { store.close(); throw error; }
  }
  if (cmd === "serve") {
    const server = createBridgeServer(engine, token());
    const address = await listenLoopback(server, Number(args[0] ?? "49441"));
    console.log(`Codex Bridge listening only on http://${address.host}:${address.port}`);
    console.log("Use Authorization: Bearer <value from npm run bridge -- token>");
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      server.close();
      await engine.shutdown();
      store.close();
    };
    process.once("SIGINT", () => { void shutdown().then(() => { process.exitCode = 0; }); });
    process.once("SIGTERM", () => { void shutdown().then(() => { process.exitCode = 0; }); });
    return;
  }
  try {
    if (cmd === "register") {
      if (!args[0]) throw new Error("Missing repository directory");
      console.log(JSON.stringify(await engine.registerProject(args[1] ?? basename(args[0]), args[0]), null, 2));
    } else if (cmd === "projects") console.log(JSON.stringify(engine.listProjects(), null, 2));
    else if (cmd === "tasks") console.log(JSON.stringify(engine.listTasks(), null, 2));
    else if (cmd === "report" && args[0]) console.log(JSON.stringify(engine.report(args[0]), null, 2));
    else if (cmd === "events" && args[0]) console.log(JSON.stringify(engine.events(args[0]), null, 2));
    else if (cmd === "start" && args[0] && args[1]) {
      const task = engine.submit(args[0], args.slice(1).join(" "));
      console.log(JSON.stringify(await engine.wait(task.id), null, 2));
    } else if (cmd === "continue" && args[0] && args[1]) {
      const task = engine.continueTask(args[0], args.slice(1).join(" "));
      console.log(JSON.stringify(await engine.wait(task.id), null, 2));
    } else throw new Error("Invalid command or missing arguments; see 'help'");
  } finally { store.close(); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Unknown failure"); process.exitCode = 1; });
