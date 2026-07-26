import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { completeWork } from "../src/completion.ts";
import { ConflictError, StensiblyStore } from "../src/store.ts";
import { handoffWork } from "../src/transitions.ts";

const actor = { id: "agent", name: "Agent", kind: "agent" as const };

let store: StensiblyStore;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
});

afterEach(() => store.close());

describe("semantic transition replay identity", () => {
  test("handoff replay requires the exact generation and payload", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Fence handoff replay",
      priority: 50,
      actor,
    });
    const request = {
      id: item.id,
      actor,
      expectedClaimGeneration: item.claimGeneration,
      summary: "Ready for the next actor.",
      nextAction: "Review the result.",
      idempotencyKey: "handoff-exact-replay",
    };

    const first = handoffWork(store, request);
    expect(handoffWork(store, request)).toEqual(first);
    expect(() => handoffWork(store, {
      ...request,
      nextAction: "Changed replay.",
    })).toThrow(ConflictError);
    expect(() => handoffWork(store, {
      ...request,
      expectedClaimGeneration: first.claimGeneration,
    })).toThrow(ConflictError);
  });

  test("completion replay requires the exact actor generation and summary", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Fence completion replay",
      priority: 50,
      actor,
    });
    const request = {
      id: item.id,
      actor,
      expectedClaimGeneration: item.claimGeneration,
      summary: "Completed once.",
      idempotencyKey: "complete-exact-replay",
    };

    const first = completeWork(store, request);
    expect(completeWork(store, request)).toEqual(first);
    expect(() => completeWork(store, {
      ...request,
      summary: "Changed completion.",
    })).toThrow(ConflictError);
    expect(() => completeWork(store, {
      ...request,
      actor: { id: "other", name: "Other", kind: "agent" },
    })).toThrow(ConflictError);
  });

  test("completion replay preserves an explicit empty summary", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Clear the completion summary",
      summary: "Remove this summary.",
      priority: 50,
      actor,
    });
    const request = {
      id: item.id,
      actor,
      expectedClaimGeneration: item.claimGeneration,
      summary: "",
      idempotencyKey: "complete-empty-summary",
    };

    const first = completeWork(store, request);
    expect(first.summary).toBe("");
    expect(completeWork(store, request)).toEqual(first);
    expect(store.listEvents(item.id).at(-1)?.payload).toMatchObject({ summary: "" });
    expect(() => completeWork(store, {
      id: request.id,
      actor: request.actor,
      expectedClaimGeneration: request.expectedClaimGeneration,
      idempotencyKey: request.idempotencyKey,
    })).toThrow(ConflictError);
  });
});
