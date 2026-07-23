import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

let store: StensiblyStore;
let app: ReturnType<typeof createServerApp>;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  app = createServerApp(store, {
    corsOrigins: ["https://stensibly.app"],
  });
});

afterEach(() => {
  store.close();
});

describe("dashboard CORS", () => {
  test("answers approved API preflights", async () => {
    const response = await app.request("/api/items", {
      method: "OPTIONS",
      headers: {
        origin: "https://stensibly.app",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://stensibly.app",
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "Authorization",
    );
  });

  test("adds CORS headers to approved API reads", async () => {
    const response = await app.request("/api/items", {
      headers: { origin: "https://stensibly.app" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://stensibly.app",
    );
  });

  test("rejects unknown API origins without changing MCP routing", async () => {
    const denied = await app.request("/api/items", {
      headers: { origin: "https://somewhere-else.example" },
    });
    expect(denied.status).toBe(403);

    const mcp = await app.request("/mcp", {
      method: "GET",
      headers: { origin: "https://somewhere-else.example" },
    });
    expect(mcp.status).toBe(405);
  });
});
