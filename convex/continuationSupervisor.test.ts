import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const agent = { id: "agent", name: "Agent", kind: "agent" as const };
const leo = { id: "leo", name: "Leo", kind: "human" as const };
const supervisor = { id: "service:supervisor", name: "Supervisor", kind: "service" as const };
const executionEnvelope = {
  schemaVersion: 1 as const,
  objective: "Dispatch the exact hosted continuation",
  scopeClass: "segmented" as const,
  estimate: { lowMinutes: 20, likelyMinutes: 40, highMinutes: 70, confidence: 0.6 },
  budget: { expectedMessages: 3, expectedToolCalls: 25, expectedReviewMinutes: 8 },
  boundaries: { softCheckpointMinutes: 50, forcedHandoffMinutes: 75, hardRecoveryMinutes: 90 },
  completion: {
    requiredOutputs: ["implementation", "tests"],
    verificationRequired: true,
    continuationStateRequired: true,
    acceptanceChecks: ["targeted checks pass"],
  },
  durableState: {
    accessClass: "project" as const,
    retentionClass: "standard" as const,
    redactionRequired: true,
    deleteAfter: null,
  },
};

beforeEach(() => vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret));

describe("Convex continuation supervisor", () => {
  test("queues, replays, and exposes only the compact envelope reference", async () => {
    const t = convexTest(schema, modules);
    const source = await createItem(t, "Hosted supervisor source", "alpha", 90);
    const target = await createItem(t, "Hosted exact target", "alpha", 10);
    const proposal = await propose(t, source.id, {
      kind: "dispatch_item" as const,
      itemId: target.id,
      runnerProfile: "special-profile",
    });
    const input = queueInput(proposal, {
      runnerProfile: "fallback-profile",
      executionEnvelope,
      idempotencyKey: "hosted-supervisor-queue-1",
    });

    const result = await t.mutation(convexApi.continuationSupervisor.queue, input) as any;
    expect(result).toMatchObject({
      continuation: { id: proposal.id, status: "consumed", generation: proposal.generation + 2 },
      item: { id: target.id, status: "active", claimedBy: supervisor.id },
      run: {
        itemId: target.id,
        actorId: supervisor.id,
        runnerProfile: "special-profile",
        status: "queued",
        generation: 1,
        leaseGeneration: 1,
        continuationRef: proposal.id,
        executionEnvelope,
        executionRecords: [],
      },
    });
    expect(await t.mutation(convexApi.continuationSupervisor.queue, input)).toEqual(result);
    await expect(t.mutation(convexApi.continuationSupervisor.queue, {
      ...input,
      runnerProfile: "changed-replay",
    })).rejects.toThrow("different continuation supervisor request");

    const detail = await t.query(convexApi.items.get, {
      serviceSecret: secret,
      workspace,
      id: target.id,
    }) as any;
    const publicTypes = detail.events.map((event: any) => event.type);
    expect(publicTypes).toContain("run.envelope_reference");
    expect(publicTypes.some((type: string) =>
      type.startsWith("run.execution_envelope:") || type.startsWith("run.execution_actual:")
    )).toBe(false);

    const rawTypes = await t.run(async (ctx) => {
      const item = (await ctx.db.query("items").collect())
        .find((entry) => entry.externalId === target.id);
      if (!item) throw new Error("Target fixture disappeared");
      return (await ctx.db
        .query("events")
        .withIndex("by_item_created", (q) => q.eq("itemId", item._id))
        .collect()).map((event) => event.type);
    });
    expect(rawTypes).toContain(`run.execution_envelope:${result.run.id}`);
  });

  test("records terminal actuals for supervisor-created queued runs", async () => {
    const t = convexTest(schema, modules);
    const source = await createItem(t, "Terminal source", "alpha", 80);
    const target = await createItem(t, "Terminal target", "alpha", 70);
    const proposal = await propose(t, source.id, {
      kind: "dispatch_item" as const,
      itemId: target.id,
    });
    const queued = await t.mutation(
      convexApi.continuationSupervisor.queue,
      queueInput(proposal, { executionEnvelope, idempotencyKey: "queue-terminal" }),
    ) as any;
    const finishInput = {
      serviceSecret: secret,
      workspace,
      id: queued.run.id,
      actorId: supervisor.id,
      expectedGeneration: queued.run.generation,
      expectedLeaseGeneration: queued.run.leaseGeneration,
      status: "succeeded" as const,
      outcome: "Implemented and verified.",
      executionActual: {
        durationMinutes: 42,
        messagesConsumed: 3,
        toolCalls: 19,
        filesChanged: 4,
        reviewMinutes: 7,
      },
      idempotencyKey: "finish-terminal",
    };

    await expect(t.mutation(convexApi.queuedRuns.finish, {
      ...finishInput,
      expectedGeneration: queued.run.generation + 1,
    })).rejects.toThrow("generation changed");
    const finished = await t.mutation(convexApi.queuedRuns.finish, finishInput) as any;
    expect(finished).toMatchObject({
      id: queued.run.id,
      status: "succeeded",
      generation: queued.run.generation + 1,
      outcome: "Implemented and verified.",
      executionEnvelope,
      executionRecords: [{ transition: "finish:succeeded", actual: finishInput.executionActual }],
    });
    expect(await t.mutation(convexApi.queuedRuns.finish, finishInput)).toEqual(finished);
    await expect(t.mutation(convexApi.queuedRuns.finish, {
      ...finishInput,
      executionActual: { ...finishInput.executionActual, filesChanged: 5 },
    })).rejects.toThrow("different queued run finish");

    const projected = await t.query(convexApi.itemRuns.list, {
      serviceSecret: secret,
      workspace,
      itemId: target.id,
    }) as any[];
    expect(projected.find((run) => run.id === queued.run.id)).toMatchObject({
      status: "succeeded",
      executionRecords: [{ transition: "finish:succeeded" }],
    });
  });

  test("replays legacy supervisor commands without retrofitting envelopes", async () => {
    const t = convexTest(schema, modules);
    const source = await createItem(t, "Legacy source", "alpha", 60);
    const target = await createItem(t, "Legacy target", "alpha", 50);
    const proposal = await propose(t, source.id, {
      kind: "dispatch_item" as const,
      itemId: target.id,
    });
    const input: any = queueInput(proposal, {
      idempotencyKey: "legacy-supervisor-command",
    });
    const original = await t.mutation(convexApi.continuationSupervisor.queue, input) as any;

    await t.run(async (ctx) => {
      const row = (await ctx.db.query("continuationSupervisorCommands").collect())
        .find((entry) => entry.idempotencyKey === "legacy-supervisor-command");
      if (!row) throw new Error("Supervisor command fixture disappeared");
      const request = { ...(row.request as Record<string, unknown>) };
      delete request.executionEnvelope;
      const result = { ...(row.result as Record<string, any>) };
      result.run = { ...result.run };
      delete result.run.executionEnvelope;
      delete result.run.executionRecords;
      await ctx.db.patch(row._id, { request, result });
    });

    const replay = await t.mutation(convexApi.continuationSupervisor.queue, input) as any;
    expect(replay).toMatchObject({
      continuation: original.continuation,
      item: original.item,
      run: { id: original.run.id, executionEnvelope: null, executionRecords: [] },
    });
    await expect(t.mutation(convexApi.continuationSupervisor.queue, {
      ...input,
      runnerProfile: "changed-legacy-replay",
    })).rejects.toThrow("different continuation supervisor request");
    await expect(t.mutation(convexApi.continuationSupervisor.queue, {
      ...input,
      executionEnvelope,
    })).rejects.toThrow("cannot be retrofitted with an execution envelope");
  });
});

async function createItem(
  t: ReturnType<typeof convexTest>,
  title: string,
  project: string,
  priority: number,
) {
  return await t.mutation(convexApi.items.create, {
    serviceSecret: secret,
    workspace,
    project,
    kind: "task",
    title,
    nextAction: `Continue ${title}.`,
    priority,
    actor: agent,
  }) as any;
}

async function propose(t: ReturnType<typeof convexTest>, sourceItemId: string, action: any) {
  return await t.mutation(convexApi.continuations.propose, {
    serviceSecret: secret,
    workspace,
    sourceItemId,
    title: "Queue the hosted continuation",
    rationale: "The durable supervisor should own the next run.",
    instruction: "Queue the typed action and preserve its durable references.",
    action,
    actor: agent,
    approvalMode: "human",
    deliveryMode: "supervisor",
  }) as any;
}

function queueInput(proposal: any, overrides: Record<string, unknown> = {}): any {
  return {
    serviceSecret: secret,
    workspace,
    id: proposal.id,
    actor: leo,
    supervisor,
    expectedGeneration: proposal.generation,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    leaseSeconds: 900,
    maxAttempts: 4,
    retryBackoffSeconds: 30,
    ...overrides,
  };
}
