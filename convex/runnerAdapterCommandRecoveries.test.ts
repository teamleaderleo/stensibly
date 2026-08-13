import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const supervisor = {
  id: "service:supervisor",
  name: "Supervisor",
  kind: "service" as const,
};
const runnerA = { id: "agent:runner-a", name: "Runner A", kind: "agent" as const };
const runnerB = { id: "agent:runner-b", name: "Runner B", kind: "agent" as const };
const baseArgs = { serviceSecret: secret, workspace };

beforeEach(() => vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret));

describe("hosted runner adapter command recovery", () => {
  test("waits for original authority, binds checkpoint lineage, replays, and advances generations", async () => {
    const t = convexTest(schema, modules);
    const fixture = await reserveCommand(t, "hosted-recovery-lineage");
    const recoveryInput = {
      ...baseArgs,
      commandId: fixture.commandId,
      commandFingerprint: fixture.commandFingerprint,
      actor: runnerB,
      leaseSeconds: 60,
      idempotencyKey: "hosted-recovery-first",
    };

    await expect(t.mutation(convexApi.runnerAdapterCommandRecoveries.claim, recoveryInput))
      .rejects.toThrow("cannot replace live original authority");

    const checkpoint = checkpointReference(fixture.runGeneration);
    await t.run(async (ctx) => {
      const run = (await ctx.db.query("queuedRuns").collect())
        .find((entry) => entry.externalId === fixture.runId);
      if (!run) throw new Error("Hosted recovery run fixture disappeared");
      await ctx.db.patch(run._id, {
        checkpoint: JSON.stringify(checkpoint),
        leaseExpiresAt: Date.now() - 1,
      });
    });

    const claimed = await t.mutation(
      convexApi.runnerAdapterCommandRecoveries.claim,
      recoveryInput,
    ) as any;
    expect(claimed).toMatchObject({
      outcome: "claimed",
      claim: {
        commandId: fixture.commandId,
        commandFingerprint: fixture.commandFingerprint,
        runId: fixture.runId,
        runGeneration: fixture.runGeneration,
        leaseGeneration: fixture.leaseGeneration,
        recoveryGeneration: 1,
        actor: runnerB,
        checkpoint: {
          version: 1,
          externalId: checkpoint.externalId,
          checkpointDigest: checkpoint.digest,
          referenceSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          runGeneration: fixture.runGeneration,
          createdAt: checkpoint.createdAt,
        },
        authorizesRedispatch: false,
        authorizesResume: false,
      },
    });
    expect(await t.mutation(
      convexApi.runnerAdapterCommandRecoveries.claim,
      recoveryInput,
    )).toEqual({ ...claimed, outcome: "replayed" });
    await expect(t.mutation(convexApi.runnerAdapterCommandRecoveries.claim, {
      ...recoveryInput,
      leaseSeconds: 120,
    })).rejects.toThrow("another request");
    await expect(t.mutation(convexApi.runnerAdapterCommandRecoveries.claim, {
      ...recoveryInput,
      actor: runnerA,
      idempotencyKey: "hosted-recovery-competing",
    })).rejects.toThrow("active recovery owner");

    await t.run(async (ctx) => {
      const latest = (await ctx.db.query("runnerAdapterCommandRecoveries").collect())
        .find((entry) => entry.commandExternalId === fixture.commandId);
      if (!latest) throw new Error("Hosted recovery claim fixture disappeared");
      await ctx.db.patch(latest._id, { expiresAt: Date.now() - 1 });
    });
    const second = await t.mutation(convexApi.runnerAdapterCommandRecoveries.claim, {
      ...recoveryInput,
      actor: runnerA,
      idempotencyKey: "hosted-recovery-second",
    }) as any;
    expect(second).toMatchObject({
      outcome: "claimed",
      claim: {
        recoveryGeneration: 2,
        actor: runnerA,
        checkpoint: claimed.claim.checkpoint,
        authorizesRedispatch: false,
        authorizesResume: false,
      },
    });
  });

  test("keeps null checkpoint explicit and rejects recovery after settlement", async () => {
    const t = convexTest(schema, modules);
    const fixture = await reserveCommand(t, "hosted-recovery-settled");
    await t.run(async (ctx) => {
      const run = (await ctx.db.query("queuedRuns").collect())
        .find((entry) => entry.externalId === fixture.runId);
      if (!run) throw new Error("Hosted recovery run fixture disappeared");
      await ctx.db.patch(run._id, { leaseExpiresAt: Date.now() - 1 });
    });
    const first = await t.mutation(convexApi.runnerAdapterCommandRecoveries.claim, {
      ...baseArgs,
      commandId: fixture.commandId,
      commandFingerprint: fixture.commandFingerprint,
      actor: runnerB,
      leaseSeconds: 60,
      idempotencyKey: "hosted-null-checkpoint",
    }) as any;
    expect(first.claim.checkpoint).toBeNull();

    await t.mutation(convexApi.runnerAdapterCommands.settle, {
      ...baseArgs,
      commandId: fixture.commandId,
      commandFingerprint: fixture.commandFingerprint,
      outcome: {
        version: 1,
        kind: "bounded_episode_completed",
        observationCount: 1,
        observationsSha256: `sha256:${"1".repeat(64)}`,
        terminalObservationId: "hosted-recovery-terminal",
        terminalObservationType: "interrupted",
        latestCheckpointExternalId: null,
        latestCheckpointSha256: null,
        containsPrivateContent: false,
        containsCredentials: false,
      },
    });
    await t.run(async (ctx) => {
      const recovery = (await ctx.db.query("runnerAdapterCommandRecoveries").collect())[0];
      if (!recovery) throw new Error("Hosted recovery claim fixture disappeared");
      await ctx.db.patch(recovery._id, { expiresAt: Date.now() - 1 });
    });
    await expect(t.mutation(convexApi.runnerAdapterCommandRecoveries.claim, {
      ...baseArgs,
      commandId: fixture.commandId,
      commandFingerprint: fixture.commandFingerprint,
      actor: runnerA,
      leaseSeconds: 60,
      idempotencyKey: "hosted-after-settlement",
    })).rejects.toThrow("Settled runner adapter commands");
  });

  test("authorizes one recovery owner across concurrent hosted mutations", async () => {
    const t = convexTest(schema, modules);
    const fixture = await reserveCommand(t, "hosted-recovery-concurrent");
    await t.run(async (ctx) => {
      const run = (await ctx.db.query("queuedRuns").collect())
        .find((entry) => entry.externalId === fixture.runId);
      if (!run) throw new Error("Hosted recovery run fixture disappeared");
      await ctx.db.patch(run._id, { leaseExpiresAt: Date.now() - 1 });
    });

    const [alpha, beta] = await Promise.allSettled([
      t.mutation(convexApi.runnerAdapterCommandRecoveries.claim, {
        ...baseArgs,
        commandId: fixture.commandId,
        commandFingerprint: fixture.commandFingerprint,
        actor: runnerA,
        leaseSeconds: 60,
        idempotencyKey: "hosted-concurrent-alpha",
      }),
      t.mutation(convexApi.runnerAdapterCommandRecoveries.claim, {
        ...baseArgs,
        commandId: fixture.commandId,
        commandFingerprint: fixture.commandFingerprint,
        actor: runnerB,
        leaseSeconds: 60,
        idempotencyKey: "hosted-concurrent-beta",
      }),
    ]);
    expect([alpha, beta].filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect([alpha, beta].filter((result) => result.status === "rejected")).toHaveLength(1);
    const rows = await t.run(async (ctx) =>
      await ctx.db.query("runnerAdapterCommandRecoveries").collect()
    );
    expect(rows).toHaveLength(1);
    expect((rows[0]!.claim as any).authorizesRedispatch).toBe(false);
    expect((rows[0]!.claim as any).authorizesResume).toBe(false);
  });
});

async function reserveCommand(t: ReturnType<typeof convexTest>, label: string) {
  const item = await t.mutation(convexApi.items.create, {
    ...baseArgs,
    project: "adapter-recovery",
    kind: "task",
    title: `Recover ${label}`,
    nextAction: `Execute ${label}.`,
    priority: 80,
    actor: supervisor,
  }) as any;
  const runId = await t.run(async (ctx) => {
    const workspaceRow = (await ctx.db.query("workspaces").collect())
      .find((entry) => entry.slug === workspace);
    if (!workspaceRow) throw new Error("Workspace fixture disappeared");
    const project = (await ctx.db.query("projects").collect())
      .find((entry) =>
        entry.workspaceId === workspaceRow._id && entry.slug === "adapter-recovery"
      );
    const itemRow = (await ctx.db.query("items").collect())
      .find((entry) => entry.externalId === item.id);
    const actor = (await ctx.db.query("actors").collect())
      .find((entry) => entry.externalId === supervisor.id);
    if (!project || !itemRow || !actor) throw new Error("Hosted recovery fixture disappeared");
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
    const externalId = `run_${runDocId}`;
    await ctx.db.patch(runDocId, { externalId });
    return externalId;
  });
  const claimed = await t.mutation(convexApi.runnerRuns.claim, {
    ...baseArgs,
    actor: runnerA,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    project: "adapter-recovery",
    runId,
    leaseSeconds: 900,
    concurrency: { globalLimit: 4, projectLimit: 2 },
    idempotencyKey: `claim-${label}`,
  }) as any;
  const commandId = `command-${label}`;
  const commandFingerprint = `sha256:${"b".repeat(64)}`;
  await t.mutation(convexApi.runnerAdapterCommands.reserve, {
    ...baseArgs,
    project: "adapter-recovery",
    itemId: item.id,
    runId: claimed.id,
    runGeneration: claimed.generation,
    leaseGeneration: claimed.leaseGeneration,
    actor: runnerA,
    adapterId: "vercel-ai-sdk",
    profileId: "default",
    requestFingerprint: `sha256:${"a".repeat(64)}`,
    commandId,
    commandFingerprint,
    idempotencyKey: `reserve-${label}`,
  });
  return {
    runId: claimed.id as string,
    runGeneration: claimed.generation as number,
    leaseGeneration: claimed.leaseGeneration as number,
    commandId,
    commandFingerprint,
  };
}

function checkpointReference(runGeneration: number) {
  return {
    version: 1 as const,
    kind: "checkpoint" as const,
    adapterId: "vercel-ai-sdk",
    externalId: "hosted-recovery-checkpoint-opaque",
    digest: `sha256:${"c".repeat(64)}`,
    uri: null,
    generation: runGeneration,
    createdAt: "2026-08-13T04:00:00.000Z",
    accessClass: "private" as const,
    containsPrivateContent: false as const,
    containsCredentials: false as const,
  };
}
