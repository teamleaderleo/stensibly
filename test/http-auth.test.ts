import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { createApiToken } from "../src/auth.ts";
import { StensiblyStore } from "../src/store.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };

let store: StensiblyStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  store.createItem({
    project: "scrapbook",
    kind: "task",
    title: "Visible scrapbook work",
    nextAction: "Read this through the scoped token.",
    priority: 60,
    actor: leo,
  });
  store.createItem({
    project: "elsewhere",
    kind: "task",
    title: "Hidden elsewhere work",
    nextAction: "Keep this out of scrapbook responses.",
    priority: 70,
    actor: leo,
  });
  app = createApp(store, { required: true });
});

afterEach(() => {
  store.close();
});

describe("HTTP API authentication", () => {
  test("keeps health public and requires a valid Bearer token elsewhere", async () => {
    expect((await app.request("/health")).status).toBe(200);

    const missing = await app.request("/api/items");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");

    const invalid = await app.request("/api/items", {
      headers: { authorization: "Bearer stn.invalid.token" },
    });
    expect(invalid.status).toBe(401);

    const board = await app.request("/");
    expect(board.status).toBe(401);
  });

  test("filters collection reads to allowed projects", async () => {
    const token = createApiToken(store, {
      name: "Scrapbook reader",
      scopes: ["read"],
      projects: ["scrapbook"],
    });

    const response = await app.request("/api/items", {
      headers: bearer(token.token),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      items: Array<{ project: string; title: string }>;
    };
    expect(body.items).toEqual([
      expect.objectContaining({
        project: "scrapbook",
        title: "Visible scrapbook work",
      }),
    ]);

    const deniedProject = await app.request("/api/items?project=elsewhere", {
      headers: bearer(token.token),
    });
    expect(deniedProject.status).toBe(403);

    const board = await app.request("/", { headers: bearer(token.token) });
    expect(board.status).toBe(200);
    const html = await board.text();
    expect(html).toContain("Visible scrapbook work");
    expect(html).not.toContain("Hidden elsewhere work");
  });

  test("read-only tokens cannot write", async () => {
    const token = createApiToken(store, {
      name: "Observer",
      scopes: ["read"],
      projects: ["scrapbook"],
    });

    const response = await app.request("/api/items", {
      method: "POST",
      headers: {
        ...bearer(token.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        project: "scrapbook",
        kind: "task",
        title: "Attempted write",
        actor: leo,
      }),
    });
    expect(response.status).toBe(403);
  });

  test("read-write tokens stay inside their project allowlist", async () => {
    const token = createApiToken(store, {
      name: "Scrapbook worker",
      scopes: ["read", "write"],
      projects: ["scrapbook"],
    });

    const allowed = await createItem(token.token, "scrapbook", "Allowed write");
    expect(allowed.status).toBe(201);

    const denied = await createItem(token.token, "elsewhere", "Denied write");
    expect(denied.status).toBe(403);
  });

  test("all-project tokens can read every project", async () => {
    const token = createApiToken(store, {
      name: "Global reader",
      scopes: ["read"],
      projects: null,
    });

    const response = await app.request("/api/items", {
      headers: bearer(token.token),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ project: string }> };
    expect(body.items.map((item) => item.project).sort()).toEqual([
      "elsewhere",
      "scrapbook",
    ]);
  });
});

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function createItem(token: string, project: string, title: string): Promise<Response> {
  return await app.request("/api/items", {
    method: "POST",
    headers: {
      ...bearer(token),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      project,
      kind: "task",
      title,
      actor: leo,
    }),
  });
}
