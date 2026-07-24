import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { ConflictError, StensiblyStore } from "../src/store.ts";

const agent = { id: "agent", name: "Agent", kind: "agent" as const };
const leo = { id: "leo", name: "Leo", kind: "human" as const };

let store: StensiblyStore;
let ledger: SqliteWorkLedger;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  ledger = new SqliteWorkLedger(store);
});

afterEach(() => store.close());

describe("continuation instruction editing", () => {
  test("edits a proposed instruction with generation guards and exact replay", async () => {
    const item = await createItem();
    const proposal = await propose(item.id);
    const before = await ledger.getItem(item.id);
    const input = {
      id: proposal.id,
      actor: leo,
      expectedGeneration: proposal.generation,
      instruction: "Review the implementation and record the merge decision.",
      note: "Clarify the expected decision output.",
      idempotencyKey: "continuation-edit-1",
    };

    const edited = await ledger.editContinuation(input);
    expect(edited).toMatchObject({
      id: proposal.id,
      status: "proposed",
      generation: proposal.generation + 1,
      instruction: input.instruction,
      resolutionActorId: null,
      resolutionNote: null,
    });
    expect(await ledger.editContinuation(input)).toEqual(edited);

    const detail = await ledger.getItem(item.id);
    expect(detail.item.version).toBe(before.item.version + 1);
    expect(detail.events.at(-1)).toMatchObject({
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

    await expect(ledger.editContinuation({
      ...input,
      instruction: "A changed replay.",
    })).rejects.toThrow(ConflictError);
    await expect(ledger.editContinuation({
      ...input,
      idempotencyKey: "continuation-edit-stale",
    })).rejects.toThrow("generation changed");
  });

  test("allows deferred edits and rejects approved or unsafe edits", async () => {
    const item = await createItem();
    const deferred = await propose(item.id);
    const deferredState = await ledger.resolveContinuation({
      id: deferred.id,
      actor: leo,
      command: "defer",
      expectedGeneration: deferred.generation,
    });
    const editedDeferred = await ledger.editContinuation({
      id: deferred.id,
      actor: leo,
      expectedGeneration: deferredState.generation,
      instruction: "Revisit this after the release review finishes.",
    });
    expect(editedDeferred).toMatchObject({
      status: "deferred",
      generation: deferredState.generation + 1,
    });

    const approved = await propose(item.id);
    const approvedState = await ledger.resolveContinuation({
      id: approved.id,
      actor: leo,
      command: "approve",
      expectedGeneration: approved.generation,
    });
    await expect(ledger.editContinuation({
      id: approved.id,
      actor: leo,
      expectedGeneration: approvedState.generation,
      instruction: "Do different work after approval.",
    })).rejects.toThrow("cannot edit while approved");

    const unsafe = await propose(item.id);
    await expect(ledger.editContinuation({
      id: unsafe.id,
      actor: leo,
      expectedGeneration: unsafe.generation,
      instruction: "Use stn.tok_secret in the next turn.",
    })).rejects.toThrow("credential-shaped text");
  });
});

async function createItem() {
  return await ledger.createItem({
    project: "scrapbook",
    kind: "task",
    title: "Continuation edit source",
    priority: 60,
    actor: agent,
  });
}

async function propose(sourceItemId: string) {
  return await ledger.proposeContinuation({
    sourceItemId,
    title: "Review the completed work",
    rationale: "A human should decide the next move.",
    instruction: "Review the implementation.",
    action: { kind: "request_decision", decisionType: "merge_review" },
    actor: agent,
    approvalMode: "human",
    deliveryMode: "human_inbox",
  });
}
