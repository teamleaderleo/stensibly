import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };
const agent = { id: "agent", name: "Agent", kind: "agent" as const };

let store: StensiblyStore;
let app: ReturnType<typeof createServerApp>;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  app = createServerApp(store);
});

afterEach(() => store.close());

describe("REST API v1", () => {
  test("runs the work lifecycle through the async ledger", async () => {
    const created = await json<{ item: { id: string; status: string } }>(app.request("/api/v1/items", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "v1-create" },
      body: JSON.stringify({
        project: "scrapbook",
        kind: "task",
        title: "Exercise API v1",
        nextAction: "Claim it.",
        actor: leo,
      }),
    }), 201);
    expect(created.item.status).toBe("ready");

    const claimed = await json<{ item: { status: string; claimedBy: string } }>(app.request(
      `/api/v1/items/${encodeURIComponent(created.item.id)}/claim`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: agent, leaseSeconds: 900 }),
      },
    ));
    expect(claimed.item).toMatchObject({ status: "active", claimedBy: agent.id });

    const artifact = await json<{ artifact: { kind: string; uri: string } }>(app.request(
      `/api/v1/items/${encodeURIComponent(created.item.id)}/artifacts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actor: agent,
          kind: "commit",
          label: "API v1 commit",
          uri: "git:repo@v1",
          metadata: { sha: "v1" },
        }),
      },
    ), 201);
    expect(artifact.artifact).toMatchObject({ kind: "commit", uri: "git:repo@v1" });

    const completed = await json<{ item: { status: string; summary: string } }>(app.request(
      `/api/v1/items/${encodeURIComponent(created.item.id)}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: agent, summary: "The versioned API works." }),
      },
    ));
    expect(completed.item).toMatchObject({ status: "done", summary: "The versioned API works." });

    const detail = await json<{
      item: { status: string };
      events: Array<{ type: string }>;
      artifacts: Array<{ kind: string }>;
    }>(app.request(`/api/v1/items/${encodeURIComponent(created.item.id)}`));
    expect(detail.item.status).toBe("done");
    expect(detail.artifacts).toEqual([expect.objectContaining({ kind: "commit" })]);
    expect(detail.events.map((event) => event.type)).toContain("item.completed");

    const legacy = await json<{ items: Array<{ id: string }> }>(app.request("/api/items"));
    expect(legacy.items.map((item) => item.id)).toContain(created.item.id);
  });

  test("returns stable request and conflict codes", async () => {
    const invalid = await app.request("/api/v1/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "Bad Project", title: "No" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "invalid_request" });

    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Compete for this",
      priority: 50,
      actor: leo,
    });
    await app.request(`/api/v1/items/${item.id}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: agent, leaseSeconds: 900 }),
    });
    const conflict = await app.request(`/api/v1/items/${item.id}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: leo, leaseSeconds: 900 }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "conflict" });
  });

  test("filters and rejects project access with scoped tokens", async () => {
    store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Visible",
      priority: 50,
      actor: leo,
    });
    store.createItem({
      project: "secret",
      kind: "task",
      title: "Hidden",
      priority: 50,
      actor: leo,
    });
    const token = createApiToken(store, {
      name: "Scoped reader",
      scopes: ["read"],
      projects: ["scrapbook"],
    });
    app = createServerApp(store, { httpAuth: { required: true } });

    const listed = await json<{ items: Array<{ project: string }> }>(app.request("/api/v1/items", {
      headers: bearer(token.token),
    }));
    expect(listed.items.map((item) => item.project)).toEqual(["scrapbook"]);

    const denied = await app.request("/api/v1/items?project=secret", {
      headers: bearer(token.token),
    });
    expect(denied.status).toBe(403);
  });
});

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function json<T>(responsePromise: Promise<Response>, expectedStatus = 200): Promise<T> {
  const response = await responsePromise;
  const body = await response.json() as T;
  expect(response.status).toBe(expectedStatus);
  return body;
}
