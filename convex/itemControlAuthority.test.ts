import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "item-control-authority-secret";
const workspace = "test";
const human = { id: "human:leo", name: "Leo", kind: "human" as const };
const supervisor = {
  id: "service:supervisor",
  name: "Supervisor",
  kind: "service" as const,
};
const intruder = { id: "agent:intruder", name: "Intruder", kind: "agent" as const };

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("hosted item-control authority boundaries", () => {
  test("rejects public attempts to forge authority lifecycle events", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t, "Reject hosted forged lifecycle evidence", human);

    for (const type of ["claim.created", "run.queued"]) {
      await expect(t.mutation(convexApi.events.record, {
        serviceSecret,
        workspace,
        id: item.id,
        actor: supervisor,
        type,
        payload: {
          generation: 1,
          runId: "run_forged",
          source: "supervisor_dispatch",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          leaseExpiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      })).rejects.toThrow("reserved for internal lifecycle writers");
    }

    const ordinary = await t.mutation(convexApi.events.record, {
      serviceSecret,
      workspace,
      id: item.id,
      actor: supervisor,
      type: "progress.recorded",
      payload: { message: "ordinary hosted evidence" },
    }) as any;
    expect(ordinary.type).toBe("progress.recorded");
  });

  test("expired rows cannot hide an older unexpired conflicting run", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t, "Keep hosted live conflicts visible", human);
    await createItem(t, "Register hosted conflicting actor", intruder);
    const claimed = await t.mutation(convexApi.claims.acquire, {
      serviceSecret,
      workspace,
      id: item.id,
      actor: supervisor,
      leaseSeconds: 900,
    }) as any;
    const now = Date.parse(claimed.updatedAt);

    await t.run(async (ctx) => {
      const itemRow = (await ctx.db.query("items").collect())
        .find((entry) => entry.externalId === item.id);
      const actors = await ctx.db.query("actors").collect();
      const supervisorRow = actors.find((entry) => entry.externalId === supervisor.id);
      const intruderRow = actors.find((entry) => entry.externalId === intruder.id);
      if (!itemRow || !supervisorRow || !intruderRow) {
        throw new Error("Hosted authority overflow fixture setup failed");
      }

      await ctx.db.insert("queuedRuns", {
        workspaceId: itemRow.workspaceId,
        projectId: itemRow.projectId,
        itemId: itemRow._id,
        externalId: "run_hidden_live_conflict",
        actorId: intruderRow._id,
        actorExternalId: intruderRow.externalId,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        status: "running",
        generation: 1,
        leaseGeneration: 1,
        leaseOwnerExternalId: intruderRow.externalId,
        leaseExpiresAt: now + 600_000,
        lastHeartbeatAt: now,
        usage: {},
        retryAttempt: 0,
        maxAttempts: 1,
        retryBackoffSeconds: 0,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
      });
      for (let index = 0; index < 2; index += 1) {
        await ctx.db.insert("queuedRuns", {
          workspaceId: itemRow.workspaceId,
          projectId: itemRow.projectId,
          itemId: itemRow._id,
          externalId: `run_newer_expired_${index}`,
          actorId: supervisorRow._id,
          actorExternalId: supervisorRow.externalId,
          runnerType: "generic-mcp",
          runnerProfile: "codex-default",
          status: "running",
          generation: 1,
          leaseGeneration: 1,
          leaseOwnerExternalId: supervisorRow.externalId,
          leaseExpiresAt: now - 1_000 - index,
          lastHeartbeatAt: now - 2_000,
          usage: {},
          retryAttempt: 0,
          maxAttempts: 1,
          retryBackoffSeconds: 0,
          createdAt: now + 1_000 + index,
          updatedAt: now + 1_000 + index,
          startedAt: now + 1_000 + index,
        });
      }
    });

    const detail = await t.query(convexApi.itemControl.get, {
      serviceSecret,
      workspace,
      id: item.id,
      now,
    }) as any;
    expect(detail.control.authority).toMatchObject({
      state: "superseded",
      holderActorId: null,
      source: "none",
      allowedOperations: [],
    });
  });
});

async function createItem(
  t: ReturnType<typeof convexTest>,
  title: string,
  actor: typeof human | typeof supervisor | typeof intruder,
) {
  return await t.mutation(convexApi.items.create, {
    serviceSecret,
    workspace,
    project: "scrapbook",
    kind: "task",
    title,
    summary: "Current hosted context.",
    nextAction: "Keep authority evidence bounded.",
    priority: 80,
    actor,
  }) as any;
}
