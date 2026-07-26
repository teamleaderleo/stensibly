import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "item-control-secret";
const workspace = "test";
const human = { id: "human:leo", name: "Leo", kind: "human" as const };
const agent = { id: "agent:worker", name: "Worker", kind: "agent" as const };
const supervisor = {
  id: "service:supervisor",
  name: "Supervisor",
  kind: "service" as const,
};
const now = Date.parse("2026-07-26T12:00:00.000Z");

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("hosted item control detail", () => {
  test("projects ready, live, and expired claim authority from trusted time", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t, "Hosted authority", human);

    const ready = await detail(t, item.id, now);
    expect(ready.control.authority).toMatchObject({
      state: "unclaimed",
      generation: 0,
      source: "none",
      allowedOperations: ["claim", "complete", "handoff", "block"],
    });

    const claimed = await t.mutation(convexApi.claims.acquire, {
      serviceSecret,
      workspace,
      id: item.id,
      actor: agent,
      leaseSeconds: 900,
    }) as any;
    const live = await detail(t, item.id, Date.parse(claimed.updatedAt));
    expect(live.control.authority).toMatchObject({
      state: "live",
      holderActorId: agent.id,
      generation: claimed.claimGeneration,
      source: "claim",
    });

    const expired = await detail(t, item.id, Date.parse(claimed.claimExpiresAt) + 1);
    expect(expired.control.authority).toMatchObject({
      state: "expired",
      holderActorId: agent.id,
      generation: claimed.claimGeneration,
      allowedOperations: [],
    });
  });

  test("identifies dispatcher authority and current handoff responsibility", async () => {
    const t = convexTest(schema, modules);
    const dispatched = await createItem(t, "Hosted dispatcher", supervisor);
    await t.run(async (ctx) => {
      const item = (await ctx.db.query("items").collect())
        .find((entry) => entry.externalId === dispatched.id);
      const actor = (await ctx.db.query("actors").collect())
        .find((entry) => entry.externalId === supervisor.id);
      if (!item || !actor) throw new Error("Dispatcher fixture setup failed");
      const leaseExpiresAt = now + 900_000;
      await ctx.db.patch(item._id, {
        status: "active",
        claimedByActorId: actor._id,
        claimedByExternalId: actor.externalId,
        claimExpiresAt: leaseExpiresAt,
        claimGeneration: item.claimGeneration + 1,
        version: item.version + 1,
        updatedAt: now,
      });
      const runId = await ctx.db.insert("queuedRuns", {
        workspaceId: item.workspaceId,
        projectId: item.projectId,
        itemId: item._id,
        externalId: "pending",
        actorId: actor._id,
        actorExternalId: actor.externalId,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        status: "running",
        generation: 2,
        leaseGeneration: 2,
        leaseOwnerExternalId: actor.externalId,
        leaseExpiresAt,
        lastHeartbeatAt: now,
        usage: {},
        retryAttempt: 0,
        maxAttempts: 3,
        retryBackoffSeconds: 60,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
      });
      await ctx.db.patch(runId, { externalId: `run_${runId}` });
    });

    const active = await detail(t, dispatched.id, now);
    expect(active.control.authority).toMatchObject({
      state: "live",
      holderActorId: supervisor.id,
      source: "dispatcher",
    });
    expect(active.control.responsibility).toMatchObject({
      actorId: supervisor.id,
      heartbeatExpectedAt: "2026-07-26T12:15:00.000Z",
    });

    const handoff = await createItem(t, "Hosted handoff", agent);
    const handedOff = await t.mutation(convexApi.items.handoff, {
      serviceSecret,
      workspace,
      id: handoff.id,
      actor: agent,
      expectedClaimGeneration: handoff.claimGeneration,
      summary: "Ready for hosted review.",
      nextAction: "Review and decide.",
      toActorId: human.id,
    }) as any;
    const handedOffDetail = await detail(t, handoff.id, now);
    expect(handedOffDetail.control.authority).toMatchObject({
      state: "unclaimed",
      generation: handedOff.claimGeneration,
      source: "none",
    });
    expect(handedOffDetail.control.responsibility.actorId).toBe(human.id);
  });

  test("bounds visible history and stays isolated to the requested item", async () => {
    const t = convexTest(schema, modules);
    const visible = await createItem(t, "Bound hosted detail", human, "scrapbook");
    const hidden = await createItem(t, "Private detail", human, "private-project");
    await t.run(async (ctx) => {
      const items = await ctx.db.query("items").collect();
      const item = items.find((entry) => entry.externalId === visible.id);
      const hiddenItem = items.find((entry) => entry.externalId === hidden.id);
      const actor = (await ctx.db.query("actors").collect())
        .find((entry) => entry.externalId === human.id);
      if (!item || !hiddenItem || !actor) throw new Error("Bounded detail fixture setup failed");
      for (let index = 0; index < 120; index += 1) {
        await ctx.db.insert("events", {
          workspaceId: item.workspaceId,
          projectId: item.projectId,
          itemId: item._id,
          externalId: `evt_visible_${index}`,
          actorId: actor._id,
          actorExternalId: actor.externalId,
          type: "progress.recorded",
          payload: { index },
          createdAt: now + index,
        });
      }
      await ctx.db.insert("events", {
        workspaceId: hiddenItem.workspaceId,
        projectId: hiddenItem.projectId,
        itemId: hiddenItem._id,
        externalId: "evt_private_secret",
        actorId: actor._id,
        actorExternalId: actor.externalId,
        type: "progress.recorded",
        payload: { secret: "private-project-value" },
        createdAt: now + 500,
      });
    });

    const result = await detail(t, visible.id, now + 1_000);
    expect(result.events).toHaveLength(100);
    expect(result.events.at(-1)?.payload).toEqual({ index: 119 });
    expect(JSON.stringify(result)).not.toContain(hidden.id);
    expect(JSON.stringify(result)).not.toContain("private-project-value");
  });
});

async function createItem(
  t: ReturnType<typeof convexTest>,
  title: string,
  actor: typeof human | typeof agent | typeof supervisor,
  project = "scrapbook",
) {
  return await t.mutation(convexApi.items.create, {
    serviceSecret,
    workspace,
    project,
    kind: "task",
    title,
    summary: "Current hosted context.",
    nextAction: "Continue through the hosted boundary.",
    priority: 60,
    actor,
  }) as any;
}

async function detail(t: ReturnType<typeof convexTest>, id: string, trustedNow: number) {
  return await t.query(convexApi.itemControl.get, {
    serviceSecret,
    workspace,
    id,
    now: trustedNow,
  }) as any;
}
