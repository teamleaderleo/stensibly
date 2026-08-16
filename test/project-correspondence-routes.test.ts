import { afterEach, describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.ts";
import { createProjectCorrespondenceApi } from "../src/project-correspondence-routes.ts";
import type { ProjectCorrespondenceSourceV1 } from "../src/project-correspondence.ts";
import { SqliteTokenProvider } from "../src/sqlite-token-provider.ts";
import { StensiblyStore } from "../src/store.ts";

let store: StensiblyStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

describe("project correspondence HTTP read", () => {
  test("requires project read authority before calling the source", async () => {
    store = new StensiblyStore(":memory:");
    const token = createApiToken(store, {
      name: "Scrapbook reader",
      scopes: ["read"],
      projects: ["scrapbook"],
    });
    let sourceCalls = 0;
    const source: ProjectCorrespondenceSourceV1 = {
      async listProject() {
        sourceCalls += 1;
        return {
          candidates: [],
          threadsWithoutProviderProjection: 0,
          providerViewsWithoutMailboxState: 0,
          truncated: false,
        };
      },
    };
    const app = createProjectCorrespondenceApi(
      new SqliteTokenProvider(store),
      { required: true },
      source,
      () => Date.parse("2026-08-16T05:20:00.000Z"),
    );

    const denied = await app.request("/projects/stensibly/correspondence", {
      headers: { authorization: `Bearer ${token.token}` },
    });
    expect(denied.status).toBe(403);
    expect(sourceCalls).toBe(0);
  });

  test("returns a bounded zero-authority project envelope to an authorized reader", async () => {
    store = new StensiblyStore(":memory:");
    const token = createApiToken(store, {
      name: "Stensibly reader",
      scopes: ["read"],
      projects: ["stensibly"],
    });
    const source: ProjectCorrespondenceSourceV1 = {
      async listProject() {
        return {
          candidates: [],
          threadsWithoutProviderProjection: 2,
          providerViewsWithoutMailboxState: 1,
          truncated: true,
        };
      },
    };
    const app = createProjectCorrespondenceApi(
      new SqliteTokenProvider(store),
      { required: true },
      source,
      () => Date.parse("2026-08-16T05:20:00.000Z"),
    );

    const response = await app.request("/projects/stensibly/correspondence?limit=12", {
      headers: { authorization: `Bearer ${token.token}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.correspondence).toMatchObject({
      version: "project-correspondence/v1",
      project: "stensibly",
      asOf: "2026-08-16T05:20:00.000Z",
      rows: [],
      completeness: {
        truncated: true,
        threadsWithoutProviderProjection: 2,
        providerViewsWithoutMailboxState: 1,
        rejectedCandidates: 0,
      },
      authorizesOperation: false,
      authorizesMutation: false,
      grantsAuthority: false,
      grantsResponsibility: false,
      grantsApproval: false,
    });
  });

  test("rejects an oversized window before source work", async () => {
    store = new StensiblyStore(":memory:");
    const token = createApiToken(store, {
      name: "Stensibly reader",
      scopes: ["read"],
      projects: ["stensibly"],
    });
    let sourceCalls = 0;
    const source: ProjectCorrespondenceSourceV1 = {
      async listProject() {
        sourceCalls += 1;
        throw new Error("should not run");
      },
    };
    const app = createProjectCorrespondenceApi(
      new SqliteTokenProvider(store),
      { required: true },
      source,
    );

    const response = await app.request("/projects/stensibly/correspondence?limit=51", {
      headers: { authorization: `Bearer ${token.token}` },
    });
    expect(response.status).toBe(400);
    expect(sourceCalls).toBe(0);
  });
});
