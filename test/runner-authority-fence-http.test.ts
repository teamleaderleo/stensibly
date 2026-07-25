import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { dispatchNextWork } from "../src/dispatcher.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const supervisor = { id: "service:supervisor", name: "Supervisor", kind: "service" as const };
const runner = { id: "agent:fenced-runner", name: "Fenced Runner", kind: "agent" as const };
const protocolVersion = "2025-06-18";

let store: StensiblyStore;
let app: ReturnType<typeof createServerApp>;
let runId: string;
let token: string;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  const item = store.createItem({
    project: "alpha",
    kind: "task",
    title: "Exercise the runner authority boundary",
    summary: "A runner may act only under its current lease generation.",
    nextAction: "Claim, block, and attempt a stale authority transition.",
    priority: 90,
    actor: supervisor,
  });
  runId = dispatchNextWork(store, {
    actor: supervisor,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    itemId: item.id,
    leaseSeconds: 300,
    idempotencyKey: "dispatch-fence-test",
  })!.run.id;
  token = createApiToken(store, {
    name: "Fenced runner",
    scopes: ["read", "write"],
    projects: ["alpha"],
  }).token;
  app = createServerApp(store);
});

afterEach(() => store.close());

describe("runner MCP authority fencing", () => {
  test("returns an explicit fence and excludes authority-acquiring transitions", async () => {
    const listed = await runnerRequest(rpc(1, "tools/list"));
    expect(listed.status).toBe(200);
    const body = await listed.json() as {
      result?: {
        tools?: Array<{
          name?: unknown;
          inputSchema?: { properties?: { command?: { enum?: unknown[] } } };
        }>;
      };
    };
    const transition = body.result?.tools?.find((tool) => tool.name === "transition_runner_run");
    expect(transition?.inputSchema?.properties?.command?.enum).toEqual([
      "start",
      "run",
      "wait",
      "block",
      "resume",
      "succeed",
      "fail",
    ]);

    const claimed = await readToolJson<{
      run: {
        id: string;
        generation: number;
        leaseGeneration: number;
        leaseOwnerId: string;
        leaseExpiresAt: string;
      };
      authorityFence: {
        resource: string;
        holderId: string;
        generation: number;
        expiresAt: string;
      };
    }>(await runnerRequest(toolCall(2, "claim_runner_work", {
      actor: runner,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      runId,
      leaseSeconds: 600,
      idempotencyKey: "claim-fence-test",
    })));

    expect(claimed.authorityFence).toEqual({
      resource: `run:${runId}`,
      holderId: runner.id,
      generation: claimed.run.leaseGeneration,
      expiresAt: claimed.run.leaseExpiresAt,
    });
  });

  test("does not let a runner reacquire or finish after releasing its authority", async () => {
    const claimed = await readToolJson<{
      run: { id: string; generation: number; leaseGeneration: number };
    }>(await runnerRequest(toolCall(10, "claim_runner_work", {
      actor: runner,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      runId,
      leaseSeconds: 600,
      idempotencyKey: "claim-blocked-fence-test",
    })));

    const running = await readToolJson<{
      generation: number;
      leaseGeneration: number;
    }>(await runnerRequest(toolCall(11, "transition_runner_run", {
      id: runId,
      actor: runner,
      command: "run",
      expectedGeneration: claimed.run.generation,
      expectedLeaseGeneration: claimed.run.leaseGeneration,
      leaseSeconds: 600,
      idempotencyKey: "run-blocked-fence-test",
    })));

    const blocked = await readToolJson<{
      generation: number;
      leaseGeneration: number;
      status: string;
      leaseOwnerId: null;
      leaseExpiresAt: null;
    }>(await runnerRequest(toolCall(12, "transition_runner_run", {
      id: runId,
      actor: runner,
      command: "block",
      expectedGeneration: running.generation,
      expectedLeaseGeneration: running.leaseGeneration,
      checkpoint: "Waiting for server-owned reassignment.",
      idempotencyKey: "block-fence-test",
    })));
    expect(blocked).toMatchObject({
      status: "blocked",
      leaseOwnerId: null,
      leaseExpiresAt: null,
    });

    for (const [id, command] of [[13, "resume"], [14, "succeed"], [15, "fail"]] as const) {
      const error = await readToolError(await runnerRequest(toolCall(id, "transition_runner_run", {
        id: runId,
        actor: runner,
        command,
        expectedGeneration: blocked.generation,
        expectedLeaseGeneration: blocked.leaseGeneration,
        leaseSeconds: 600,
        idempotencyKey: `blocked-${command}-fence-test`,
      })));
      expect(error).toContain("server-owned scheduling must reassign it");
    }
  });
});

async function runnerRequest(body: unknown): Promise<Response> {
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

function rpc(id: number, method: string, params?: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params ? { params } : {}),
  };
}

function toolCall(id: number, name: string, args: Record<string, unknown>) {
  return rpc(id, "tools/call", { name, arguments: args });
}

async function readToolJson<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  const body = await response.json() as {
    result?: { content?: Array<{ type?: unknown; text?: unknown }>; isError?: boolean };
  };
  expect(body.result?.isError).not.toBe(true);
  const first = body.result?.content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("Runner MCP response did not contain JSON text");
  }
  return JSON.parse(first.text) as T;
}

async function readToolError(response: Response): Promise<string> {
  expect(response.status).toBe(200);
  const body = await response.json() as {
    result?: { content?: Array<{ type?: unknown; text?: unknown }>; isError?: boolean };
  };
  expect(body.result?.isError).toBe(true);
  const first = body.result?.content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("Runner MCP error did not contain text");
  }
  return first.text;
}
