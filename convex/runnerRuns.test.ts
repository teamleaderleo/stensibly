import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { appendExecutionEnvelopeEvent } from "./lib/executionEnvelope";
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
const executionEnvelope = {
  schemaVersion: 1 as const,
  objective: "Execute the hosted runner contract",
  scopeClass: "segmented" as const,
  estimate: { lowMinutes: 10, likelyMinutes: 20, highMinutes: 40, confidence: 0.7 },
  budget: { expectedMessages: 3, expectedToolCalls: 12, expectedReviewMinutes: 5 },
  boundaries: { softCheckpointMinutes: 20, forcedHandoffMinutes: 40, hardRecoveryMinutes: 60 },
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

describe("hosted runner ledger parity", () => {
  test("atomically claims one queued run, transfers item authority, and replays", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedRun(t, { project: "alpha", title: "Claim hosted work" });
    const input = claimInput({
      project: "alpha",
      externalRunId: "runner-session-a",
      idempotencyKey: "claim-hosted-a",
    });

    const claimed = await t.mutation(convexApi.runnerRuns.claim, input) as any;
    expect(claimed).toMatchObject({
      id: seeded.runId,
      itemId: seeded.itemId,
      actorId: runnerA.id,
      leaseOwnerId: runnerA.id,
      status: "starting",
      generation: 2,
      leaseGeneration: 2,
      externalRunId: "runner-session-a",
    });
    expect(await t.mutation(convexApi.runnerRuns.claim, input)).toEqual(claimed);
    expect(await t.mutation(convexApi.runnerRuns.claim, claimInput({
      actor: runnerB,
      project: "alpha",
      idempotencyKey: "claim-hosted-b",
    }))).toBeNull();
    await expect(t.mutation(convexApi.runnerRuns.claim, {
      ...input,
      runnerProfile: "different-profile",
    })).rejects.toThrow("different runner command");

    const state = await rawState(t, seeded.runId);
    expect(state.item).toMatchObject({
      status: "active",
      claimedByExternalId: runnerA.id,
      claimExpiresAt: expect.any(Number),
      claimGeneration: 0,
    });
    expect(state.events.filter((event: any) => event.type === "run.starting")).toHaveLength(1);
    expect(state.commands).toHaveLength(2);

    const heldT = convexTest(schema, modules);
    const held = await seedRun(heldT, {
      project: "alpha",
      title: "Do not steal indefinite item authority",
    });
    await heldT.run(async (ctx) => {
      const run = (await ctx.db.query("queuedRuns").collect())
        .find((entry) => entry.externalId === held.runId);
      const workspaceRow = (await ctx.db.query("workspaces").collect())
        .find((entry) => entry.slug === workspace);
      if (!run || !workspaceRow) throw new Error("Held fixture disappeared");
      const item = await ctx.db.get("items", run.itemId);
      if (!item) throw new Error("Held item fixture disappeared");
      const holderId = await ctx.db.insert("actors", {
        workspaceId: workspaceRow._id,
        externalId: "agent:indefinite-holder",
        name: "Indefinite Holder",
        kind: "agent",
        updatedAt: Date.now(),
      });
      await ctx.db.patch(item._id, {
        status: "active",
        claimedByActorId: holderId,
        claimedByExternalId: "agent:indefinite-holder",
        claimExpiresAt: undefined,
      });
    });
    await expect(heldT.mutation(convexApi.runnerRuns.claim, claimInput({
      project: "alpha",
    }))).rejects.toThrow("actively claimed by another actor");
  });

  test("heartbeats and transitions preserve exact fences, item projection, and terminal actuals", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedRun(t, {
      project: "alpha",
      title: "Finish hosted work",
      executionEnvelope,
    });
    const claimed = await t.mutation(
      convexApi.runnerRuns.claim,
      claimInput({ project: "alpha" }),
    ) as any;
    const running = await t.mutation(convexApi.runnerRuns.transition, {
      ...baseArgs,
      id: claimed.id,
      actor: runnerA,
      command: "run",
      expectedGeneration: claimed.generation,
      expectedLeaseGeneration: claimed.leaseGeneration,
      leaseSeconds: 900,
      idempotencyKey: "run-hosted-a",
    }) as any;
    expect(running).toMatchObject({ status: "running", generation: 3 });

    const heartbeatInput = {
      ...baseArgs,
      id: running.id,
      actor: runnerA,
      expectedGeneration: running.generation,
      expectedLeaseGeneration: running.leaseGeneration,
      leaseSeconds: 1_800,
      checkpoint: "Provider execution remains healthy.",
      usage: { inputTokens: 100, toolCalls: 2 },
      idempotencyKey: "heartbeat-hosted-a",
    };
    const heartbeat = await t.mutation(convexApi.runnerRuns.heartbeat, heartbeatInput) as any;
    const beforeReplay = await rawState(t, seeded.runId);
    expect(heartbeat).toMatchObject({
      generation: running.generation,
      checkpoint: "Provider execution remains healthy.",
      usage: { inputTokens: 100, toolCalls: 2 },
    });
    expect(await t.mutation(convexApi.runnerRuns.heartbeat, heartbeatInput)).toEqual(heartbeat);
    const afterReplay = await rawState(t, seeded.runId);
    expect(afterReplay.item.version).toBe(beforeReplay.item.version);
    await expect(t.mutation(convexApi.runnerRuns.heartbeat, {
      ...heartbeatInput,
      expectedGeneration: running.generation - 1,
      idempotencyKey: "heartbeat-stale-generation",
    })).rejects.toThrow("generation changed");
    await expect(t.mutation(convexApi.runnerRuns.heartbeat, {
      ...heartbeatInput,
      expectedLeaseGeneration: running.leaseGeneration + 1,
      idempotencyKey: "heartbeat-stale-lease-generation",
    })).rejects.toThrow("lease generation changed");
    await expect(t.mutation(convexApi.runnerRuns.heartbeat, {
      ...heartbeatInput,
      actor: runnerB,
      idempotencyKey: "heartbeat-foreign-holder",
    })).rejects.toThrow("current run lease owner");

    const finishInput = {
      ...baseArgs,
      id: heartbeat.id,
      actor: runnerA,
      command: "succeed" as const,
      expectedGeneration: heartbeat.generation,
      expectedLeaseGeneration: heartbeat.leaseGeneration,
      leaseSeconds: 900,
      outcome: "Hosted runner completed and verified the work.",
      usage: { outputTokens: 50, toolCalls: 3 },
      executionActual: { durationMinutes: 18, toolCalls: 3, filesChanged: 2 },
      idempotencyKey: "succeed-hosted-a",
    };
    const succeeded = await t.mutation(convexApi.runnerRuns.transition, finishInput) as any;
    expect(succeeded).toMatchObject({
      status: "succeeded",
      generation: heartbeat.generation + 1,
      leaseOwnerId: null,
      outcome: "Hosted runner completed and verified the work.",
      usage: { inputTokens: 100, outputTokens: 50, toolCalls: 3 },
      executionEnvelope,
      executionRecords: [{
        transition: "succeed",
        actual: finishInput.executionActual,
      }],
    });
    expect(await t.mutation(convexApi.runnerRuns.transition, finishInput)).toEqual(succeeded);
    await expect(t.mutation(convexApi.runnerRuns.transition, {
      ...finishInput,
      outcome: "Changed replay",
    })).rejects.toThrow("different runner command");
    const completedItem = (await rawState(t, seeded.runId)).item;
    expect(completedItem).toMatchObject({
      status: "done",
      summary: "Hosted runner completed and verified the work.",
    });
    expect(completedItem.claimedByExternalId).toBeUndefined();
    expect(completedItem.claimExpiresAt).toBeUndefined();
    const envelopeReferences = (await rawState(t, seeded.runId)).events
      .filter((event: any) => event.type === "run.envelope_reference")
      .map((event: any) => event.payload.lifecycleEventType);
    expect(envelopeReferences).toEqual(expect.arrayContaining([
      "run.created",
      "run.heartbeat",
      "run.succeeded",
    ]));
  });

  test("enforces global and per-project capacity while skipping saturated projects", async () => {
    const t = convexTest(schema, modules);
    const alphaFirst = await seedRun(t, {
      project: "alpha",
      title: "Alpha first",
      createdAt: Date.now() - 3_000,
    });
    await seedRun(t, {
      project: "alpha",
      title: "Alpha second",
      status: "failed",
      retryAttempt: 1,
      nextRetryAt: Date.now() - 1_000,
      itemStatus: "blocked",
      createdAt: Date.now() - 2_000,
    });
    const beta = await seedRun(t, {
      project: "beta",
      title: "Beta first",
      createdAt: Date.now() - 1_000,
    });
    const concurrency = { globalLimit: 3, projectLimit: 1 };

    const first = await t.mutation(convexApi.runnerRuns.claim, claimInput({
      project: "alpha",
      runId: alphaFirst.runId,
      concurrency,
    })) as any;
    expect(first.id).toBe(alphaFirst.runId);
    const next = await t.mutation(convexApi.runnerRuns.claim, claimInput({
      actor: runnerB,
      concurrency,
    })) as any;
    expect(next.id).toBe(beta.runId);

    const globalT = convexTest(schema, modules);
    await seedRun(globalT, { project: "alpha", title: "Global first" });
    await seedRun(globalT, { project: "beta", title: "Global second" });
    expect(await globalT.mutation(convexApi.runnerRuns.claim, claimInput({
      project: "alpha",
      concurrency: { globalLimit: 1, projectLimit: 1 },
    }))).not.toBeNull();
    expect(await globalT.mutation(convexApi.runnerRuns.claim, claimInput({
      actor: runnerB,
      project: "beta",
      concurrency: { globalLimit: 1, projectLimit: 1 },
    }))).toBeNull();
  });

  test("rejects expired authority and rolls back when item ownership diverges", async () => {
    const expiryT = convexTest(schema, modules);
    const expired = await seedRun(expiryT, {
      project: "authority",
      title: "Reject expired authority",
    });
    const expiredClaim = await expiryT.mutation(
      convexApi.runnerRuns.claim,
      claimInput({ project: "authority" }),
    ) as any;
    await expiryT.run(async (ctx) => {
      const run = (await ctx.db.query("queuedRuns").collect())
        .find((entry) => entry.externalId === expired.runId);
      if (!run) throw new Error("Expired run fixture disappeared");
      await ctx.db.patch(run._id, { leaseExpiresAt: Date.now() - 1 });
    });
    await expect(expiryT.mutation(convexApi.runnerRuns.transition, {
      ...baseArgs,
      id: expiredClaim.id,
      actor: runnerA,
      command: "run",
      expectedGeneration: expiredClaim.generation,
      expectedLeaseGeneration: expiredClaim.leaseGeneration,
      leaseSeconds: 900,
    })).rejects.toThrow("lease has expired");
    expect((await rawState(expiryT, expired.runId)).run).toMatchObject({
      status: "starting",
      generation: expiredClaim.generation,
    });

    const conflictT = convexTest(schema, modules);
    const conflicted = await seedRun(conflictT, {
      project: "authority",
      title: "Reject item ownership drift",
    });
    const conflictClaim = await conflictT.mutation(
      convexApi.runnerRuns.claim,
      claimInput({ project: "authority" }),
    ) as any;
    await conflictT.run(async (ctx) => {
      const workspaceRow = (await ctx.db.query("workspaces").collect())
        .find((entry) => entry.slug === workspace);
      if (!workspaceRow) throw new Error("Workspace fixture disappeared");
      const run = (await ctx.db.query("queuedRuns").collect())
        .find((entry) => entry.externalId === conflicted.runId);
      if (!run) throw new Error("Conflicted run fixture disappeared");
      const item = await ctx.db.get("items", run.itemId);
      if (!item) throw new Error("Conflicted item fixture disappeared");
      const competitorId = await ctx.db.insert("actors", {
        workspaceId: workspaceRow._id,
        externalId: "agent:competitor",
        name: "Competitor",
        kind: "agent",
        updatedAt: Date.now(),
      });
      await ctx.db.patch(item._id, {
        status: "active",
        claimedByActorId: competitorId,
        claimedByExternalId: "agent:competitor",
        claimExpiresAt: Date.now() + 900_000,
      });
    });
    await expect(conflictT.mutation(convexApi.runnerRuns.transition, {
      ...baseArgs,
      id: conflictClaim.id,
      actor: runnerA,
      command: "succeed",
      expectedGeneration: conflictClaim.generation,
      expectedLeaseGeneration: conflictClaim.leaseGeneration,
      leaseSeconds: 900,
      outcome: "Must roll back.",
    })).rejects.toThrow("item ownership or status changed");
    const unchangedRun = (await rawState(conflictT, conflicted.runId)).run;
    expect(unchangedRun).toMatchObject({
      status: "starting",
      generation: conflictClaim.generation,
    });
    expect(unchangedRun.outcome).toBeUndefined();
  });

  test("reclaims retry-eligible failure and reconciles an expired queue lease", async () => {
    const retryT = convexTest(schema, modules);
    const retry = await seedRun(retryT, {
      project: "recovery",
      title: "Retry hosted work",
      status: "failed",
      retryAttempt: 1,
      nextRetryAt: Date.now() - 1_000,
      itemStatus: "blocked",
    });
    const claimed = await retryT.mutation(convexApi.runnerRuns.claim, claimInput({
      project: "recovery",
      runId: retry.runId,
    })) as any;
    expect(claimed).toMatchObject({
      id: retry.runId,
      status: "starting",
      actorId: runnerA.id,
      leaseOwnerId: runnerA.id,
      retryAttempt: 1,
      nextRetryAt: null,
    });

    const expiryT = convexTest(schema, modules);
    const expired = await seedRun(expiryT, {
      project: "recovery",
      title: "Expire hosted queue",
      leaseExpiresAt: Date.now() - 1_000,
      itemStatus: "active",
      itemHolder: supervisor.id,
    });
    expect(await expiryT.mutation(convexApi.runnerRuns.reconcile, baseArgs)).toBeNull();
    const reconciled = await expiryT.mutation(convexApi.runnerRuns.get, {
      ...baseArgs,
      id: expired.runId,
    }) as any;
    expect(reconciled).toMatchObject({
      status: "abandoned",
      generation: 2,
      leaseOwnerId: null,
      outcome: "Run lease expired before a runner claimed it.",
    });
    const releasedItem = (await rawState(expiryT, expired.runId)).item;
    expect(releasedItem.status).toBe("ready");
    expect(releasedItem.claimedByExternalId).toBeUndefined();
    expect(releasedItem.claimExpiresAt).toBeUndefined();
  });

  test("lists only workspace-scoped queued runs through bounded indexed filters", async () => {
    const t = convexTest(schema, modules);
    const alpha = await seedRun(t, { project: "alpha", title: "List alpha" });
    await seedRun(t, { project: "beta", title: "List beta", actor: runnerB });
    const listed = await t.mutation(convexApi.runnerRuns.list, {
      ...baseArgs,
      itemId: alpha.itemId,
      actorId: supervisor.id,
      status: "queued",
    }) as any[];
    expect(listed.map((run) => run.id)).toEqual([alpha.runId]);
    await expect(t.mutation(convexApi.runnerRuns.get, {
      serviceSecret: secret,
      workspace: "other-workspace",
      id: alpha.runId,
    })).rejects.toThrow("does not exist");
  });

  test("claims a safe scanned candidate while list fails closed on an incomplete window", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedRun(t, {
      project: "bounded",
      title: "Bound candidate and list scans",
    });
    const extras = await cloneRun(t, seeded.runId, 100, {});
    const input = claimInput({ idempotencyKey: "bounded-candidate-claim" });

    await expect(t.mutation(convexApi.runnerRuns.list, {
      ...baseArgs,
      itemId: seeded.itemId,
      actorId: supervisor.id,
      status: "queued",
    })).rejects.toThrow("runner_list_scan_incomplete");
    expect(await t.mutation(convexApi.runnerRuns.claim, input)).toMatchObject({
      id: seeded.runId,
      status: "starting",
    });
    expect(extras).toHaveLength(100);
  });

  test("does not durably replay null when a saturated prefix leaves candidates unscanned", async () => {
    const t = convexTest(schema, modules);
    const alphaActive = await seedRun(t, {
      project: "alpha",
      title: "Saturate alpha",
      createdAt: Date.now() - 4_000,
    });
    await t.mutation(convexApi.runnerRuns.claim, claimInput({
      project: "alpha",
      runId: alphaActive.runId,
      concurrency: { globalLimit: 3, projectLimit: 1 },
    }));
    const alphaQueued = await seedRun(t, {
      project: "alpha",
      title: "Fill the bounded prefix",
      createdAt: Date.now() - 3_000,
    });
    const extras = await cloneRun(t, alphaQueued.runId, 99, {});
    const beta = await seedRun(t, {
      project: "beta",
      title: "Remain beyond the prefix",
      createdAt: Date.now() - 1_000,
    });
    const input = claimInput({
      actor: runnerB,
      idempotencyKey: "incomplete-prefix-claim",
      concurrency: { globalLimit: 3, projectLimit: 1 },
    });

    await expect(t.mutation(convexApi.runnerRuns.claim, input))
      .rejects.toThrow("runner_candidate_scan_incomplete");
    expect((await t.run(async (ctx) =>
      await ctx.db.query("runnerCommands").collect()
    )).find((command) => command.idempotencyKey === "incomplete-prefix-claim"))
      .toBeUndefined();

    await t.run(async (ctx) => await ctx.db.delete(extras[0]!));
    expect(await t.mutation(convexApi.runnerRuns.claim, input)).toMatchObject({
      id: beta.runId,
      status: "starting",
    });
  });

  test("rolls back and reports an incomplete expired-run drain", async () => {
    const t = convexTest(schema, modules);
    const expiredAt = Date.now() - 1_000;
    const seeded = await seedRun(t, {
      project: "bounded",
      title: "Bound expired reconciliation",
      leaseExpiresAt: expiredAt,
      itemStatus: "active",
      itemHolder: supervisor.id,
    });
    await cloneRun(t, seeded.runId, 100, { leaseExpiresAt: expiredAt });

    await expect(t.mutation(convexApi.runnerRuns.list, baseArgs))
      .rejects.toThrow("runner_reconciliation_incomplete");
    const statuses = await t.run(async (ctx) =>
      (await ctx.db.query("queuedRuns").collect()).map((run) => run.status)
    );
    expect(statuses).toHaveLength(101);
    expect(statuses.every((status) => status === "queued")).toBe(true);
  });

  test("reserves one hosted adapter command and replays immutable winner evidence", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedRun(t, {
      project: "adapter",
      title: "Reserve hosted adapter dispatch",
    });
    const claimed = await t.mutation(convexApi.runnerRuns.claim, claimInput({
      project: "adapter",
      runId: seeded.runId,
    })) as any;
    const input = {
      ...baseArgs,
      project: "adapter",
      itemId: seeded.itemId,
      runId: claimed.id,
      runGeneration: claimed.generation,
      leaseGeneration: claimed.leaseGeneration,
      actor: runnerA,
      adapterId: claimed.runnerType,
      profileId: claimed.runnerProfile,
      profileVersion: claimed.runnerProfileVersion ?? null,
      requestFingerprint: `sha256:${"a".repeat(64)}`,
      commandId: "hosted-command-winner",
      commandFingerprint: `sha256:${"b".repeat(64)}`,
      idempotencyKey: "reserve-hosted-adapter-command",
    };

    const reserved = await t.mutation(convexApi.runnerAdapterCommands.reserve, input) as any;
    expect(reserved).toMatchObject({
      outcome: "reserved",
      dispatchAuthorized: true,
      command: {
        commandId: "hosted-command-winner",
        commandFingerprint: `sha256:${"b".repeat(64)}`,
      },
    });
    const replayed = await t.mutation(convexApi.runnerAdapterCommands.reserve, {
      ...input,
      commandId: "rebuilt-after-context-change",
      commandFingerprint: `sha256:${"c".repeat(64)}`,
    }) as any;
    expect(replayed).toEqual({
      ...reserved,
      outcome: "replayed",
      dispatchAuthorized: false,
    });
    const outcome = {
      version: 1,
      kind: "bounded_episode_completed",
      observationCount: 6,
      observationsSha256: `sha256:${"1".repeat(64)}`,
      terminalObservationId: "hosted-terminal-observation",
      terminalObservationType: "interrupted",
      latestCheckpointExternalId: "hosted-checkpoint-opaque",
      latestCheckpointSha256: `sha256:${"2".repeat(64)}`,
      containsPrivateContent: false,
      containsCredentials: false,
    };
    const settled = await t.mutation(convexApi.runnerAdapterCommands.settle, {
      ...baseArgs,
      commandId: reserved.command.commandId,
      commandFingerprint: reserved.command.commandFingerprint,
      outcome,
    }) as any;
    expect(settled).toMatchObject({
      outcome: "settled",
      settlement: { outcome, outcomeSha256: expect.stringMatching(/^sha256:/) },
    });
    expect(await t.mutation(convexApi.runnerAdapterCommands.settle, {
      ...baseArgs,
      commandId: reserved.command.commandId,
      commandFingerprint: reserved.command.commandFingerprint,
      outcome,
    })).toEqual({ ...settled, outcome: "replayed" });
    const settledReservation = await t.mutation(convexApi.runnerAdapterCommands.reserve, {
      ...input,
      commandId: "rebuilt-after-settlement",
      commandFingerprint: `sha256:${"e".repeat(64)}`,
    }) as any;
    expect(settledReservation).toMatchObject({
      outcome: "replayed",
      dispatchAuthorized: false,
      settlement: settled.settlement,
    });
    await expect(t.mutation(convexApi.runnerAdapterCommands.settle, {
      ...baseArgs,
      commandId: reserved.command.commandId,
      commandFingerprint: reserved.command.commandFingerprint,
      outcome: { ...outcome, observationCount: 5 },
    })).rejects.toThrow("another outcome");
    await expect(t.mutation(convexApi.runnerAdapterCommands.reserve, {
      ...input,
      requestFingerprint: `sha256:${"d".repeat(64)}`,
    })).rejects.toThrow("different command");
    await expect(t.mutation(convexApi.runnerAdapterCommands.reserve, {
      ...input,
      profileId: "altered-profile",
    })).rejects.toThrow("different command");
    await expect(t.mutation(convexApi.runnerAdapterCommands.reserve, {
      ...input,
      idempotencyKey: "different-idempotency-key",
    })).rejects.toThrow("different idempotency key");
    expect(await t.run(async (ctx) =>
      await ctx.db.query("runnerAdapterCommands").collect()
    )).toHaveLength(1);
  });
});

