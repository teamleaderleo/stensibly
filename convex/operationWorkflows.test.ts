import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  canonicalOperationWorkflowJson,
  fingerprintOperationWorkflow,
  operationWorkflowStableRequestJson,
} from "../src/operation-workflow-admission";
import {
  buildOperationWorkflow,
  reserveOperationWorkflowStep,
} from "../src/operation-workflow-machine";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "operation-workflow-test-secret";
const reserveRef = makeFunctionReference<"mutation">("operationWorkflows:reserve");
const transitionRef = makeFunctionReference<"mutation">("operationWorkflows:transition");
const getRef = makeFunctionReference<"query">("operationWorkflows:get");

beforeEach(() => vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret));

describe("hosted operation workflow store", () => {
  test("serializes exact reservation replay and conflicts altered intent", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t);
    const first = workflow("opw_first", "sha256:" + "1".repeat(64));
    const outcomes = await Promise.all([
      t.mutation(reserveRef, reserveArgs(first)),
      t.mutation(reserveRef, reserveArgs(first)),
    ]) as any[];
    expect(outcomes.map((entry) => entry.outcome).sort()).toEqual(["replay", "reserved"]);
    const rebuilt = workflow("opw_rebuilt", "sha256:" + "1".repeat(64));
    const replay = await t.mutation(reserveRef, reserveArgs(rebuilt)) as any;
    expect(replay.outcome).toBe("replay");
    expect(JSON.parse(replay.workflowJson).id).toBe("opw_first");
    const changed = workflow("opw_changed", "sha256:" + "2".repeat(64));
    expect((await t.mutation(reserveRef, reserveArgs(changed)) as any).outcome).toBe("conflict");
    expect(await t.run(async (ctx: any) => await ctx.db.query("operationWorkflows").collect())).toHaveLength(1);
  });

  test("checks exact current digest and one-step lifecycle transition", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t);
    const current = workflow("opw_transition", "sha256:" + "3".repeat(64));
    await t.mutation(reserveRef, reserveArgs(current));
    const next = reserveOperationWorkflowStep(current, current.steps[0]!.id, "2026-08-10T00:00:01.000Z");
    const args = transitionArgs(current, next);
    const result = await t.mutation(transitionRef, args) as any;
    expect(JSON.parse(result.workflowJson)).toMatchObject({ revision: 2, state: "running" });
    await expect(t.mutation(transitionRef, args)).rejects.toThrow("Operation workflow durable state changed");
    const stored = await t.query(getRef, baseArgs({ project: "stensibly", idempotencyKey: current.idempotencyKey })) as any;
    expect(stored.workflowSha256).toBe(fingerprintOperationWorkflow(next));
  });

  test("rejects caller-supplied digest and canonicalization lies", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t);
    const current = workflow("opw_hostile", "sha256:" + "4".repeat(64));
    await expect(t.mutation(reserveRef, {
      ...reserveArgs(current),
      workflowSha256: "sha256:" + "f".repeat(64),
    })).rejects.toThrow("Operation workflow reservation evidence is invalid");
  });
});

function workflow(id: string, requestSha256: string) {
  const built = buildOperationWorkflow({
    id,
    project: "stensibly",
    itemId: "item_154",
    runId: "run_keel",
    actorId: "agent_keel",
    clientId: "codex",
    kind: "github_publish_change",
    target: "teamleaderleo/stensibly:refs/heads/codex/operations",
    request: { requestSha256 },
    idempotencyKey: "publish-change:154",
    authorityFence: {
      resource: "run:run_keel:generation:1",
      holderId: "agent_keel",
      generation: 1,
      expiresAt: "2026-08-10T00:00:59.000Z",
    },
    steps: [{
      kind: "github_create_branch",
      command: { requestSha256 },
      compensation: {
        disposition: "conditionally_reversible",
        kind: "github_delete_branch_if_exact",
        command: { requestSha256 },
      },
    }],
    now: "2026-08-10T00:00:00.000Z",
  });
  return built;
}

function reserveArgs(workflowValue: ReturnType<typeof workflow>) {
  return baseArgs({
    project: workflowValue.project,
    workflowJson: canonicalOperationWorkflowJson(workflowValue),
    workflowSha256: fingerprintOperationWorkflow(workflowValue),
    stableRequestJson: operationWorkflowStableRequestJson(workflowValue),
  });
}

function transitionArgs(current: ReturnType<typeof workflow>, next: ReturnType<typeof workflow>) {
  return baseArgs({
    project: current.project,
    idempotencyKey: current.idempotencyKey,
    currentSha256: fingerprintOperationWorkflow(current),
    nextWorkflowJson: canonicalOperationWorkflowJson(next),
    nextWorkflowSha256: fingerprintOperationWorkflow(next),
  });
}

function baseArgs(value: Record<string, unknown>) {
  return { ...value, serviceSecret: secret, workspace: "default" };
}

async function seedProject(t: ReturnType<typeof convexTest>): Promise<void> {
  await t.run(async (ctx: any) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      externalId: "ws_default",
      slug: "default",
      name: "Default",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("projects", {
      workspaceId,
      externalId: "project_stensibly",
      slug: "stensibly",
      name: "Stensibly",
      createdAt: 1,
      updatedAt: 1,
    });
  });
}
