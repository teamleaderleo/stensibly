import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const supervisor = {
  id: "service:runner-read-supervisor",
  name: "Runner Read Supervisor",
  kind: "service" as const,
};
const runner = {
  id: "agent:runner-read",
  name: "Runner Read",
  kind: "agent" as const,
};
const baseArgs = { serviceSecret: secret, workspace };

beforeEach(() => vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret));

describe("hosted runner adapter command read", () => {
  test("returns exact durable reservation and settlement by idempotency identity", async () => {
    const t = convexTest(schema, modules);
    const fixture = await reserveCommand(t, "hosted-runner-read");

    expect(await t.query(convexApi.runnerAdapterCommands.get, {
      ...baseArgs,
      idempotencyKey: "missing-runner-command",
    })).toBeNull();

    const reserved = await t.query(convexApi.runnerAdapterCommands.get, {
      ...baseArgs,
      idempotencyKey: fixture.idempotencyKey,
    }) as any;
    expect(reserved).toMatchObject({
      command: {
        commandId: fixture.commandId,
        commandFingerprint: fixture.commandFingerprint,
        runId: fixture.runId,
        runGeneration: fixture.runGeneration,
        leaseGeneration: fixture.leaseGeneration,
        idempotencyKey: fixture.idempotencyKey,
      },
      settlement: null,
    });

    const settled = await t.mutation(convexApi.runnerAdapterCommands.settle, {
      ...baseArgs,
      commandId: fixture.commandId,
      commandFingerprint: fixture.commandFingerprint,
      outcome: commandOutcome("hosted-runner-read-terminal"),
    }) as any;
    expect(await t.query(convexApi.runnerAdapterCommands.get, {
      ...baseArgs,
      idempotencyKey: fixture.idempotencyKey,
    })).toEqual({
      command: reserved.command,
      settlement: settled.settlement,
    });
  });

  test("keeps the read service-authenticated and validates the lookup key", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(convexApi.runnerAdapterCommands.get, {
      serviceSecret: "wrong-secret",
      workspace,
      idempotencyKey: "runner-read-key",
    })).rejects.toThrow();
    await expect(t.query(convexApi.runnerAdapterCommands.get, {
      ...baseArgs,
      idempotencyKey: "   ",
    })).rejects.toThrow("between 1 and 240 characters");
  });

  test("rejects a stored settlement bound to another command identity", async () => {
    const t = convexTest(schema, modules);
    const fixture = await reserveCommand(t, "hosted-runner-read-mismatch");
    await t.mutation(convexApi.runnerAdapterCommands.settle, {
      ...baseArgs,
      commandId: fixture.commandId,
      commandFingerprint: fixture.commandFingerprint,
      outcome: commandOutcome("hosted-runner-read-mismatch-terminal"),
    });
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("runnerAdapterCommands").collect())
        .find((entry) => entry.commandId === fixture.commandId);
      if (!row || row.settlement === undefined) {
        throw new Error("Hosted runner command settlement fixture disappeared");
      }
      await ctx.db.patch(row._id, {
        settlement: {
          ...(row.settlement as Record<string, unknown>),
          commandId: "command-hosted-runner-read-corrupt",
        },
      });
    });

    await expect(t.query(convexApi.runnerAdapterCommands.get, {
      ...baseArgs,
      idempotencyKey: fixture.idempotencyKey,
    })).rejects.toThrow("settlement changed command identity");
  });
});

async function reserveCommand(t: ReturnType<typeof convexTest>, label: string) {
  const item = await t.mutation(convexApi.items.create, {
    ...baseArgs,
    project: "runner_read",
    kind: "task",
    title: `Read ${label}`,
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
        entry.workspaceId === workspaceRow._id && entry.slug === "runner_read"
      );
    const itemRow = (await ctx.db.query("items").collect())
      .find((entry) => entry.externalId === item.id);
    const actor = (await ctx.db.query("actors").collect())
      .find((entry) => entry.externalId === supervisor.id);
    if (!project || !itemRow || !actor) {
      throw new Error("Hosted runner read fixture disappeared");
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
    project: "runner_read",
    runId,
    leaseSeconds: 900,
    concurrency: { globalLimit: 4, projectLimit: 2 },
    idempotencyKey: `claim-${label}`,
  }) as any;
  const commandId = `command-${label}`;
  const commandFingerprint = `sha256:${"b".repeat(64)}`;
  const idempotencyKey = `reserve-${label}`;
  await t.mutation(convexApi.runnerAdapterCommands.reserve, {
    ...baseArgs,
    project: "runner_read",
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
    idempotencyKey,
  });
  return {
    runId: claimed.id as string,
    runGeneration: claimed.generation as number,
    leaseGeneration: claimed.leaseGeneration as number,
    commandId,
    commandFingerprint,
    idempotencyKey,
  };
}

function commandOutcome(terminalObservationId: string) {
  return {
    version: 1 as const,
    kind: "bounded_episode_completed" as const,
    observationCount: 1,
    observationsSha256: `sha256:${"c".repeat(64)}`,
    terminalObservationId,
    terminalObservationType: "interrupted",
    latestCheckpointExternalId: null,
    latestCheckpointSha256: null,
    containsPrivateContent: false as const,
    containsCredentials: false as const,
  };
}
