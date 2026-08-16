import { afterEach, describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth.js";
import type {
  ProjectActivityOrchestratorSourceV1,
} from "../src/convex-project-activity-source.js";
import { compileOrchestratorActivityObservation } from "../src/orchestrator-activity-observation.js";
import { createProjectActivityApi } from "../src/project-activity-routes.js";
import type { ProjectCorrespondenceSourceV1 } from "../src/project-correspondence.js";
import { SqliteTokenProvider } from "../src/sqlite-token-provider.js";
import { StensiblyStore } from "../src/store.js";

let store: StensiblyStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

function emptyCorrespondence(
  counters?: { calls: number },
): ProjectCorrespondenceSourceV1 {
  return {
    async listProject() {
      if (counters) counters.calls += 1;
      return {
        candidates: [],
        threadsWithoutProviderProjection: 2,
        providerViewsWithoutMailboxState: 1,
        truncated: true,
      };
    },
  };
}

function orchestrator(
  counters?: { calls: number },
): ProjectActivityOrchestratorSourceV1 {
  const observation = compileOrchestratorActivityObservation({
    workspace: "default",
    project: "stensibly",
    actorId: "agent_keel",
    sourceClass: "ledger_event",
    sourceId: "evt_route_activity",
    sourceFingerprint: `sha256:${"a".repeat(64)}`,
    observedAt: "2026-08-16T10:20:00.000Z",
    activityClass: "handoff",
    activityState: "observed",
    workItemId: "issue:1586",
    relatedEvidenceIds: ["evt_route_activity"],
  });
  return {
    async listRecent() {
      if (counters) counters.calls += 1;
      return {
        orchestrator: Object.freeze([observation]),
        orchestratorTruncated: true,
      };
    },
  };
}

describe("Project Activity HTTP read", () => {
  test("requires project read authority before either source is called", async () => {
    store = new StensiblyStore(":memory:");
    const token = createApiToken(store, {
      name: "Scrapbook reader",
      scopes: ["read"],
      projects: ["scrapbook"],
    });
    const correspondenceCalls = { calls: 0 };
    const orchestratorCalls = { calls: 0 };
    const app = createProjectActivityApi(
      new SqliteTokenProvider(store),
      { required: true },
      emptyCorrespondence(correspondenceCalls),
      orchestrator(orchestratorCalls),
      () => Date.parse("2026-08-16T10:30:00.000Z"),
    );

    const denied = await app.request("/projects/stensibly/activity", {
      headers: { authorization: `Bearer ${token.token}` },
    });
    expect(denied.status).toBe(403);
    expect(correspondenceCalls.calls).toBe(0);
    expect(orchestratorCalls.calls).toBe(0);
  });

  test("returns one bounded mixed projection and preserves source completeness", async () => {
    store = new StensiblyStore(":memory:");
    const token = createApiToken(store, {
      name: "Stensibly reader",
      scopes: ["read"],
      projects: ["stensibly"],
    });
    const app = createProjectActivityApi(
      new SqliteTokenProvider(store),
      { required: true },
      emptyCorrespondence(),
      orchestrator(),
      () => Date.parse("2026-08-16T10:30:00.000Z"),
    );

    const response = await app.request("/projects/stensibly/activity?limit=12", {
      headers: { authorization: `Bearer ${token.token}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.activity).toMatchObject({
      version: "project-activity/v1",
      project: "stensibly",
      asOf: "2026-08-16T10:30:00.000Z",
      completeness: {
        correspondenceTruncated: true,
        orchestratorTruncated: true,
        omittedEntryCount: 0,
      },
      authorizesOperation: false,
      authorizesMutation: false,
      grantsAuthority: false,
      grantsResponsibility: false,
      grantsApproval: false,
    });
    expect(body.activity.entries).toHaveLength(1);
    expect(body.activity.entries[0]).toMatchObject({
      sourceClass: "orchestrator_activity",
      activityClass: "handoff",
      actorId: "agent_keel",
      workItemId: "issue:1586",
    });
    expect(body.sourceCompleteness).toEqual({
      correspondence: {
        truncated: true,
        threadsWithoutProviderProjection: 2,
        providerViewsWithoutMailboxState: 1,
        rejectedCandidates: 0,
      },
      orchestrator: { truncated: true },
    });
  });

  test("rejects an oversized window before either source is called", async () => {
    store = new StensiblyStore(":memory:");
    const token = createApiToken(store, {
      name: "Stensibly reader",
      scopes: ["read"],
      projects: ["stensibly"],
    });
    const correspondenceCalls = { calls: 0 };
    const orchestratorCalls = { calls: 0 };
    const app = createProjectActivityApi(
      new SqliteTokenProvider(store),
      { required: true },
      emptyCorrespondence(correspondenceCalls),
      orchestrator(orchestratorCalls),
    );

    const response = await app.request("/projects/stensibly/activity?limit=51", {
      headers: { authorization: `Bearer ${token.token}` },
    });
    expect(response.status).toBe(400);
    expect(correspondenceCalls.calls).toBe(0);
    expect(orchestratorCalls.calls).toBe(0);
  });
});
