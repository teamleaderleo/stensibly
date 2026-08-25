import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const supervisor = {
  id: "service:profile-version-supervisor",
  name: "Profile Version Supervisor",
  kind: "service" as const,
};
const runner = {
  id: "agent:profile-version-runner",
  name: "Profile Version Runner",
  kind: "agent" as const,
};
const human = {
  id: "human:profile-version-reviewer",
  name: "Profile Version Reviewer",
  kind: "human" as const,
};
const proposer = {
  id: "agent:profile-version-proposer",
  name: "Profile Version Proposer",
  kind: "agent" as const,
};
const exactVersion = "codex-default/2026-08-25";
const baseArgs = { serviceSecret: secret, workspace };

beforeEach(() => vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret));

describe("hosted runner profile version provenance", () => {
  test("claim selection isolates exact and legacy-unknown provenance in both directions", async () => {
    const exactT = convexTest(schema, modules);
    const exact = await seedQueuedRun(exactT, {
      project: "exact-profile",
      title: "Claim exact hosted provenance",
      runnerProfileVersion: exactVersion,
    });

    expect(await exactT.mutation(convexApi.runnerRuns.claim, claimInput({
      project: "exact-profile",
      runId: exact.runId,
      runnerProfileVersion: null,
    }))).toBeNull();
    expect(await exactT.mutation(convexApi.runnerRuns.claim, claimInput({
      project: "exact-profile",
      runId: exact.runId,
      runnerProfileVersion: "codex-default/2026-08-26",
    }))).toBeNull();
    const claimed = await exactT.mutation(convexApi.runnerRuns.claim, claimInput({
      project: "exact-profile",
      runId: exact.runId,
      runnerProfileVersion: exactVersion,
      idempotencyKey: "claim-hosted-exact-profile",
    })) as any;
    expect(claimed).toMatchObject({
      id: exact.runId,
      runnerProfile: "codex-default",
      runnerProfileVersion: exactVersion,
      status: "starting",
    });
    await expect(exactT.mutation(convexApi.runnerRuns.claim, claimInput({
      project: "exact-profile",
      runId: exact.runId,
      runnerProfileVersion: "codex-default/2026-08-26",
      idempotencyKey: "claim-hosted-exact-profile",
    }))).rejects.toThrow("different runner command");

    const unknownT = convexTest(schema, modules);
    const unknown = await seedQueuedRun(unknownT, {
      project: "unknown-profile",
      title: "Claim legacy unknown hosted provenance",
    });
    expect(await unknownT.mutation(convexApi.runnerRuns.claim, claimInput({
      project: "unknown-profile",
      runId: unknown.runId,
      runnerProfileVersion: exactVersion,
    }))).toBeNull();
    expect(await unknownT.mutation(convexApi.runnerRuns.claim, claimInput({
      project: "unknown-profile",
      runId: unknown.runId,
      runnerProfileVersion: null,
    }))).toMatchObject({
      id: unknown.runId,
      runnerProfileVersion: null,
      status: "starting",
    });
  });

  test("heartbeat, transition, get, and historical command replay preserve exact-or-null provenance", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedQueuedRun(t, {
      project: "lifecycle-profile",
      title: "Preserve hosted profile provenance",
      runnerProfileVersion: exactVersion,
    });
    const claimed = await t.mutation(convexApi.runnerRuns.claim, claimInput({
      project: "lifecycle-profile",
      runId: seeded.runId,
      runnerProfileVersion: exactVersion,
    })) as any;
    const heartbeat = await t.mutation(convexApi.runnerRuns.heartbeat, {
      ...baseArgs,
      id: seeded.runId,
      actor: runner,
      expectedGeneration: claimed.generation,
      expectedLeaseGeneration: claimed.leaseGeneration,
      leaseSeconds: 900,
      checkpoint: "Exact profile version remains attached to the run.",
    }) as any;
    expect(heartbeat.runnerProfileVersion).toBe(exactVersion);
    const running = await t.mutation(convexApi.runnerRuns.transition, {
      ...baseArgs,
      id: seeded.runId,
      actor: runner,
      command: "run",
      expectedGeneration: heartbeat.generation,
      expectedLeaseGeneration: heartbeat.leaseGeneration,
      leaseSeconds: 900,
    }) as any;
    expect(running.runnerProfileVersion).toBe(exactVersion);
    expect((await t.mutation(convexApi.runnerRuns.get, {
      ...baseArgs,
      id: seeded.runId,
    }) as any).runnerProfileVersion).toBe(exactVersion);

    const legacyT = convexTest(schema, modules);
    const legacy = await seedQueuedRun(legacyT, {
      project: "legacy-replay",
      title: "Replay historical runner command output",
    });
    const legacyInput = claimInput({
      project: "legacy-replay",
      runId: legacy.runId,
      runnerProfileVersion: null,
      idempotencyKey: "legacy-profile-version-command",
    });
    const original = await legacyT.mutation(convexApi.runnerRuns.claim, legacyInput) as any;
    expect(original.runnerProfileVersion).toBeNull();
    await legacyT.run(async (ctx) => {
      const command = (await ctx.db.query("runnerCommands").collect())
        .find((entry) => entry.idempotencyKey === "legacy-profile-version-command");
      if (!command) throw new Error("Runner command fixture disappeared");
      const result = { ...(command.result as Record<string, unknown>) };
      delete result.runnerProfileVersion;
      await ctx.db.patch(command._id, { result });
    });
    const replay = await legacyT.mutation(convexApi.runnerRuns.claim, legacyInput) as any;
    expect(replay).toEqual({ ...original, runnerProfileVersion: null });
  });

  test("hosted continuation creation persists matching versions and clears overridden profile versions", async () => {
    const t = convexTest(schema, modules);
    const source = await createItem(t, "Hosted profile source", "continuation-profile", 90);
    const inheritedTarget = await createItem(
      t,
      "Hosted inherited profile target",
      "continuation-profile",
      80,
    );
    const overrideTarget = await createItem(
      t,
      "Hosted override profile target",
      "continuation-profile",
      70,
    );

    const inheritedProposal = await propose(t, source.id, {
      kind: "dispatch_item",
      itemId: inheritedTarget.id,
    });
    const inherited = await t.mutation(convexApi.continuationSupervisor.queue, queueInput(
      inheritedProposal,
      inheritedTarget.id,
      { runnerProfileVersion: exactVersion, idempotencyKey: "hosted-profile-inherit" },
    )) as any;
    expect(inherited.run).toMatchObject({
      runnerProfile: "codex-default",
      runnerProfileVersion: exactVersion,
    });

    const overrideProposal = await propose(t, source.id, {
      kind: "dispatch_item",
      itemId: overrideTarget.id,
      runnerProfile: "special-profile",
    });
    const overridden = await t.mutation(convexApi.continuationSupervisor.queue, queueInput(
      overrideProposal,
      overrideTarget.id,
      { runnerProfileVersion: exactVersion, idempotencyKey: "hosted-profile-override" },
    )) as any;
    expect(overridden.run).toMatchObject({
      runnerProfile: "special-profile",
      runnerProfileVersion: null,
    });

    const raw = await t.run(async (ctx) => {
      const rows = await ctx.db.query("queuedRuns").collect();
      return {
        inherited: rows.find((run) => run.externalId === inherited.run.id),
        overridden: rows.find((run) => run.externalId === overridden.run.id),
      };
    });
    expect(raw.inherited?.runnerProfileVersion).toBe(exactVersion);
    expect(raw.overridden?.runnerProfileVersion).toBeUndefined();
  });
});

