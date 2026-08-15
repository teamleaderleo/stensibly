import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const baseArgs = { serviceSecret: secret, workspace };
const supervisor = {
  id: "service:lookup-supervisor",
  name: "Lookup Supervisor",
  kind: "service" as const,
};
const runner = {
  id: "agent:lookup-runner",
  name: "Lookup Runner",
  kind: "agent" as const,
};

beforeEach(() => vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret));

describe("hosted runner adapter command lookup", () => {
  test("reads the exact durable reservation and later settlement without authorizing dispatch", async () => {
    const t = convexTest(schema, modules);
    const fixture = await reserveCommand(t);

    expect(await t.query(convexApi.runnerAdapterCommands.getByIdempotencyKey, {
      ...baseArgs,
      idempotencyKey: "lookup-reservation",
    })).toMatchObject({
      outcome: "replayed",
      dispatchAuthorized: false,
      command: {
        commandId: fixture.commandId,
        commandFingerprint: fixture.commandFingerprint,
        runId: fixture.runId,
        runGeneration: fixture.runGeneration,
        leaseGeneration: fixture.leaseGeneration,
        idempotencyKey: "lookup-reservation",
      },
      settlement: null,
    });
    expect(await t.query(convexApi.runnerAdapterCommands.getByIdempotencyKey, {
      ...baseArgs,
      idempotencyKey: "lookup-missing",
    })).toBeNull();

    await t.mutation(convexApi.runnerAdapterCommands.settle, {
      ...baseArgs,
      commandId: fixture.commandId,
      commandFingerprint: fixture.commandFingerprint,
      outcome: {
        version: 1,
        kind: "bounded_episode_completed",
        observationCount: 1,
        observationsSha256: `sha256:${"1".repeat(64)}`,
        terminalObservationId: "lookup-terminal",
        terminalObservationType: "interrupted",
        latestCheckpointExternalId: null,
        latestCheckpointSha256: null,
        containsPrivateContent: false,
        containsCredentials: false,
      },
    });

    expect(await t.query(convexApi.runnerAdapterCommands.getByIdempotencyKey, {
      ...baseArgs,
      idempotencyKey: "lookup-reservation",
    })).toMatchObject({
      outcome: "replayed",
      dispatchAuthorized: false,
      command: {
        commandId: fixture.commandId,
        commandFingerprint: fixture.commandFingerprint,
      },
      settlement: {
        commandId: fixture.commandId,
        commandFingerprint: fixture.commandFingerprint,
        outcome: {
          kind: "bounded_episode_completed",
          observationCount: 1,
        },
      },
    });
  });
});

async function reserveCommand(t: ReturnType<typeof convexTest>) {
  const item = await t.mutation(convexApi.items.create, {
    ...baseArgs,
    project: "adapter-command-lookup",
    kind: "task",
    title: "Read one durable adapter command",
    nextAction: "Look up the command by its idempotency identity.",
    priority: 80,
    actor: supervisor,
  }) as any;
  const runId = await t.run(async (ctx) => {
    const workspaceRow = (await ctx.db.query("workspaces").collect())
      .find((entry) => entry.slug === workspace);
    if (!workspaceRow) throw new Error("Workspace fixture disappeared");
    const project = (await ctx.db.query("projects").collect())
      .find((entry) =>
        entry.workspaceId === workspaceRow._id && entry.slug === "adapter-command-lookup"
      );
    const itemRow = (await ctx.db.query("items").collect())
      .find((entry) => entry.externalId === item.id);
    const actor = (await ctx.db.query("actors").collect())
      .find((entry) => entry.externalId === supervisor.id);
    if (!project || !itemRow || !actor) throw new Error("Lookup fixture disappeared");
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
    actor: runner,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    project: "adapter-command-lookup",
    runId,
    leaseSeconds: 900,
    concurrency: { globalLimit: 4, projectLimit: 2 },
    idempotencyKey: "lookup-claim",
  }) as any;
  const commandId = "command-hosted-lookup";
  const commandFingerprint = `sha256:${"b".repeat(64)}`;
  await t.mutation(convexApi.runnerAdapterCommands.reserve, {
    ...baseArgs,
    project: "adapter-command-lookup",
    itemId: item.id,
    runId: claimed.id,
    runGeneration: claimed.generation,
    leaseGeneration: claimed.leaseGeneration,
    actor: runner,
    adapterId: "vercel-ai-sdk",
    profileId: "default",
    requestFingerprint: `sha256:${"a".repeat(64)}`,
    commandId,
    commandFingerprint,
    idempotencyKey: "lookup-reservation",
  });
  return {
    runId: claimed.id as string,
    runGeneration: claimed.generation as number,
    leaseGeneration: claimed.leaseGeneration as number,
    commandId,
    commandFingerprint,
  };
}
