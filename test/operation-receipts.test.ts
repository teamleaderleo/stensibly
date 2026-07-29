import { describe, expect, test } from "bun:test";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const actor = {
  id: "receipt-agent",
  name: "Receipt Agent",
  kind: "agent" as const,
};

describe("SQLite operation receipts", () => {
  test("reconciles item, event, and artifact mutations without exposing payloads", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);

    try {
      const item = await ledger.createItem({
        project: "alpha",
        kind: "task",
        title: "Reconcile ambiguous operations",
        priority: 90,
        actor,
        idempotencyKey: "receipt-create",
      });
      const created = await ledger.getOperationReceipt({
        project: "alpha",
        idempotencyKey: "receipt-create",
      });
      expect(created).toMatchObject({
        status: "recorded",
        operation: "item.created",
        itemId: item.id,
        result: { kind: "item", id: item.id },
        reconciliation: {
          retry: "do_not_retry",
          nextAction: "read_item",
          itemId: item.id,
        },
      });

      const event = await ledger.recordEvent({
        id: item.id,
        actor,
        type: "progress.receipt_test",
        payload: { secretLikeDetail: "must stay out of the receipt" },
        idempotencyKey: "receipt-event",
      });
      const recordedEvent = await ledger.getOperationReceipt({
        project: "alpha",
        idempotencyKey: "receipt-event",
      });
      expect(recordedEvent).toMatchObject({
        status: "recorded",
        operation: "progress.receipt_test",
        eventId: event.id,
        result: { kind: "event", id: event.id },
      });
      expect(JSON.stringify(recordedEvent)).not.toContain("secretLikeDetail");

      const artifact = await ledger.attachArtifact({
        id: item.id,
        actor,
        kind: "commit",
        label: "Receipt implementation",
        uri: "git:teamleaderleo/stensibly@receipt",
        metadata: { privateNote: "omit me" },
        idempotencyKey: "receipt-artifact",
      });
      const recordedArtifact = await ledger.getOperationReceipt({
        project: "alpha",
        idempotencyKey: "receipt-artifact",
      });
      expect(recordedArtifact).toMatchObject({
        status: "recorded",
        operation: "artifact.attached",
        itemId: item.id,
        result: { kind: "artifact", id: artifact.id },
      });
      expect(JSON.stringify(recordedArtifact)).not.toContain("privateNote");
    } finally {
      store.close();
    }
  });

  test("returns unknown for missing and cross-project keys", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);

    try {
      await ledger.createItem({
        project: "alpha",
        kind: "task",
        title: "Private alpha operation",
        priority: 50,
        actor,
        idempotencyKey: "alpha-private-key",
      });

      const expectedUnknown = {
        status: "unknown",
        reconciliation: {
          retry: "same_request_same_key",
          nextAction: "retry_same_request_same_key",
        },
      };
      expect(await ledger.getOperationReceipt({
        project: "alpha",
        idempotencyKey: "missing-key",
      })).toMatchObject(expectedUnknown);
      expect(await ledger.getOperationReceipt({
        project: "beta",
        idempotencyKey: "alpha-private-key",
      })).toMatchObject(expectedUnknown);
    } finally {
      store.close();
    }
  });
});
