import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { dispatchNextWork } from "../src/dispatcher.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const supervisor = { id: "service:supervisor", name: "Supervisor", kind: "service" as const };
const runner = { id: "agent:generic-runner", name: "Generic Runner", kind: "agent" as const };
const protocolVersion = "2025-06-18";

let store: StensiblyStore;
let app: ReturnType<typeof createServerApp>;
let alphaRunId: string;
let secretRunId: string;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  const alpha = createItem("alpha", "Run alpha work");
  const secret = createItem("secret", "Run secret work");
  alphaRunId = dispatch(alpha.id, "dispatch-alpha");
  secretRunId = dispatch(secret.id, "dispatch-secret");
  app = createServerApp(store);
});

afterEach(() => store.close());

describe("generic runner MCP endpoint", () => {
  test("claims context, advances the run, heartbeats, and finishes", async () => {
    const token = createApiToken(store, {
      name: "Alpha runner",
      scopes: ["read", "write"],
      projects: ["alpha"],
    });

    const claimedResponse = await runnerRequest(token.token, toolCall(1, "claim_runner_work", {
      actor: runner,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      project: "alpha",
      externalRunId: "mcp-session-alpha",
      leaseSeconds: 600,
      idempotencyKey: "claim-alpha",
    }));
    expect(claimedResponse.status).toBe(200);
    const claimed = await readToolJson<{
      run: {
        id: string;
        status: string;
        generation: number;
        leaseGeneration: number;
        leaseOwnerId: string;
      };
      item: { project: string; claimedBy: string };
      context: { item: { id: string }; characterCount: number };
    }>(claimedResponse);
    expect(claimed.run).toMatchObject({
      id: alphaRunId,
      status: "starting",
      leaseOwnerId: runner.id,
    });
    expect(claimed.item).toMatchObject({ project: "alpha", claimedBy: runner.id });
    expect(claimed.context.item.id).toBe(claimed.context.item.id);
    expect(claimed.context.characterCount).toBeGreaterThan(0);

    const running = await readToolJson<{
      status: string;
      generation: number;
      leaseGeneration: number;
    }>(await runnerRequest(token.token, toolCall(2, "transition_runner_run", {
      id: claimed.run.id,
      actor: runner,
      command: "run",
      expectedGeneration: claimed.run.generation,
      expectedLeaseGeneration: claimed.run.leaseGeneration,
      leaseSeconds: 600,
      idempotencyKey: "run-alpha",
    })));
    expect(running.status).toBe("running");

    const heartbeat = await readToolJson<{
      status: string;
      generation: number;
      checkpoint: string;
      usage: { toolCalls: number };
    }>(await runnerRequest(token.token, toolCall(3, "heartbeat_runner_run", {
      id: claimed.run.id,
      actor: runner,
      expectedGeneration: running.generation,
      expectedLeaseGeneration: running.leaseGeneration,
      leaseSeconds: 600,
      checkpoint: "Repository inspected and implementation underway.",
      usage: { toolCalls: 4 },
      idempotencyKey: "heartbeat-alpha",
    })));
    expect(heartbeat).toMatchObject({
      status: "running",
      generation: running.generation,
      checkpoint: "Repository inspected and implementation underway.",
      usage: { toolCalls: 4 },
    });

    const succeeded = await readToolJson<{ status: string; outcome: string }>(
      await runnerRequest(token.token, toolCall(4, "transition_runner_run", {
        id: claimed.run.id,
        actor: runner,
        command: "succeed",
        expectedGeneration: running.generation,
        expectedLeaseGeneration: running.leaseGeneration,
        outcome: "Runner protocol completed successfully.",
        idempotencyKey: "succeed-alpha",
      })),
    );
    expect(succeeded).toMatchObject({
      status: "succeeded",
      outcome: "Runner protocol completed successfully.",
    });

    const readBack = await readToolJson<{ id: string; status: string }>(
      await runnerRequest(token.token, toolCall(5, "get_runner_run", { id: alphaRunId })),
    );
    expect(readBack).toMatchObject({ id: alphaRunId, status: "succeeded" });
  });

  test("enforces runner scopes and project allowlists before dispatch", async () => {
    const reader = createApiToken(store, {
      name: "Alpha reader",
      scopes: ["read"],
      projects: ["alpha"],
    });
    const deniedScope = await runnerRequest(reader.token, toolCall(10, "claim_runner_work", {
      actor: runner,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      project: "alpha",
    }));
    expect(deniedScope.status).toBe(403);

    const alpha = createApiToken(store, {
      name: "Alpha runner",
      scopes: ["read", "write"],
      projects: ["alpha"],
    });
    const missingProject = await runnerRequest(alpha.token, toolCall(11, "claim_runner_work", {
      actor: runner,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
    }));
    expect(missingProject.status).toBe(400);

    const deniedProject = await runnerRequest(alpha.token, toolCall(12, "claim_runner_work", {
      actor: runner,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      project: "secret",
    }));
    expect(deniedProject.status).toBe(403);

    const deniedRead = await runnerRequest(alpha.token, toolCall(13, "get_runner_run", {
      id: secretRunId,
    }));
    expect(deniedRead.status).toBe(403);
  });

  test("lists only runs in the authorized project", async () => {
    const token = createApiToken(store, {
      name: "Alpha runner",
      scopes: ["read", "write"],
      projects: ["alpha"],
    });
    const listed = await readToolJson<Array<{ id: string; itemId: string }>>(
      await runnerRequest(token.token, toolCall(20, "list_runner_runs", {
        project: "alpha",
      })),
    );
    expect(listed.map((run) => run.id)).toEqual([alphaRunId]);
    expect(listed.map((run) => run.id)).not.toContain(secretRunId);
  });
});

function createItem(project: string, title: string) {
  return store.createItem({
    project,
    kind: "task",
    title,
    summary: `Canonical context for ${project}.`,
    nextAction: "Claim this through the runner endpoint.",
    priority: 80,
    actor: supervisor,
  });
}

function dispatch(itemId: string, idempotencyKey: string): string {
  return dispatchNextWork(store, {
    actor: supervisor,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    itemId,
    leaseSeconds: 300,
    idempotencyKey,
  })!.run.id;
}

async function runnerRequest(token: string, body: unknown): Promise<Response> {
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
