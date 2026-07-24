import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getContinuation,
  listContinuations,
  proposeContinuation,
  resolveContinuation,
} from "../src/continuations.ts";
import { ConflictError, StensiblyStore } from "../src/store.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };
const agent = { id: "agent", name: "Agent", kind: "agent" as const };

let store: StensiblyStore;
let sourceItemId: string;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  sourceItemId = store.createItem({
    project: "scrapbook",
    kind: "task",
    title: "Finish one useful unit",
    priority: 50,
    actor: leo,
  }).id;
});

afterEach(() => store.close());

describe("continuation proposals", () => {
  test("stores a typed proposal, evidence, and source-item event idempotently", () => {
    const input = {
      sourceItemId,
      title: "Implement the next slice",
      rationale: "The completed work exposed a clear adjacent improvement.",
      instruction: "Open the proposal, claim the resulting item, and implement it.",
      action: { kind: "create_item" as const, project: "scrapbook" },
      evidence: [{
        kind: "pull_request",
        label: "Completed PR",
        uri: "https://example.test/pr/62",
      }],
      actor: agent,
      approvalMode: "human" as const,
      deliveryMode: "current_conversation" as const,
      idempotencyKey: "proposal-1",
    };

    const proposal = proposeContinuation(store, input);
    expect(proposal).toMatchObject({
      sourceItemId,
      title: input.title,
      action: input.action,
      evidence: input.evidence,
      suggestedBy: agent.id,
      status: "proposed",
      generation: 1,
      result: null,
      consumedAt: null,
    });
    expect(proposeContinuation(store, input)).toEqual(proposal);
    expect(listContinuations(store, { sourceItemId })).toEqual([proposal]);

    const continuationEvents = store.listEvents(sourceItemId)
      .filter((event) => event.type.startsWith("continuation."));
    expect(continuationEvents).toHaveLength(1);
    expect(continuationEvents[0]).toMatchObject({
      id: proposal.sourceEventId,
      actorId: agent.id,
      type: "continuation.proposed",
      payload: {
        continuationId: proposal.id,
        actionKind: "create_item",
        approvalMode: "human",
        deliveryMode: "current_conversation",
      },
    });
  });

  test("rejects idempotency reuse with a different proposal", () => {
    const base = {
      sourceItemId,
      title: "Continue",
      rationale: "Useful next work.",
      instruction: "Continue from the durable proposal.",
      action: { kind: "resume_item" as const, itemId: sourceItemId },
      actor: agent,
      idempotencyKey: "proposal-conflict",
    };
    proposeContinuation(store, base);
    expect(() =>
      proposeContinuation(store, { ...base, title: "Different continuation" })
    ).toThrow(ConflictError);
  });

  test("uses generation guards and consumes into durable execution references", () => {
    const proposal = proposeContinuation(store, {
      sourceItemId,
      title: "Continue in this chat",
      rationale: "The user can authorize the next move immediately.",
      instruction: "Read the latest proposal and begin the approved action.",
      action: { kind: "resume_item", itemId: sourceItemId },
      actor: agent,
      deliveryMode: "current_conversation",
    });

    const approvedInput = {
      id: proposal.id,
      actor: leo,
      command: "approve" as const,
      expectedGeneration: 1,
      note: "Continue here.",
      idempotencyKey: "approve-1",
    };
    const approved = resolveContinuation(store, approvedInput);
    expect(approved).toMatchObject({
      status: "approved",
      generation: 2,
      resolutionActorId: leo.id,
      resolutionNote: "Continue here.",
      result: null,
      consumedAt: null,
    });
    expect(resolveContinuation(store, approvedInput)).toEqual(approved);

    expect(() =>
      resolveContinuation(store, {
        id: proposal.id,
        actor: agent,
        command: "consume",
        expectedGeneration: 1,
        result: { itemId: sourceItemId },
      })
    ).toThrow(ConflictError);

    const consumedInput = {
      id: proposal.id,
      actor: agent,
      command: "consume" as const,
      expectedGeneration: 2,
      result: {
        itemId: sourceItemId,
        conversationRef: "chatgpt:conversation:test",
      },
      idempotencyKey: "consume-1",
    };
    const consumed = resolveContinuation(store, consumedInput);
    expect(consumed).toMatchObject({
      status: "consumed",
      generation: 3,
      result: consumedInput.result,
      resolutionActorId: agent.id,
    });
    expect(consumed.consumedAt).toBeString();
    expect(resolveContinuation(store, consumedInput)).toEqual(consumed);

    expect(() =>
      resolveContinuation(store, {
        ...consumedInput,
        result: { itemId: sourceItemId, conversationRef: "different-chat" },
      })
    ).toThrow(ConflictError);

    expect(() =>
      resolveContinuation(store, {
        id: proposal.id,
        actor: leo,
        command: "defer",
        expectedGeneration: 3,
      })
    ).toThrow(ConflictError);

    expect(
      store.listEvents(sourceItemId).filter(
        (event) => event.type === "continuation.consumed",
      ),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          continuationId: proposal.id,
          result: consumedInput.result,
        }),
      }),
    ]);
  });

  test("requires action-appropriate references when consuming", () => {
    const proposal = proposeContinuation(store, {
      sourceItemId,
      title: "Create the follow-up item",
      rationale: "The next work deserves a separate unit of intent.",
      instruction: "Create and return the resulting item.",
      action: { kind: "create_item", project: "scrapbook" },
      actor: agent,
    });
    const approved = resolveContinuation(store, {
      id: proposal.id,
      actor: leo,
      command: "approve",
      expectedGeneration: 1,
    });

    expect(() =>
      resolveContinuation(store, {
        id: proposal.id,
        actor: agent,
        command: "consume",
        expectedGeneration: approved.generation,
        result: { runId: "run_wrong_kind" },
      })
    ).toThrow(TypeError);

    expect(() =>
      resolveContinuation(store, {
        id: proposal.id,
        actor: leo,
        command: "cancel",
        expectedGeneration: approved.generation,
        result: { itemId: "item_unexpected" },
      })
    ).toThrow(TypeError);

    const consumed = resolveContinuation(store, {
      id: proposal.id,
      actor: agent,
      command: "consume",
      expectedGeneration: approved.generation,
      result: { itemId: "item_follow_up" },
    });
    expect(consumed).toMatchObject({
      status: "consumed",
      result: { itemId: "item_follow_up" },
    });
  });

  test("expires live proposals once and invalidates stale approval", () => {
    const proposal = proposeContinuation(store, {
      sourceItemId,
      title: "Time-sensitive continuation",
      rationale: "This only helps while the external window remains open.",
      instruction: "Resume before the proposal expires.",
      action: { kind: "request_decision", decisionType: "release_window" },
      actor: agent,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    store.db.query("UPDATE continuations SET expires_at = ?1 WHERE id = ?2")
      .run(new Date(Date.now() - 1_000).toISOString(), proposal.id);

    const expired = getContinuation(store, proposal.id);
    expect(expired).toMatchObject({ status: "expired", generation: 2 });
    expect(getContinuation(store, proposal.id)).toEqual(expired);
    expect(
      store.listEvents(sourceItemId).filter(
        (event) => event.type === "continuation.expired",
      ),
    ).toHaveLength(1);

    expect(() =>
      resolveContinuation(store, {
        id: proposal.id,
        actor: leo,
        command: "approve",
        expectedGeneration: 1,
      })
    ).toThrow(ConflictError);
  });

  test("validates typed actions and cascades with the source item", () => {
    expect(() =>
      proposeContinuation(store, {
        sourceItemId,
        title: "Unsafe action",
        rationale: "Attempt arbitrary execution.",
        instruction: "Run arbitrary code.",
        action: { kind: "shell" } as never,
        actor: agent,
      })
    ).toThrow(TypeError);

    proposeContinuation(store, {
      sourceItemId,
      title: "Disposable continuation",
      rationale: "Used to verify source ownership.",
      instruction: "Delete with the source item.",
      action: {
        kind: "dispatch_item",
        itemId: sourceItemId,
        runnerProfile: "codex",
      },
      actor: agent,
    });
    store.db.query("DELETE FROM items WHERE id = ?1").run(sourceItemId);
    expect(listContinuations(store)).toEqual([]);
  });
});
