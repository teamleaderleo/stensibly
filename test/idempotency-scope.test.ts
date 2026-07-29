import { describe, expect, test } from "bun:test";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const actor = { id: "scope-agent", name: "Scope Agent", kind: "agent" as const };

describe("SQLite idempotency scope", () => {
  test("rejects a create replay across projects without exposing the foreign item", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    try {
      const alpha = await ledger.createItem({
        project: "alpha",
        kind: "task",
        title: "Alpha item",
        priority: 50,
        actor,
        idempotencyKey: "shared-create-key",
      });
      await expect(ledger.createItem({
        project: "beta",
        kind: "task",
        title: "Beta item",
        priority: 50,
        actor,
        idempotencyKey: "shared-create-key",
      })).rejects.toThrow("different operation");
      expect((await ledger.getOperationReceipt({
        project: "beta",
        idempotencyKey: "shared-create-key",
      })).status).toBe("unknown");
      expect(store.listItems({ project: "beta" })).toEqual([]);
      expect(store.getItem(alpha.id).project).toBe("alpha");
    } finally {
      store.close();
    }
  });

  test("rejects cross-item event, claim, and artifact replay", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    try {
      const alpha = await ledger.createItem({
        project: "alpha", kind: "task", title: "Alpha", priority: 50, actor,
        idempotencyKey: "alpha-create",
      });
      const beta = await ledger.createItem({
        project: "beta", kind: "task", title: "Beta", priority: 50, actor,
        idempotencyKey: "beta-create",
      });
      await ledger.recordEvent({
        id: alpha.id, actor, type: "progress.scope", payload: { step: 1 },
        idempotencyKey: "event-scope-key",
      });
      await expect(ledger.recordEvent({
        id: beta.id, actor, type: "progress.scope", payload: { step: 1 },
        idempotencyKey: "event-scope-key",
      })).rejects.toThrow("different operation");

      await ledger.claimWork({
        id: alpha.id, actor, leaseSeconds: 300, idempotencyKey: "claim-scope-key",
      });
      await expect(ledger.claimWork({
        id: beta.id, actor, leaseSeconds: 300, idempotencyKey: "claim-scope-key",
      })).rejects.toThrow("different operation");

      await ledger.attachArtifact({
        id: alpha.id, actor, kind: "commit", label: "Alpha commit",
        uri: "git:alpha", metadata: {}, idempotencyKey: "artifact-scope-key",
      });
      await expect(ledger.attachArtifact({
        id: beta.id, actor, kind: "commit", label: "Alpha commit",
        uri: "git:alpha", metadata: {}, idempotencyKey: "artifact-scope-key",
      })).rejects.toThrow("different operation");
    } finally {
      store.close();
    }
  });
});
