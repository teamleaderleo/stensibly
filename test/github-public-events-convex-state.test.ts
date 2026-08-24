import { describe, expect, test } from "bun:test";
import {
  ConvexGitHubPublicEventsPollStateError,
  ConvexGitHubPublicEventsPollStateStore,
} from "../src/github-public-events-convex-state.ts";

const etag = '"abc123"';

describe("Convex GitHub public Events poll-state store", () => {
  test("returns null when no durable state exists yet", async () => {
    const store = storeWithQueryResult(null);
    expect(await store.getPollState("Coreys-Quarry/quarry")).toBeNull();
  });

  test("admits durable state as canonical repository with ISO timestamps", async () => {
    const nextEligible = Date.parse("2026-08-25T10:00:00.000Z");
    const lastPolled = Date.parse("2026-08-25T09:00:00.000Z");
    const store = storeWithQueryResult({
      repository: "coreys-quarry/quarry",
      etag,
      nextEligibleAt: nextEligible,
      lastPolledAt: lastPolled,
      updatedAt: lastPolled,
    });
    const state = await store.getPollState("Coreys-Quarry/quarry");
    expect(state).toEqual({
      repository: "coreys-quarry/quarry",
      etag,
      nextEligibleAt: "2026-08-25T10:00:00.000Z",
      lastPolledAt: "2026-08-25T09:00:00.000Z",
    });
    expect(Object.isFrozen(state)).toBe(true);
  });

  test("rejects durable state that belongs to another repository", async () => {
    const store = storeWithQueryResult({
      repository: "teamleaderleo/stensibly",
      etag,
      nextEligibleAt: Date.now(),
      lastPolledAt: null,
    });
    await expect(store.getPollState("Coreys-Quarry/quarry"))
      .rejects.toBeInstanceOf(ConvexGitHubPublicEventsPollStateError);
  });

  test("rejects malformed durable rows", async () => {
    const base = {
      repository: "coreys-quarry/quarry",
      etag,
      nextEligibleAt: Date.parse("2026-08-25T10:00:00.000Z"),
      lastPolledAt: null,
    };
    expect(await admit(base)).toMatchObject({ etag });
    await expect(admit({ ...base, repository: "other/repo" })).rejects.toThrow();
    await expect(admit({ ...base, etag: 5 })).rejects.toThrow();
    await expect(admit({ ...base, etag: "" })).rejects.toThrow();
    await expect(admit({ ...base, etag: `"bad\netag"` })).rejects.toThrow();
    await expect(admit({ ...base, nextEligibleAt: "soon" })).rejects.toThrow();
    await expect(admit({ ...base, lastPolledAt: -1 })).rejects.toThrow();
    await expect(admit([base])).rejects.toThrow();
  });

  test("persists canonical repository and millisecond timestamps through put", async () => {
    const calls: Record<string, unknown>[] = [];
    const stored = {
      repository: "coreys-quarry/quarry",
      etag,
      nextEligibleAt: Date.parse("2026-08-25T11:05:00.000Z"),
      lastPolledAt: Date.parse("2026-08-25T11:00:00.000Z"),
      updatedAt: Date.parse("2026-08-25T11:00:00.000Z"),
    };
    const store = new ConvexGitHubPublicEventsPollStateStore({
      client: {
        async mutation(_reference, args) {
          calls.push(args);
          return stored;
        },
        async query() {
          throw new Error("not used");
        },
      },
      serviceSecret: "service-secret",
      workspace: "default",
    });
    const saved = await store.putPollState({
      repository: "Coreys-Quarry/quarry",
      etag,
      nextEligibleAt: "2026-08-25T11:05:00.000Z",
      lastPolledAt: "2026-08-25T11:00:00.000Z",
    });
    expect(calls[0]).toEqual({
      serviceSecret: "service-secret",
      workspace: "default",
      repository: "coreys-quarry/quarry",
      etag,
      nextEligibleAt: Date.parse("2026-08-25T11:05:00.000Z"),
      lastPolledAt: Date.parse("2026-08-25T11:00:00.000Z"),
    });
    expect(saved).toEqual({
      repository: "coreys-quarry/quarry",
      etag,
      nextEligibleAt: "2026-08-25T11:05:00.000Z",
      lastPolledAt: "2026-08-25T11:00:00.000Z",
    });
  });

  test("rejects invalid input without calling Convex", async () => {
    let calls = 0;
    const nextEligible = Date.parse("2026-08-25T11:05:00.000Z");
    const store = new ConvexGitHubPublicEventsPollStateStore({
      client: {
        async mutation() {
          calls += 1;
          return {
            repository: "coreys-quarry/quarry",
            etag,
            nextEligibleAt: nextEligible,
            lastPolledAt: null,
          };
        },
        async query() {
          throw new Error("not used");
        },
      },
      serviceSecret: "service-secret",
    });
    const valid = {
      repository: "Coreys-Quarry/quarry",
      etag,
      nextEligibleAt: "2026-08-25T11:05:00.000Z",
      lastPolledAt: null,
    };
    await store.putPollState(valid);
    expect(calls).toBe(1);
    await expect(store.putPollState({ ...valid, etag: `"bad\u0000"` }))
      .rejects.toBeInstanceOf(ConvexGitHubPublicEventsPollStateError);
    await expect(store.putPollState({ ...valid, nextEligibleAt: "not-a-time" }))
      .rejects.toBeInstanceOf(ConvexGitHubPublicEventsPollStateError);
    await expect(store.putPollState({ ...valid, lastPolledAt: "also-not-a-time" }))
      .rejects.toBeInstanceOf(ConvexGitHubPublicEventsPollStateError);
    expect(calls).toBe(1);
  });

  test("maps backend failure to one typed storage error", async () => {
    const store = new ConvexGitHubPublicEventsPollStateStore({
      client: {
        async mutation() {
          throw new Error("GITHUB_PUBLIC_EVENTS_POLL_STATE_WORKSPACE_NOT_FOUND");
        },
        async query() {
          throw new Error("backend unavailable");
        },
      },
      serviceSecret: "service-secret",
    });
    const state = {
      repository: "Coreys-Quarry/quarry",
      etag,
      nextEligibleAt: "2026-08-25T11:05:00.000Z",
      lastPolledAt: null,
    };
    await expect(store.putPollState(state)).rejects.toBeInstanceOf(
      ConvexGitHubPublicEventsPollStateError,
    );
    await expect(store.getPollState("Coreys-Quarry/quarry"))
      .rejects.toBeInstanceOf(ConvexGitHubPublicEventsPollStateError);
  });
});

function storeWithQueryResult(result: unknown): ConvexGitHubPublicEventsPollStateStore {
  return new ConvexGitHubPublicEventsPollStateStore({
    client: {
      async mutation() {
        throw new Error("not used");
      },
      async query(_reference, _args) {
        return result;
      },
    },
    serviceSecret: "service-secret",
    workspace: "default",
  });
}

function admit(value: unknown): Promise<unknown> {
  return storeWithQueryResult(value).getPollState("Coreys-Quarry/quarry");
}
