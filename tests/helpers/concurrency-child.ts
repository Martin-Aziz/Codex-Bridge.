import { Store } from "../../src/store.js";
import { TaskEngine } from "../../src/engine.js";
import type { AgentRunner } from "../../src/types.js";

const [mode, dbPath, projectId] = process.argv.slice(2);
if (!dbPath) throw new Error("Missing database path");
const store = new Store(dbPath);
if (mode === "inspect") {
  console.log(JSON.stringify(store.listTasks().map(task => ({ id: task.id, status: task.status }))));
  store.close();
} else {
  const agent: AgentRunner = {
    async run() { return await new Promise<never>(() => {}); }
  };
  const engine = new TaskEngine(store, agent);
  try {
    const task = engine.submit(projectId!, `cross-process task ${process.pid}`);
    console.log(JSON.stringify({ status: "SUBMITTED", id: task.id }));
    setInterval(() => undefined, 1000);
  } catch (error) {
    console.log(JSON.stringify({ status: "REJECTED", code: (error as { code?: string }).code ?? "UNKNOWN" }));
    store.close();
  }
}