const baseArgs = { serviceSecret: secret, workspace };

function claimInput(overrides: Record<string, unknown> = {}) {
  return {
    ...baseArgs,
    actor: runnerA,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    leaseSeconds: 900,
    concurrency: { globalLimit: 4, projectLimit: 2 },
    ...overrides,
  };
}

async function seedRun(
  t: ReturnType<typeof convexTest>,
  input: {
    project: string;
    title: string;
    actor?: typeof supervisor | typeof runnerB;
    status?: "queued" | "failed";
    retryAttempt?: number;
    nextRetryAt?: number;
    leaseExpiresAt?: number;
    itemStatus?: "ready" | "active" | "blocked";
    itemHolder?: string;
    createdAt?: number;
    executionEnvelope?: typeof executionEnvelope;
  },
) {
  const actor = input.actor ?? supervisor;
  const item = await t.mutation(convexApi.items.create, {
    ...baseArgs,
    project: input.project,
    kind: "task",
    title: input.title,
    nextAction: `Execute ${input.title}.`,
    priority: 80,
    actor,
  }) as any;
  return await t.run(async (ctx) => {
    const workspaceRow = (await ctx.db.query("workspaces").collect())
      .find((entry) => entry.slug === workspace);
    if (!workspaceRow) throw new Error("Workspace fixture disappeared");
    const project = (await ctx.db.query("projects").collect())
      .find((entry) => entry.workspaceId === workspaceRow._id && entry.slug === input.project);
    const itemRow = (await ctx.db.query("items").collect())
      .find((entry) => entry.workspaceId === workspaceRow._id && entry.externalId === item.id);
    const actorRow = (await ctx.db.query("actors").collect())
      .find((entry) => entry.workspaceId === workspaceRow._id && entry.externalId === actor.id);
    if (!project || !itemRow || !actorRow) throw new Error("Runner fixture disappeared");
    let holderRow = actorRow;
    if (input.itemHolder && input.itemHolder !== actor.id) {
      const existing = (await ctx.db.query("actors").collect())
        .find((entry) =>
          entry.workspaceId === workspaceRow._id && entry.externalId === input.itemHolder
        );
      if (!existing) throw new Error("Item holder fixture does not exist");
      holderRow = existing;
    }
    const now = input.createdAt ?? Date.now();
    const leaseExpiresAt = input.leaseExpiresAt ?? now + 900_000;
    if (input.itemStatus && input.itemStatus !== "ready") {
      await ctx.db.patch(itemRow._id, {
        status: input.itemStatus,
        ...(input.itemStatus === "active"
          ? {
            claimedByActorId: holderRow._id,
            claimedByExternalId: holderRow.externalId,
            claimExpiresAt: leaseExpiresAt,
          }
          : {}),
      });
    }
    const runDocId = await ctx.db.insert("queuedRuns", {
      workspaceId: workspaceRow._id,
      projectId: project._id,
      itemId: itemRow._id,
      externalId: "pending",
      actorId: actorRow._id,
      actorExternalId: actorRow.externalId,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      status: input.status ?? "queued",
      generation: 1,
      leaseGeneration: 1,
      leaseOwnerExternalId: actorRow.externalId,
      leaseExpiresAt: input.status === "failed" ? undefined : leaseExpiresAt,
      usage: {},
      retryAttempt: input.retryAttempt ?? 0,
      maxAttempts: 3,
      retryBackoffSeconds: 30,
      nextRetryAt: input.nextRetryAt,
      createdAt: now,
      updatedAt: now,
    });
    const runId = `run_${runDocId}`;
    await ctx.db.patch(runDocId, { externalId: runId });
    if (input.executionEnvelope) {
      await appendExecutionEnvelopeEvent(ctx, {
        workspaceId: workspaceRow._id,
        projectId: project._id,
        itemId: itemRow._id,
        actorId: actorRow._id,
        actorExternalId: actorRow.externalId,
        runId,
        runGeneration: 1,
        leaseGeneration: 1,
        envelope: input.executionEnvelope,
        createdAt: now,
      });
    }
    return { itemId: item.id as string, runId };
  });
}

