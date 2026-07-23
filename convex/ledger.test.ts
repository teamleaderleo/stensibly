import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const leo = { id: "leo", name: "Leo", kind: "human" as const };
const alpha = { id: "alpha", name: "Alpha", kind: "agent" as const };
const beta = { id: "beta", name: "Beta", kind: "agent" as const };

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret);
});

describe("Convex ledger", () => {
  test("preserves the item, claim, handoff, artifact, and completion loop", async () => {
    const t = convexTest(schema, modules);
    const created = await createItem(t, "Build the strange little ledger", "create-1");
    const retried = await createItem(t, "Build the strange little ledger", "create-1");
    expect(retried.id).toBe(created.id);

    const claimed = await t.mutation(convexApi.claims.acquire, {
      serviceSecret: secret,
      workspace,
      id: created.id,
      actor: alpha,
      leaseSeconds: 900,
      idempotencyKey: "claim-alpha",
    }) as any;
    expect(claimed.status).toBe("active");
    expect(claimed.claimedBy).toBe("alpha");

    await expect(t.mutation(convexApi.claims.acquire, {
      serviceSecret: secret,
      workspace,
      id: created.id,
      actor: beta,
      leaseSeconds: 900,
    })).rejects.toThrow(/held by another actor/);

    const artifact = await t.mutation(convexApi.artifacts.attach, {
      serviceSecret: secret,
      workspace,
      id: created.id,
      actor: alpha,
      kind: "commit",
      label: "Convex migration",
      uri: "git:teamleaderleo/stensibly@deadbeef",
      metadata: { sha: "deadbeef" },
      idempotencyKey: "artifact-1",
    }) as any;
    expect(artifact.kind).toBe("commit");

    const handedOff = await t.mutation(convexApi.items.handoff, {
      serviceSecret: secret,
      workspace,
      id: created.id,
      actor: alpha,
      summary: "The core is in place.",
      nextAction: "Review and complete it.",
      toActorId: beta.id,
      idempotencyKey: "handoff-1",
    }) as any;
    expect(handedOff.status).toBe("ready");
    expect(handedOff.claimedBy).toBeNull();

    await t.mutation(convexApi.claims.acquire, {
      serviceSecret: secret,
      workspace,
      id: created.id,
      actor: beta,
      leaseSeconds: 900,
    });
    const completed = await t.mutation(convexApi.items.complete, {
      serviceSecret: secret,
      workspace,
      id: created.id,
      actor: beta,
      summary: "Reviewed and survived.",
      idempotencyKey: "complete-1",
    }) as any;
    expect(completed.status).toBe("done");

    const detail = await t.query(convexApi.items.get, {
      serviceSecret: secret,
      workspace,
      id: created.id,
    }) as any;
    expect(detail.artifacts).toHaveLength(1);
    expect(detail.events.map((event: any) => event.type)).toEqual(expect.arrayContaining([
      "item.created",
      "claim.created",
      "artifact.attached",
      "work.handed_off",
      "item.completed",
    ]));
  });

  test("renewal invalidates the old scheduled expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00.000Z"));
    const t = convexTest(schema, modules);
    const item = await createItem(t, "Outlive an obsolete timer");

    await t.mutation(convexApi.claims.acquire, {
      serviceSecret: secret,
      workspace,
      id: item.id,
      actor: alpha,
      leaseSeconds: 30,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await t.mutation(convexApi.claims.renew, {
      serviceSecret: secret,
      workspace,
      id: item.id,
      actor: alpha,
      leaseSeconds: 60,
    });

    await vi.advanceTimersByTimeAsync(25_000);
    await t.finishInProgressScheduledFunctions();
    const stillActive = await t.query(convexApi.items.get, {
      serviceSecret: secret,
      workspace,
      id: item.id,
    }) as any;
    expect(stillActive.item.status).toBe("active");

    await vi.advanceTimersByTimeAsync(40_000);
    await t.finishInProgressScheduledFunctions();
    const expired = await t.query(convexApi.items.get, {
      serviceSecret: secret,
      workspace,
      id: item.id,
    }) as any;
    expect(expired.item.status).toBe("ready");
    expect(expired.events.filter((event: any) => event.type === "claim.expired")).toHaveLength(1);
    vi.useRealTimers();
  });

  test("shared reservations enforce capacity independently from work claims", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t, "Use the benchmark pool");
    const base = {
      serviceSecret: secret,
      workspace,
      resource: "gpu:benchmark-pool",
      mode: "shared" as const,
      capacity: 4,
      leaseSeconds: 900,
      itemId: item.id,
      project: "scrapbook",
    };
    const first = await t.mutation(convexApi.reservations.acquire, {
      ...base,
      actor: alpha,
      units: 2,
    }) as any;
    await t.mutation(convexApi.reservations.acquire, {
      ...base,
      actor: beta,
      units: 2,
    });
    await expect(t.mutation(convexApi.reservations.acquire, {
      ...base,
      actor: leo,
      units: 1,
    })).rejects.toThrow(/capacity is exhausted/);

    await t.mutation(convexApi.reservations.release, {
      serviceSecret: secret,
      workspace,
      id: first.id,
      actorId: alpha.id,
    });
    const replacement = await t.mutation(convexApi.reservations.acquire, {
      ...base,
      actor: leo,
      units: 2,
    }) as any;
    expect(replacement.status).toBe("active");
  });

  test("runs, dependencies, and project briefs expose live coordination", async () => {
    const t = convexTest(schema, modules);
    const apiItem = await createItem(t, "Change the API");
    const docsItem = await createItem(t, "Document the API");
    await t.mutation(convexApi.dependencies.add, {
      serviceSecret: secret,
      workspace,
      fromItemId: docsItem.id,
      toItemId: apiItem.id,
      kind: "depends_on",
      actor: leo,
    });
    const run = await t.mutation(convexApi.runs.start, {
      serviceSecret: secret,
      workspace,
      itemId: apiItem.id,
      actor: alpha,
      harness: "codex",
      model: "frontier-model",
      repository: "teamleaderleo/stensibly",
      branch: "feat/convex-backend",
      idempotencyKey: "run-1",
    }) as any;
    const heartbeat = await t.mutation(convexApi.runs.heartbeat, {
      serviceSecret: secret,
      workspace,
      id: run.id,
      actorId: alpha.id,
      childAgentCount: 4,
      toolCallCount: 27,
    }) as any;
    expect(heartbeat.childAgentCount).toBe(4);

    const brief = await t.query(convexApi.projects.brief, {
      serviceSecret: secret,
      workspace,
      project: "scrapbook",
      limit: 10,
    }) as any;
    expect(brief.counts.total).toBe(2);
    expect(brief.activeRuns).toHaveLength(1);
    expect(brief.activeRuns[0]).toMatchObject({ harness: "codex", childAgentCount: 4 });

    const dependencies = await t.query(convexApi.dependencies.list, {
      serviceSecret: secret,
      workspace,
      itemId: docsItem.id,
    }) as any[];
    expect(dependencies).toEqual([
      expect.objectContaining({ direction: "outgoing", kind: "depends_on", itemId: apiItem.id }),
    ]);

    const finished = await t.mutation(convexApi.runs.finish, {
      serviceSecret: secret,
      workspace,
      id: run.id,
      actorId: alpha.id,
      status: "succeeded",
      outcome: "The API is ready for review.",
      childAgentCount: 4,
      toolCallCount: 31,
    }) as any;
    expect(finished.status).toBe("succeeded");
  });
});

async function createItem(t: ReturnType<typeof convexTest>, title: string, idempotencyKey?: string) {
  return await t.mutation(convexApi.items.create, {
    serviceSecret: secret,
    workspace,
    project: "scrapbook",
    kind: "task",
    title,
    nextAction: "Do the next useful thing.",
    priority: 50,
    actor: leo,
    idempotencyKey,
  }) as any;
}
