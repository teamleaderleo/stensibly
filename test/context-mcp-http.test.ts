import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";
import { mcpRequest, readToolJson, toolCall } from "./support/mcp-http.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };

let store: StensiblyStore;
let app: ReturnType<typeof createServerApp>;
let visibleItemId: string;
let hiddenItemId: string;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  visibleItemId = store.createItem({
    project: "studio",
    kind: "task",
    title: "Visible runner context",
    nextAction: "Continue safely.",
    priority: 50,
    actor: leo,
  }).id;
  hiddenItemId = store.createItem({
    project: "secret",
    kind: "task",
    title: "Hidden runner context",
    nextAction: "Keep this private.",
    priority: 50,
    actor: leo,
  }).id;
  app = createServerApp(store);
});

afterEach(() => store.close());

describe("runner context remote MCP", () => {
  test("returns a packet for an allowed item", async () => {
    const token = createApiToken(store, {
      name: "Studio reader",
      scopes: ["read"],
      projects: ["studio"],
    });
    const response = await mcpRequest(
      app,
      token.token,
      toolCall(1, "get_runner_context", {
        id: visibleItemId,
        maxCharacters: 3_000,
      }),
    );
    expect(response.status).toBe(200);
    const packet = await readToolJson<{ item: { id: string; project: string } }>(response);
    expect(packet.item).toMatchObject({ id: visibleItemId, project: "studio" });
  });

  test("requires read scope and the item's project", async () => {
    const reader = createApiToken(store, {
      name: "Studio reader",
      scopes: ["read"],
      projects: ["studio"],
    });
    const deniedProject = await mcpRequest(
      app,
      reader.token,
      toolCall(2, "get_runner_context", { id: hiddenItemId }),
    );
    expect(deniedProject.status).toBe(403);

    const writer = createApiToken(store, {
      name: "Write-only runner",
      scopes: ["write"],
      projects: ["studio"],
    });
    const deniedScope = await mcpRequest(
      app,
      writer.token,
      toolCall(3, "get_runner_context", { id: visibleItemId }),
    );
    expect(deniedScope.status).toBe(403);
  });
});
