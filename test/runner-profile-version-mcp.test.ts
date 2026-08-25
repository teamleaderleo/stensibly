import { afterEach, describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { dispatchNextWork } from "../src/dispatcher.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const supervisor = {
  id: "service:profile-version-mcp-supervisor",
  name: "Profile Version MCP Supervisor",
  kind: "service" as const,
};
const runner = {
  id: "agent:profile-version-mcp-runner",
  name: "Profile Version MCP Runner",
  kind: "agent" as const,
};
const exactVersion = "codex-default/2026-08-25";
const protocolVersion = "2025-06-18";
let store: StensiblyStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

describe("runner MCP exact profile version claims", () => {
  test("does not downgrade an exact-version run to a legacy-unknown claim", async () => {
    store = new StensiblyStore(":memory:");
    const item = store.createItem({
      project: "profile-version-mcp",
      kind: "task",
      title: "Claim through the public runner endpoint",
      summary: "The exact runner profile version must survive MCP admission.",
      nextAction: "Claim with the matching exact version.",
      priority: 80,
      actor: supervisor,
    });
    const queued = dispatchNextWork(store, {
      actor: supervisor,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      runnerProfileVersion: exactVersion,
      itemId: item.id,
      leaseSeconds: 300,
      idempotencyKey: "dispatch-profile-version-mcp",
    }, new Date("2026-08-25T12:00:00.000Z"))!;
    const token = createApiToken(store, {
      name: "Exact profile runner",
      scopes: ["read", "write"],
      projects: ["profile-version-mcp"],
    });
    const app = createServerApp(store);

    const unknown = await readToolJson<unknown>(await runnerRequest(
      app,
      token.token,
      toolCall(1, "claim_runner_work", {
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        runnerProfileVersion: null,
        runId: queued.run.id,
      }),
    ));
    expect(unknown).toBeNull();

    const claimed = await readToolJson<{
      run: {
        id: string;
        runnerProfile: string;
        runnerProfileVersion: string | null;
        status: string;
      };
    }>(await runnerRequest(
      app,
      token.token,
      toolCall(2, "claim_runner_work", {
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        runnerProfileVersion: exactVersion,
        runId: queued.run.id,
      }),
    ));
    expect(claimed.run).toMatchObject({
      id: queued.run.id,
      runnerProfile: "codex-default",
      runnerProfileVersion: exactVersion,
      status: "starting",
    });
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
