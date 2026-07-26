import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const agent = { id: "agent", name: "Agent", kind: "agent" as const };
const leo = { id: "leo", name: "Leo", kind: "human" as const };
const supervisor = {
  id: "service:supervisor",
  name: "Supervisor",
  kind: "service" as const,
};

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret);
});

describe("Convex continuation supervisor", () => {
  test("atomically approves, queues the exact target, consumes, and replays", async () => {
    const t = convexTest(schema, modules);
    const source = await createItem(t, "Hosted supervisor source", "alpha", 90);
    const target = await createItem(t, "Hosted exact target", "alpha", 10);
    await createItem(t, "Higher unrelated work", "alpha", 100);
    const proposal = await propose(t, source.id, {
      kind: "dispatch_item" as const,
      itemId: target.id,
      runnerProfile: "special-profile",
    });
    const input = {
      serviceSecret: secret,
      workspace,
      id: proposal.id,
      actor: leo,
      supervisor,
      expectedGeneration: proposal.generation,
      runnerType: "generic-mcp",
      runnerProfile: "fallback-profile",
      leaseSeconds: 900,
      maxAttempts: 4,
      retryBackoffSeconds: 30,
      idempotencyKey: "hosted-supervisor-queue-1",
    };

    const result = await t.mutation(convexApi.continuationSupervisor.queue, input) as any;
    expect(result).toMatchObject({
      continuation: {
        id: proposal.id,
        status: "consumed",
        generation: proposal.generation + 2,
        result: { itemId: target.id, runId: result.run.id },
      },
      item: {
        id: target.id,
        status: "active",
        claimedBy: supervisor.id,
      },
      run: {
        itemId: target.id,
        actorId: supervisor.id,
        runnerType: "generic-mcp",
        runnerProfile: "special-profile",
        status: "queued",
        generation: 1,
        leaseGeneration: 1,
        continuationRef: proposal.id,
        retryAttempt: 0,
        maxAttempts: 4,
        retryBackoffSeconds: 30,
      },
      createdItemId: null,
      notificationRecommended: false,
    });
    expect(await t.mutation(convexApi.continuationSupervisor.queue, input)).toEqual(result);

    await expect(t.mutation(convexApi.continuationSupervisor.queue, {
      ...input,
      runnerProfile: "changed-replay",
    })).rejects.toThrow("different continuation supervisor request");

    const targetDetail = await t.query(convexApi.items.get, {
      serviceSecret: secret,
      workspace,
      id: target.id,
    }) as any;
    expect(targetDetail.events.map((event: any) => event.type)).toEqual(expect.arrayContaining([
      "claim.created",
      "run.queued",
    ]));
    expect(targetDetail.runs).toEqual([]);
  });

  test("preserves state for stale, rejected, and unavailable targets", async () => {
    const t = convexTest(schema, modules);
    const source = await createItem(t, "Guard source", "alpha", 60);
    const staleTarget = await createItem(t, "Stale target", "alpha", 50);
    const stale = await propose(t, source.id, {
      kind: "dispatch_item" as const,
      itemId: staleTarget.id,
    });

    await expect(queue(t, stale, staleTarget.id, {
      expectedGeneration: stale.generation + 1,
    })).rejects.toThrow("generation changed");
    expect(await getContinuation(t, stale.id)).toMatchObject({
      status: "proposed",
      generation: stale.generation,
    });
    expect((await getItem(t, staleTarget.id)).status).toBe("ready");

    const rejectedTarget = await createItem(t, "Rejected target", "alpha", 40);
    const rejectable = await propose(t, source.id, {
      kind: "dispatch_item" as const,
      itemId: rejectedTarget.id,
    });
    const rejected = await t.mutation(convexApi.continuations.resolve, {
      serviceSecret: secret,
      workspace,
      id: rejectable.id,
      actor: leo,
      command: "reject",
      expectedGeneration: rejectable.generation,
    }) as any;
    await expect(queue(t, rejected, rejectedTarget.id)).rejects.toThrow(
      "cannot queue for supervisor while rejected",
    );
    expect(await getContinuation(t, rejected.id)).toMatchObject({
      status: "rejected",
      generation: rejected.generation,
    });
    expect((await getItem(t, rejectedTarget.id)).status).toBe("ready");

    const blockedTarget = await createItem(t, "Blocked target", "alpha", 30);
    await t.mutation(convexApi.items.block, {
      serviceSecret: secret,
      workspace,
      id: blockedTarget.id,
      actor: supervisor,
      expectedClaimGeneration: blockedTarget.claimGeneration,
      reason: "Target is unavailable.",
    });
    const blocked = await propose(t, source.id, {
      kind: "resume_item" as const,
      itemId: blockedTarget.id,
    });
    await expect(queue(t, blocked, blockedTarget.id)).rejects.toThrow(
      "not eligible for supervisor dispatch",
    );
    expect(await getContinuation(t, blocked.id)).toMatchObject({
      status: "proposed",
      generation: blocked.generation,
    });
    expect((await getItem(t, blockedTarget.id)).status).toBe("blocked");
  });

  test("materializes create-item actions and applies policy to complete project touch sets", async () => {
    const t = convexTest(schema, modules);
    const source = await createItem(t, "Policy source", "alpha", 72);
    const createProposal = await propose(t, source.id, {
      kind: "create_item" as const,
      project: "beta",
    });
    const created = await t.mutation(convexApi.continuationSupervisor.queue, {
      serviceSecret: secret,
      workspace,
      id: createProposal.id,
      actor: leo,
      supervisor,
      expectedGeneration: createProposal.generation,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      idempotencyKey: "hosted-create-item",
    }) as any;
    expect(created.createdItemId).toBe(created.item.id);
    expect(created.item).toMatchObject({
      project: "beta",
      title: createProposal.title,
      summary: createProposal.rationale,
      nextAction: createProposal.instruction,
      priority: source.priority,
      status: "active",
    });

    const automaticTarget = await createItem(t, "Automatic target", "alpha", 50);
    const notifyTarget = await createItem(t, "Notify target", "alpha", 40);
    const crossProjectTarget = await createItem(t, "Cross-project target", "beta", 30);
    const automatic = await proposePolicy(t, source.id, "automatic", {
      kind: "dispatch_item" as const,
      itemId: automaticTarget.id,
    });
    const notify = await proposePolicy(t, source.id, "notify", {
      kind: "resume_item" as const,
      itemId: notifyTarget.id,
    });
    const decision = await proposePolicy(t, source.id, "automatic", {
      kind: "request_decision" as const,
      decisionType: "human_review",
    });
    const crossProject = await proposePolicy(t, source.id, "automatic", {
      kind: "dispatch_item" as const,
      itemId: crossProjectTarget.id,
    });

    const policy = await t.mutation(convexApi.continuationSupervisor.runPolicy, {
      serviceSecret: secret,
      workspace,
      supervisor,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      project: "alpha",
      limit: 10,
    }) as any;
    expect(policy.considered).toBe(3);
    expect(policy.dispatched.map((entry: any) => entry.continuation.id).sort()).toEqual([
      automatic.id,
      notify.id,
    ].sort());
    expect(policy.dispatched.find((entry: any) => entry.continuation.id === notify.id))
      .toMatchObject({ notificationRecommended: true });
    expect(policy.skipped).toEqual([
      expect.objectContaining({
        id: decision.id,
        reason: "Decision requests remain human-owned.",
      }),
    ]);
    expect((await getItem(t, crossProjectTarget.id)).status).toBe("ready");
    expect(await getContinuation(t, crossProject.id)).toMatchObject({
      status: "proposed",
      generation: crossProject.generation,
    });

    const sourceDetail = await t.query(convexApi.items.get, {
      serviceSecret: secret,
      workspace,
      id: source.id,
    }) as any;
    expect(sourceDetail.events.map((event: any) => event.type)).toContain(
      "continuation.supervisor_notified",
    );
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

async function proposePolicy(
  t: ReturnType<typeof convexTest>,
  sourceItemId: string,
  approvalMode: "automatic" | "notify",
  action: any,
) {
  return await t.mutation(convexApi.continuations.propose, {
    serviceSecret: secret,
    workspace,
    sourceItemId,
    title: `${approvalMode} hosted continuation`,
    rationale: "Hosted policy should evaluate this continuation.",
    instruction: "Queue the typed action.",
    action,
    actor: agent,
    approvalMode,
    deliveryMode: "supervisor",
  }) as any;
}

async function queue(
  t: ReturnType<typeof convexTest>,
  proposal: any,
  _targetId: string,
  overrides: Record<string, unknown> = {},
) {
  return await t.mutation(convexApi.continuationSupervisor.queue, {
    serviceSecret: secret,
    workspace,
    id: proposal.id,
    actor: leo,
    supervisor,
    expectedGeneration: proposal.generation,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    ...overrides,
  });
}

async function getContinuation(t: ReturnType<typeof convexTest>, id: string) {
  return await t.mutation(convexApi.continuations.get, {
    serviceSecret: secret,
    workspace,
    id,
  }) as any;
}

async function getItem(t: ReturnType<typeof convexTest>, id: string) {
  return (await t.query(convexApi.items.get, {
    serviceSecret: secret,
    workspace,
    id,
  }) as any).item;
}