async function rawState(t: ReturnType<typeof convexTest>, runId: string) {
  return await t.run(async (ctx) => {
    const run = (await ctx.db.query("queuedRuns").collect())
      .find((entry) => entry.externalId === runId);
    if (!run) throw new Error("Run fixture disappeared");
    const item = await ctx.db.get("items", run.itemId);
    if (!item) throw new Error("Item fixture disappeared");
    const events = (await ctx.db.query("events").collect())
      .filter((entry) => entry.itemId === item._id);
    const commands = await ctx.db.query("runnerCommands").collect();
    return { run, item, events, commands };
  });
}

async function cloneRun(
  t: ReturnType<typeof convexTest>,
  runId: string,
  count: number,
  patch: { leaseExpiresAt?: number },
) {
  return await t.run(async (ctx) => {
    const source = (await ctx.db.query("queuedRuns").collect())
      .find((entry) => entry.externalId === runId);
    if (!source) throw new Error("Clone source run disappeared");
    const { _id: _sourceId, _creationTime: _sourceCreated, ...fields } = source;
    const ids = [];
    for (let index = 0; index < count; index += 1) {
      ids.push(await ctx.db.insert("queuedRuns", {
        ...fields,
        ...patch,
        externalId: `${runId}-clone-${String(index).padStart(3, "0")}`,
        createdAt: fields.createdAt + index + 1,
        updatedAt: fields.updatedAt + index + 1,
      }));
    }
    return ids;
  });
}
