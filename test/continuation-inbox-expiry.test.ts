import { afterEach, describe, expect, test } from "bun:test";
import { buildContinuationInbox } from "../src/continuation-inbox.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const agent = { id: "agent", name: "Agent", kind: "agent" as const };
let store: StensiblyStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

describe("continuation inbox expiry polling", () => {
  test("changes the fingerprint when a proposal enters the warning window", async () => {
    store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    const item = await ledger.createItem({
      project: "alpha",
      kind: "task",
      title: "Expiry boundary source",
      priority: 50,
      actor: agent,
    });
    const initialNow = new Date();
    const expiresAt = new Date(initialNow.getTime() + 2 * 60 * 60_000).toISOString();
    await ledger.proposeContinuation({
      sourceItemId: item.id,
      title: "Approve before expiry",
      rationale: "The approval window closes soon.",
      instruction: "Review the proposal before it expires.",
      action: { kind: "request_decision", decisionType: "expiry_boundary" },
      actor: agent,
      approvalMode: "human",
      deliveryMode: "human_inbox",
      expiresAt,
    });

    const active = await buildContinuationInbox(ledger, {
      now: initialNow,
      expiringWithinSeconds: 3_600,
    });
    expect(active.items[0]?.expiryState).toBe("active");

    const later = await buildContinuationInbox(ledger, {
      now: new Date(initialNow.getTime() + 90 * 60_000),
      expiringWithinSeconds: 3_600,
      previousFingerprint: active.fingerprint,
    });
    expect(later.items[0]?.expiryState).toBe("expiring");
    expect(later.changed).toBe(true);
    expect(later.notifyRecommended).toBe(true);
  });
});
