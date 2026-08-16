import { afterEach, describe, expect, test } from "bun:test";
import { createApiV1 } from "../src/api-v1.ts";
import { createApiToken } from "../src/auth.ts";
import { ConvexWorkLedger } from "../src/convex-ledger.ts";
import { SqliteTokenProvider } from "../src/sqlite-token-provider.ts";
import { StensiblyStore } from "../src/store.ts";

let store: StensiblyStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

describe("API v1 hosted correspondence mount", () => {
  test("mounts the project correspondence read for a Convex ledger", async () => {
    store = new StensiblyStore(":memory:");
    const token = createApiToken(store, {
      name: "Stensibly reader",
      scopes: ["read"],
      projects: ["stensibly"],
    });
    const calls: Record<string, unknown>[] = [];
    const ledger = new ConvexWorkLedger({
      serviceSecret: "service-secret",
      workspace: "default",
      client: {
        async query(_reference, args) {
          calls.push(args);
          return {
            rows: [],
            threadsWithoutProviderProjection: 0,
            providerViewsWithoutMailboxState: 0,
            truncated: false,
          };
        },
        async mutation() {
          throw new Error("unexpected mutation");
        },
      },
    });
    const app = createApiV1(
      new SqliteTokenProvider(store),
      ledger,
      { required: true },
    );

    const response = await app.request("/projects/stensibly/correspondence?limit=12", {
      headers: { authorization: `Bearer ${token.token}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.correspondence).toMatchObject({
      version: "project-correspondence/v1",
      project: "stensibly",
      rows: [],
      authorizesOperation: false,
      authorizesMutation: false,
    });
    expect(calls).toEqual([{
      serviceSecret: "service-secret",
      workspace: "default",
      project: "stensibly",
      limit: 12,
    }]);
  });
});
