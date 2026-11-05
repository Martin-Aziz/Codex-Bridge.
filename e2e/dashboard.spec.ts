import { test, expect } from "@playwright/test";
import type { Project, StoredEvent, Task } from "../src/types.js";

const project: Project = {
  id: "11111111111111111111111111111111",
  name: "Playwright Sample Repo",
  path: "/tmp/playwright-sample",
  createdAt: "2026-11-05T10:00:00.000Z"
};
const task: Task = {
  id: "22222222222222222222222222222222",
  projectId: project.id,
  prompt: "Inspect the README and summarize it",
  status: "SUCCEEDED",
  threadId: "mock-thread-1",
  parentTaskId: null,
  idempotencyKey: null,
  result: "Mock report: README reviewed successfully.",
  error: null,
  createdAt: "2026-11-05T10:01:00.000Z",
  updatedAt: "2026-11-05T10:01:04.000Z"
};
const events: StoredEvent[] = [
  { id: 1, taskId: task.id, type: "task.running", detail: "Mock agent started in read-only mode", createdAt: task.createdAt },
  { id: 2, taskId: task.id, type: "task.succeeded", detail: "Task completed successfully", createdAt: task.updatedAt }
];

test("connects locally, selects a repo, submits a mock task, and inspects events/report", async ({ page }) => {
  const authorizedOrigins = new Set<string>();
  let submitted = false;
  page.on("request", request => {
    const authorization = request.headers()["authorization"];
    if (authorization) {
      expect(authorization).toBe("Bearer playwright-local-token");
      authorizedOrigins.add(new URL(request.url()).origin);
    }
  });
  await page.route("**/v1/**", async route => {
    const request = route.request();
    expect(new URL(request.url()).origin).toBe(new URL(page.url()).origin);
    expect(request.headers()["authorization"]).toBe("Bearer playwright-local-token");
    const url = new URL(request.url());
    if (url.pathname === "/v1/projects" && request.method() === "GET") {
      await route.fulfill({ json: { projects: [project] } });
    } else if (url.pathname === "/v1/tasks" && request.method() === "GET") {
      await route.fulfill({ json: { tasks: submitted ? [task] : [] } });
    } else if (url.pathname === "/v1/tasks" && request.method() === "POST") {
      submitted = true;
      const body = request.postDataJSON() as { projectId: string; prompt: string };
      expect(body.projectId).toBe(project.id);
      expect(body.prompt).toBe(task.prompt);
      await route.fulfill({ status: 202, json: { task } });
    } else if (url.pathname === `/v1/tasks/${task.id}/events`) {
      await route.fulfill({ json: { events } });
    } else if (url.pathname === `/v1/tasks/${task.id}/report`) {
      await route.fulfill({ json: {
        task,
        project: { id: project.id, name: project.name },
        eventCount: events.length,
        observedCommands: [],
        verification: "Mock report; no independent verification implied."
      } });
    } else if (url.pathname === `/v1/projects/${project.id}/diff`) {
      await route.fulfill({ json: { diff: "", truncated: false } });
    } else {
      await route.fulfill({ status: 404, json: { error: "Unexpected mock request" } });
    }
  });

  await page.addInitScript(() => localStorage.setItem("bridgeBase", "https://token-collector.invalid"));
  await page.goto("/");
  const expectedDate = await page.evaluate(() => new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric"
  }).toUpperCase());
  await expect(page.locator(".title-row .eyebrow")).toContainText(expectedDate);
  await page.getByLabel("Bearer token").fill("playwright-local-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText("Bridge connected")).toBeVisible();
  await page.getByLabel("Repository").selectOption(project.id);
  await page.getByLabel("TASK INSTRUCTION").fill(task.prompt);
  await page.getByRole("button", { name: "Run task" }).click();
  await expect(page.getByText(task.prompt, { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Mock agent started in read-only mode")).toBeVisible();
  await page.getByRole("button", { name: "Report" }).click();
  await expect(page.getByText(task.result!)).toBeVisible();
  expect([...authorizedOrigins]).toEqual([new URL(page.url()).origin]);
  await expect(page.getByLabel("Bridge URL")).toHaveCount(0);
});

test("does not forward the bearer token across a cross-origin redirect", async ({ page }) => {
  const externalRequests: string[] = [];
  await page.route("**/v1/projects", route => route.fulfill({
    status: 302,
    headers: { location: "https://token-collector.invalid/steal" }
  }));
  await page.route("**/v1/tasks", route => route.fulfill({ json: { tasks: [] } }));
  await page.goto("/");
  const dashboardOrigin = new URL(page.url()).origin;
  page.on("request", request => {
    if (new URL(request.url()).origin !== dashboardOrigin) externalRequests.push(request.url());
  });
  await page.getByLabel("Bearer token").fill("playwright-local-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator(".error-banner")).toBeVisible();
  expect(externalRequests).toEqual([]);
});
