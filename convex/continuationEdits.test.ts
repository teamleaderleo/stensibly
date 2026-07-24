import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const agent = { id: "agent", name: "Agent", kind: "agent" as const };
const leo = { id: "leo", name: "Leo", kind: "human" as const };

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret);
});

describe("Convex continuation instruction edits", () => {
  test("edits proposed instructions with generation guards and exact replay", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t, "Hosted edit source");
    const proposal = await propose(t, item.id);
    const before = await itemDetail(t, item.id);
    const input = {
      serviceSecret: secret,
      workspace,
      id: proposal.id,
      actor: leo,
      expectedGeneration: proposal.generation,
      instruction: "Review the hosted result and record the merge decision.",
      note: "Clarify the expected decision output.",
      idempotencyKey: "convex-edit-1",
    };

    const edited = await t.mutation(convexApi.continuations.edit, input) as any;
    expect(edited).toMatchObject({
      id: proposal.id,
      sourceItemId: item.id,
      status: "proposed",
      generation: proposal.generation + 1,
      instruction: input.instruction,
      resolutionActorId: null,
      resolutionNote: null,
    });
    expect(await t.mutation(convexApi.continuations.edit, input)).toEqual(edited);

    const after = await itemDetail(t, item.id);
    expect(after.item.version).toBe(before.item.version + 1);
    expect(after.events.at(-1)).toMatchObject({
      actorId: leo.id,
      type: "continuation.edited",
      payload: {
        continuationId: proposal.id,
        status: "proposed",
        generation: proposal.generation + 1,
        instruction: input.instruction,
        note: input.note,
      },
    });

    await expect(t.mutation(convexApi.continuations.edit, {
      ...input,
      instruction: "A changed replay.",
    })).rejects.toThrow("different continuation edit");
    await expect(t.mutation(convexApi.continuations.edit, {
      ...input,
      idempotencyKey: "convex-edit-stale",
    })).rejects.toThrow("generation changed");
  });

  test("allows deferred edits and rejects approved, expired, or unsafe edits", async () => {
    const t = convexTest(schema, modules);
    const item = await createItem(t, "Hosted edit states");

    const deferred = await propose(t, item.id);
    const deferredState = await t.mutation(convexApi.continuations.resolve, {
      serviceSecret: secret,
      workspace,
      id: deferred.id,
      actor: leo,
      command: "defer",
      expectedGeneration: deferred.generation,
    }) as any;
    const editedDeferred = await t.mutation(convexApi.continuations.edit, {
      serviceSecret: secret,
      workspace,
      id: deferred.id,
      actor: leo,
      expectedGeneration: deferredState.generation,
      instruction: "Revisit after the release review finishes.",
    }) as any;
    expect(editedDeferred).toMatchObject({
      status: "deferred",
      generation: deferredState.generation + 1,
    });

    const approved = await propose(t, item.id);
    const approvedState = await t.mutation(convexApi.continuations.resolve, {
      serviceSecret: secret,
      workspace,
      id: approved.id,
      actor: leo,
      command: "approve",
      expectedGeneration: approved.generation,
    }) as any;
    await expect(t.mutation(convexApi.continuations.edit, {
      serviceSecret: secret,
      workspace,
      id: approved.id,
      actor: leo,
      expectedGeneration: approvedState.generation,
      instruction: "Do different work after approval.",
    })).rejects.toThrow("cannot edit while approved");

    const unsafe = await propose(t, item.id);
    await expect(t.mutation(convexApi.continuations.edit, {
      serviceSecret: secret,
      workspace,
      id: unsafe.id,
      actor: leo,
      expectedGeneration: unsafe.generation,
      instruction: "Use stn.tok_secret in the next turn.",
    })).rejects.toThrow("credential-shaped text");

    const expired = await t.mutation(convexApi.continuations.propose, {
      serviceSecret: secret,
      workspace,
      sourceItemId: item.id,
      title: "Expired edit",
      rationale: "This proposal is already outside its approval window.",
      instruction: "Do not edit after expiry.",
      action: { kind: "request_decision", decisionType: "expired_edit" },
      actor: agent,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    }) as any;
    await expect(t.mutation(convexApi.continuations.edit, {
      serviceSecret: secret,
      workspace,
      id: expired.id,
      actor: leo,
      expectedGeneration: expired.generation,
      instruction: "This edit is too late.",
    })).rejects.toThrow("cannot edit while expired");
  });
});

async function createItem(t: ReturnType<typeof convexTest>, title: string) {
  return await t.mutation(convexApi.items.create, {
    serviceSecret: secret,
    workspace,
    project: "scrapbook",
    kind: "task",
    title,
    priority: 60,
    actor: agent,
  }) as any;
}

async function propose(t: ReturnType<typeof convexTest>, sourceItemId: string) {
  return await t.mutation(convexApi.continuations.propose, {
    serviceSecret: secret,
    workspace,
    sourceItemId,
    title: "Review the hosted work",
    rationale: "A human should decide the next move.",
    instruction: "Review the implementation.",
    action: { kind: "request_decision", decisionType: "merge_review" },
    actor: agent,
    approvalMode: "human",
    deliveryMode: "human_inbox",
  }) as any;
}

async function itemDetail(t: ReturnType<typeof convexTest>, id: string) {
  return await t.query(convexApi.items.get, {
    serviceSecret: secret,
    workspace,
    id,
  }) as any;
}
