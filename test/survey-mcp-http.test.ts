import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };
const protocolVersion = "2025-06-18";

let store: StensiblyStore;
let app: ReturnType<typeof createServerApp>;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  store.createItem({
    project: "smolrunner",
    kind: "task",
    title: "Ready runner work",
    priority: 80,
    actor: leo,
  });
  store.createItem({
    project: "renderprove",
    kind: "task",
    title: "Ready browser work",
    priority: 70,
    actor: leo,
  });
  app = createServerApp(store);
});

afterEach(() => store.close());

describe("remote workspace survey", () => {
  test("allows an all-project read token to survey the workspace", async () => {
    const token = createApiToken(store, {
      name: "Workspace surveyor",
      scopes: ["read"],
    });

    const response = await mcpRequest(token.token, toolCall(1, "survey_workspace", {}));
    expect(response.status).toBe(200);
    const survey = await readToolJson<{
      counts: { total: number };
      projects: Array<{ project: string }>;
      fingerprint: string;
    }>(response);
    expect(survey.counts.total).toBe(2);
    expect(survey.projects.map((entry) => entry.project)).toEqual([
      "renderprove",
      "smolrunner",
    ]);
    expect(survey.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("requires project scope when a token has a project allowlist", async () => {
    const token = createApiToken(store, {
      name: "SmolRunner surveyor",
      scopes: ["read"],
      projects: ["smolrunner"],
    });

    const missingProject = await mcpRequest(
      token.token,
      toolCall(2, "survey_workspace", {}),
    );
    expect(missingProject.status).toBe(400);

    const allowed = await mcpRequest(token.token, toolCall(3, "survey_workspace", {
      project: "smolrunner",
    }));
    expect(allowed.status).toBe(200);
    const survey = await readToolJson<{
      counts: { total: number };
      projects: Array<{ project: string }>;
    }>(allowed);
    expect(survey.counts.total).toBe(1);
    expect(survey.projects.map((entry) => entry.project)).toEqual(["smolrunner"]);

    const denied = await mcpRequest(token.token, toolCall(4, "survey_workspace", {
      project: "renderprove",
    }));
    expect(denied.status).toBe(403);
  });
});

async function mcpRequest(token: string, body: unknown): Promise<Response> {
  return await app.request("/mcp", {
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
  const body = await response.json() as {
    result?: { content?: Array<{ type?: unknown; text?: unknown }> };
  };
  const first = body.result?.content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("Remote MCP response did not contain JSON text");
  }
  return JSON.parse(first.text) as T;
}
