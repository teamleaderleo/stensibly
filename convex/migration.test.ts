import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "migration-test-secret";

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("Convex snapshot migration", () => {
  test("imports identities, work, history, artifacts, and token hashes idempotently", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00.000Z"));
    const t = convexTest(schema, modules);
    const liveExpiry = new Date(Date.now() + 60_000).toISOString();
    const expired = new Date(Date.now() - 60_000).toISOString();

    const identities = {
      serviceSecret,
      workspace: "migrated",
      projects: [{
        id: "scrapbook",
        name: "Scrapbook",
        createdAt: "2026-07-01T00:00:00.000Z",
      }],
      actors: [
        {
          id: "leo",
          name: "Leo",
          kind: "human" as const,
          updatedAt: "2026-07-20T00:00:00.000Z",
        },
        {
          id: "agent",
          name: "Agent",
          kind: "agent" as const,
          updatedAt: "2026-07-24T11:59:00.000Z",
        },
      ],
    };
    await t.mutation(convexApi.migration.importProjectsActors, identities);

    const items = [
      {
        id: "item_live",
        projectId: "scrapbook",
        kind: "task" as const,
        title: "Keep the live claim",
        summary: null,
        status: "active" as const,
        priority: 80,
        nextAction: "Finish before the lease expires.",
        claimedBy: "agent",
        claimExpiresAt: liveExpiry,
        version: 3,
        createdAt: "2026-07-24T11:00:00.000Z",
        updatedAt: "2026-07-24T11:59:00.000Z",
      },
      {
        id: "item_expired",
        projectId: "scrapbook",
        kind: "task" as const,
        title: "Revive stale work",
        summary: null,
        status: "active" as const,
        priority: 50,
        nextAction: "Pick it up again.",
        claimedBy: "agent",
        claimExpiresAt: expired,
        version: 2,
        createdAt: "2026-07-24T10:00:00.000Z",
        updatedAt: "2026-07-24T10:30:00.000Z",
      },
    ];
    const itemResult = await t.mutation(convexApi.migration.importItems, {
      serviceSecret,
      workspace: "migrated",
      items,
    }) as any;
    expect(itemResult).toEqual({ items: 2, liveClaims: 1 });

    const events = [{
      id: "evt_source",
      itemId: "item_live",
      actorId: "agent",
      type: "progress.recorded",
      payload: { summary: "Imported from SQLite." },
      idempotencyKey: "source-progress",
      createdAt: "2026-07-24T11:30:00.000Z",
    }];
    const artifacts = [{
      id: "art_source",
      itemId: "item_live",
      actorId: "agent",
      kind: "commit" as const,
      label: "Imported commit",
      uri: "git:repo@source",
      mimeType: null,
      metadata: { sha: "source" },
      createdAt: "2026-07-24T11:45:00.000Z",
    }];
    const tokens = [{
      id: "tok_1234567890abcdef1234567890abcdef",
      name: "Imported reader",
      secretHash: "c".repeat(64),
      scopes: ["read" as const],
      projects: ["scrapbook"],
      createdAt: "2026-07-24T11:00:00.000Z",
      revokedAt: null,
    }];

    expect(await t.mutation(convexApi.migration.importEvents, {
      serviceSecret,
      workspace: "migrated",
      events,
    })).toEqual({ inserted: 1, skipped: 0 });
    expect(await t.mutation(convexApi.migration.importArtifacts, {
      serviceSecret,
      workspace: "migrated",
      artifacts,
    })).toEqual({ inserted: 1, skipped: 0 });
    expect(await t.mutation(convexApi.migration.importTokens, {
      serviceSecret,
      workspace: "migrated",
      tokens,
    })).toEqual({ tokens: 1 });

    const live = await t.query(convexApi.items.get, {
      serviceSecret,
      workspace: "migrated",
      id: "item_live",
    }) as any;
    expect(live.item).toMatchObject({
      id: "item_live",
      status: "active",
      claimedBy: "agent",
      version: 3,
    });
    expect(live.events).toEqual([
      expect.objectContaining({ id: "evt_source", type: "progress.recorded" }),
    ]);
    expect(live.artifacts).toEqual([
      expect.objectContaining({ id: "art_source", uri: "git:repo@source" }),
    ]);

    const stale = await t.query(convexApi.items.get, {
      serviceSecret,
      workspace: "migrated",
      id: "item_expired",
    }) as any;
    expect(stale.item).toMatchObject({ status: "ready", claimedBy: null });

    const principal = await t.query(convexApi.tokens.authenticate, {
      serviceSecret,
      workspace: "migrated",
      id: tokens[0].id,
      secretHash: tokens[0].secretHash,
    });
    expect(principal).toMatchObject({ name: "Imported reader", projects: ["scrapbook"] });

    await t.mutation(convexApi.migration.importProjectsActors, identities);
    await t.mutation(convexApi.migration.importItems, {
      serviceSecret,
      workspace: "migrated",
      items,
    });
    expect(await t.mutation(convexApi.migration.importEvents, {
      serviceSecret,
      workspace: "migrated",
      events,
    })).toEqual({ inserted: 0, skipped: 1 });
    expect(await t.mutation(convexApi.migration.importArtifacts, {
      serviceSecret,
      workspace: "migrated",
      artifacts,
    })).toEqual({ inserted: 0, skipped: 1 });

    await vi.advanceTimersByTimeAsync(61_000);
    await t.finishInProgressScheduledFunctions();
    const afterExpiry = await t.query(convexApi.items.get, {
      serviceSecret,
      workspace: "migrated",
      id: "item_live",
    }) as any;
    expect(afterExpiry.item.status).toBe("ready");
    expect(afterExpiry.events.filter((event: any) => event.type === "claim.expired")).toHaveLength(1);
    vi.useRealTimers();
  });
});
