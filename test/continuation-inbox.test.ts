import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildContinuationInbox } from "../src/continuation-inbox.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const agent = { id: "agent", name: "Agent", kind: "agent" as const };
const leo = { id: "leo", name: "Leo", kind: "human" as const };

let store: StensiblyStore;
let ledger: SqliteWorkLedger;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  ledger = new SqliteWorkLedger(store);
});

afterEach(() => store.close());

describe("continuation decision inbox", () => {
  test("projects unresolved human inbox proposals in deterministic attention order", async () => {
    const now = new Date();
    const expiringAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    const reviewItem = await createItem("alpha", "Review source", 50);
    const urgentItem = await createItem("beta", "Urgent source", 20);
    const deferredItem = await createItem("beta", "Deferred source", 100);

    const normal = await ledger.proposeContinuation({
      sourceItemId: reviewItem.id,
      title: "Review the finished change",
      rationale: "A human should decide whether to continue.",
      instruction: "Inspect the result and approve the next action.",
      action: { kind: "request_decision", decisionType: "merge_review" },
      actor: agent,
      deliveryMode: "human_inbox",
      approvalMode: "human",
    });
    const urgent = await ledger.proposeContinuation({
      sourceItemId: urgentItem.id,
      title: "Approve before the release window closes",
      rationale: "The release window is time-sensitive.",
      instruction: "Review the release evidence now.",
      action: { kind: "request_decision", decisionType: "release_window" },
      actor: agent,
      deliveryMode: "human_inbox",
      approvalMode: "human",
      expiresAt: expiringAt,
    });
    const deferred = await ledger.proposeContinuation({
      sourceItemId: deferredItem.id,
      title: "Revisit the deferred follow-up",
      rationale: "The work remains useful after a pause.",
      instruction: "Review the proposal when capacity returns.",
      action: { kind: "create_item", project: "beta" },
      actor: agent,
      deliveryMode: "human_inbox",
      approvalMode: "human",
    });
    await ledger.resolveContinuation({
      id: deferred.id,
      actor: leo,
      command: "defer",
      expectedGeneration: deferred.generation,
    });
    await ledger.proposeContinuation({
      sourceItemId: reviewItem.id,
      title: "Continue in the current conversation",
      rationale: "This belongs to the conversation card.",
      instruction: "Continue here.",
      action: { kind: "resume_item", itemId: reviewItem.id },
      actor: agent,
      deliveryMode: "current_conversation",
      approvalMode: "human",
    });
    await ledger.proposeContinuation({
      sourceItemId: reviewItem.id,
      title: "Automatic background continuation",
      rationale: "A supervisor may handle this automatically.",
      instruction: "Queue the background work.",
      action: { kind: "dispatch_item", itemId: reviewItem.id },
      actor: agent,
      deliveryMode: "human_inbox",
      approvalMode: "automatic",
    });

    const inbox = await buildContinuationInbox(ledger, {
      now,
      expiringWithinSeconds: 600,
    });
    expect(inbox).toMatchObject({
      version: 1,
      changed: null,
      notifyRecommended: true,
      scope: { project: null },
      total: 3,
    });
    expect(inbox.items.map((entry) => entry.id)).toEqual([
      urgent.id,
      normal.id,
      deferred.id,
    ]);
    expect(inbox.items[0]).toMatchObject({
      generation: urgent.generation,
      expiryState: "expiring",
      sourceItem: {
        id: urgentItem.id,
        project: "beta",
        priority: 20,
      },
    });
    expect(inbox.projects).toEqual([
      {
        project: "alpha",
        total: 1,
        proposed: 1,
        deferred: 0,
        expiring: 0,
        highestPriority: 50,
        updatedAt: normal.updatedAt,
      },
      {
        project: "beta",
        total: 2,
        proposed: 1,
        deferred: 1,
        expiring: 1,
        highestPriority: 100,
        updatedAt: expect.any(String),
      },
    ]);

    const unchanged = await buildContinuationInbox(ledger, {
      now,
      expiringWithinSeconds: 600,
      previousFingerprint: inbox.fingerprint,
    });
    expect(unchanged.changed).toBe(false);
    expect(unchanged.notifyRecommended).toBe(false);

    await ledger.resolveContinuation({
      id: normal.id,
      actor: leo,
      command: "approve",
      expectedGeneration: normal.generation,
    });
    const changed = await buildContinuationInbox(ledger, {
      now,
      expiringWithinSeconds: 600,
      previousFingerprint: inbox.fingerprint,
    });
    expect(changed.changed).toBe(true);
    expect(changed.total).toBe(2);
  });

  test("supports project scoping and limits without changing total counts", async () => {
    const first = await createItem("alpha", "First source", 70);
    const second = await createItem("alpha", "Second source", 60);
    await createItem("beta", "Other project", 100).then((item) => propose(item.id));
    await propose(first.id);
    await propose(second.id);

    const inbox = await buildContinuationInbox(ledger, {
      project: "alpha",
      limit: 1,
    });
    expect(inbox.scope).toEqual({ project: "alpha" });
    expect(inbox.total).toBe(2);
    expect(inbox.items).toHaveLength(1);
    expect(inbox.projects.map((project) => project.project)).toEqual(["alpha"]);
  });

  test("validates polling inputs", async () => {
    await expect(buildContinuationInbox(ledger, { limit: 0 })).rejects.toThrow();
    await expect(buildContinuationInbox(ledger, {
      previousFingerprint: "not-a-fingerprint",
    })).rejects.toThrow();
  });
});

async function createItem(project: string, title: string, priority: number) {
  return await ledger.createItem({
    project,
    kind: "task",
    title,
    priority,
    actor: agent,
  });
}

async function propose(sourceItemId: string) {
  return await ledger.proposeContinuation({
    sourceItemId,
    title: `Review ${sourceItemId}`,
    rationale: "A human decision is required.",
    instruction: "Review the proposal.",
    action: { kind: "request_decision", decisionType: "review" },
    actor: agent,
    deliveryMode: "human_inbox",
    approvalMode: "human",
  });
}
