import { afterEach, describe, expect, test } from "bun:test";
import { getFunctionName, type FunctionReference } from "convex/server";
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

describe("API v1 hosted Project Activity mount", () => {
  test("mounts the mixed project activity read for a Convex ledger", async () => {
    store = new StensiblyStore(":memory:");
    const token = createApiToken(store, {
      name: "Stensibly reader",
      scopes: ["read"],
      projects: ["stensibly"],
    });
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const ledger = new ConvexWorkLedger({
      serviceSecret: "service-secret",
      workspace: "default",
      client: {
        async query(reference: FunctionReference<"query">, args) {
          const name = getFunctionName(reference);
          calls.push({ name, args });
          if (name === "mailCorrespondence:listProjectSources") {
            return {
              rows: [],
              threadsWithoutProviderProjection: 1,
              providerViewsWithoutMailboxState: 0,
              truncated: false,
            };
          }
          if (name === "orchestratorActivity:listRecentObservations") {
            return {
              observations: [],
              truncated: false,
            };
          }
          throw new Error(`unexpected query ${name}`);
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

    const response = await app.request("/projects/stensibly/activity?limit=12", {
      headers: { authorization: `Bearer ${token.token}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.activity).toMatchObject({
      version: "project-activity/v1",
      project: "stensibly",
      entries: [],
      completeness: {
        correspondenceTruncated: false,
        orchestratorTruncated: false,
        omittedEntryCount: 0,
      },
      authorizesOperation: false,
      authorizesMutation: false,
      grantsAuthority: false,
      grantsResponsibility: false,
      grantsApproval: false,
    });
    expect(body.sourceCompleteness).toEqual({
      correspondence: {
        truncated: false,
        threadsWithoutProviderProjection: 1,
        providerViewsWithoutMailboxState: 0,
        rejectedCandidates: 0,
      },
      orchestrator: { truncated: false },
    });
    expect(calls.map((call) => call.name).sort()).toEqual([
      "mailCorrespondence:listProjectSources",
      "orchestratorActivity:listRecentObservations",
    ]);
    for (const call of calls) {
      expect(call.args).toEqual({
        serviceSecret: "service-secret",
        workspace: "default",
        project: "stensibly",
        limit: 12,
      });
    }
  });
});