function claimInput(overrides: Record<string, unknown> = {}) {
  return {
    ...baseArgs,
    actor: runner,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    leaseSeconds: 900,
    concurrency: { globalLimit: 4, projectLimit: 2 },
    ...overrides,
  };
}

async function seedQueuedRun(
  t: ReturnType<typeof convexTest>,
  input: {
    project: string;
    title: string;
    runnerProfileVersion?: string;
  },
) {
  const item = await createItem(t, input.title, input.project, 80, supervisor);
  return await t.run(async (ctx) => {
    const workspaceRow = (await ctx.db.query("workspaces").collect())
      .find((entry) => entry.slug === workspace);
    const project = (await ctx.db.query("projects").collect())
      .find((entry) => entry.slug === input.project && entry.workspaceId === workspaceRow?._id);
    const itemRow = (await ctx.db.query("items").collect())
      .find((entry) => entry.externalId === item.id && entry.workspaceId === workspaceRow?._id);
    const actor = (await ctx.db.query("actors").collect())
      .find((entry) => entry.externalId === supervisor.id && entry.workspaceId === workspaceRow?._id);
    if (!workspaceRow || !project || !itemRow || !actor) {
      throw new Error("Hosted profile-version fixture disappeared");
    }
    const now = Date.now();
    const runDocId = await ctx.db.insert("queuedRuns", {
      workspaceId: workspaceRow._id,
      projectId: project._id,
      itemId: itemRow._id,
      externalId: "pending",
      actorId: actor._id,
      actorExternalId: actor.externalId,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      ...(input.runnerProfileVersion
        ? { runnerProfileVersion: input.runnerProfileVersion }
        : {}),
      status: "queued",
      generation: 1,
      leaseGeneration: 1,
      leaseOwnerExternalId: actor.externalId,
      leaseExpiresAt: now + 900_000,
      usage: {},
      retryAttempt: 0,
      maxAttempts: 3,
      retryBackoffSeconds: 30,
      createdAt: now,
      updatedAt: now,
    });
    const runId = `run_${runDocId}`;
    await ctx.db.patch(runDocId, { externalId: runId });
    return { itemId: item.id as string, runId };
  });
}

async function createItem(
  t: ReturnType<typeof convexTest>,
  title: string,
  project: string,
  priority: number,
  actor = proposer,
) {
  return await t.mutation(convexApi.items.create, {
    ...baseArgs,
    project,
    kind: "task",
    title,
    nextAction: `Continue ${title}.`,
    priority,
    actor,
  }) as any;
}

async function propose(t: ReturnType<typeof convexTest>, sourceItemId: string, action: any) {
  return await t.mutation(convexApi.continuations.propose, {
    ...baseArgs,
    sourceItemId,
    title: "Queue the hosted profile-version continuation",
    rationale: "The durable supervisor owns the next version-aware run.",
    instruction: "Queue the typed action with exact provenance.",
    action,
    actor: proposer,
    approvalMode: "human",
    deliveryMode: "supervisor",
  }) as any;
}

function queueInput(
  proposal: any,
  _targetItemId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    ...baseArgs,
    id: proposal.id,
    actor: human,
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
