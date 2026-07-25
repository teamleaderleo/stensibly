import { describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { dispatchNextWork } from "../src/dispatcher.ts";
import { claimRunnerWork } from "../src/runner-queue.ts";
import { createServerApp } from "../src/server-app.ts";
import { transitionWorkRun, type WorkRun } from "../src/runs.ts";
import { StensiblyStore } from "../src/store.ts";

const supervisor = {
  id: "service:supervisor",
  name: "Supervisor",
  kind: "service" as const,
};
const runnerA = { id: "agent:runner-a", name: "Runner A", kind: "agent" as const };
const runnerB = { id: "agent:runner-b", name: "Runner B", kind: "agent" as const };
const runnerC = { id: "agent:runner-c", name: "Runner C", kind: "agent" as const };
const baseTime = new Date("2026-07-25T12:00:00.000Z");
const protocolVersion = "2025-06-18";

function createItem(store: StensiblyStore, project: string, title: string) {
  return store.createItem({
    project,
    kind: "task",
    title,
    summary: `Execute ${title} without exceeding server capacity.`,
    nextAction: "Claim this through the generic runner.",
    priority: 80,
    actor: supervisor,
  });
}

function dispatch(
  store: StensiblyStore,
  itemId: string,
  idempotencyKey: string,
) {
  return dispatchNextWork(store, {
    actor: supervisor,
    runnerType: "generic-mcp",
    runnerProfile: "default",
    itemId,
    leaseSeconds: 900,
    idempotencyKey,
  }, baseTime)!.run;
}

function finishStartingRun(store: StensiblyStore, run: WorkRun, actor = runnerA): WorkRun {
  const running = transitionWorkRun(store, {
    id: run.id,
    actor,
    command: "run",
    expectedGeneration: run.generation,
    expectedLeaseGeneration: run.leaseGeneration,
    leaseSeconds: 900,
  }, new Date("2026-07-25T12:01:00.000Z"));
  return transitionWorkRun(store, {
    id: running.id,
    actor,
    command: "succeed",
    expectedGeneration: running.generation,
    expectedLeaseGeneration: running.leaseGeneration,
    outcome: "Capacity released.",
  }, new Date("2026-07-25T12:02:00.000Z"));
}

describe("runner concurrency limits", () => {
  test("stops all new claims at the global execution ceiling", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const alpha = dispatch(
        store,
        createItem(store, "alpha", "Alpha work").id,
        "dispatch-alpha",
      );
      dispatch(
        store,
        createItem(store, "beta", "Beta work").id,
        "dispatch-beta",
      );
      dispatch(
        store,
        createItem(store, "gamma", "Gamma work").id,
        "dispatch-gamma",
      );
      const concurrency = { globalLimit: 2, projectLimit: 2 };

      const first = claimRunnerWork(store, {
        actor: runnerA,
        runnerType: "generic-mcp",
        runnerProfile: "default",
        project: "alpha",
        concurrency,
      }, new Date("2026-07-25T12:00:10.000Z"));
      const second = claimRunnerWork(store, {
        actor: runnerB,
        runnerType: "generic-mcp",
        runnerProfile: "default",
        project: "beta",
        concurrency,
      }, new Date("2026-07-25T12:00:20.000Z"));
      expect(first?.id).toBe(alpha.id);
      expect(second).not.toBeNull();

      expect(claimRunnerWork(store, {
        actor: runnerC,
        runnerType: "generic-mcp",
        runnerProfile: "default",
        project: "gamma",
        concurrency,
      }, new Date("2026-07-25T12:00:30.000Z"))).toBeNull();

      finishStartingRun(store, first!, runnerA);
      const third = claimRunnerWork(store, {
        actor: runnerC,
        runnerType: "generic-mcp",
        runnerProfile: "default",
        project: "gamma",
        concurrency,
      }, new Date("2026-07-25T12:02:10.000Z"));
      expect(third).not.toBeNull();
    } finally {
      store.close();
    }
  });

  test("skips saturated projects while preserving capacity elsewhere", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const alphaFirst = dispatch(
        store,
        createItem(store, "alpha", "Alpha first").id,
        "dispatch-alpha-first",
      );
      const alphaSecond = dispatch(
        store,
        createItem(store, "alpha", "Alpha second").id,
        "dispatch-alpha-second",
      );
      const beta = dispatch(
        store,
        createItem(store, "beta", "Beta work").id,
        "dispatch-beta",
      );
      const concurrency = { globalLimit: 3, projectLimit: 1 };

      const first = claimRunnerWork(store, {
        actor: runnerA,
        runnerType: "generic-mcp",
        runnerProfile: "default",
        project: "alpha",
        runId: alphaFirst.id,
        concurrency,
      }, new Date("2026-07-25T12:00:10.000Z"));
      expect(first?.id).toBe(alphaFirst.id);

      const nextAvailableProject = claimRunnerWork(store, {
        actor: runnerB,
        runnerType: "generic-mcp",
        runnerProfile: "default",
        concurrency,
      }, new Date("2026-07-25T12:00:20.000Z"));
      expect(nextAvailableProject?.id).toBe(beta.id);

      expect(claimRunnerWork(store, {
        actor: runnerC,
        runnerType: "generic-mcp",
        runnerProfile: "default",
        runId: alphaSecond.id,
        concurrency,
      }, new Date("2026-07-25T12:00:30.000Z"))).toBeNull();

      finishStartingRun(store, first!, runnerA);
      const exactAfterRelease = claimRunnerWork(store, {
        actor: runnerC,
        runnerType: "generic-mcp",
        runnerProfile: "default",
        runId: alphaSecond.id,
        concurrency,
      }, new Date("2026-07-25T12:02:10.000Z"));
      expect(exactAfterRelease?.id).toBe(alphaSecond.id);
    } finally {
      store.close();
    }
  });

  test("keeps concurrency server-owned on the remote runner endpoint", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      dispatch(
        store,
        createItem(store, "alpha", "First remote work").id,
        "dispatch-remote-first",
      );
      dispatch(
        store,
        createItem(store, "beta", "Second remote work").id,
        "dispatch-remote-second",
      );
      const token = createApiToken(store, {
        name: "Workspace runner",
        scopes: ["read", "write"],
        projects: null,
      });
      const app = createServerApp(store, {
        runnerMcp: {
          concurrency: { globalLimit: 1, projectLimit: 1 },
        },
      });

      const first = await readToolJson<{ run: { id: string } } | null>(
        await runnerRequest(app, token.token, toolCall(1, "claim_runner_work", {
          actor: runnerA,
          runnerType: "generic-mcp",
          runnerProfile: "default",
          project: "alpha",
        })),
      );
      expect(first?.run.id).toBeTruthy();

      const attemptedOverride = await readToolJson<unknown>(
        await runnerRequest(app, token.token, toolCall(2, "claim_runner_work", {
          actor: runnerB,
          runnerType: "generic-mcp",
          runnerProfile: "default",
          project: "beta",
          concurrency: { globalLimit: 999, projectLimit: 999 },
        })),
      );
      expect(attemptedOverride).toBeNull();
    } finally {
      store.close();
    }
  });

  test("rejects invalid configured limits at server construction", () => {
    const store = new StensiblyStore(":memory:");
    try {
      expect(() => createServerApp(store, {
        runnerMcp: { concurrency: { globalLimit: 0, projectLimit: 1 } },
      })).toThrow("Global runner concurrency limit must be a whole number from 1 to 1000");
      expect(() => createServerApp(store, {
        runnerMcp: { concurrency: { globalLimit: 1, projectLimit: 1.5 } },
      })).toThrow("Project runner concurrency limit must be a whole number from 1 to 1000");
    } finally {
      store.close();
    }
  });
});

async function runnerRequest(
  app: ReturnType<typeof createServerApp>,
  token: string,
  body: unknown,
): Promise<Response> {
  return app.request("/runner/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion,
    },
    body: JSON.stringify(body),
  });
}

function toolCall(id: number, name: string, args: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

async function readToolJson<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  const body = await response.json() as {
    result?: { content?: Array<{ type?: unknown; text?: unknown }> };
  };
  const first = body.result?.content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("Runner MCP response did not contain JSON text");
  }
  return JSON.parse(first.text) as T;
}
