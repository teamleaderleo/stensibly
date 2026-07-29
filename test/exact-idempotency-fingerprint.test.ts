import { describe, expect, test } from "bun:test";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const actor = { id: "exact-agent", name: "Exact Agent", kind: "agent" as const };

function createRequest() {
  return {
    project: "alpha",
    kind: "task" as const,
    title: "Bind the whole request",
    summary: "Original summary",
    nextAction: "Verify replay",
    priority: 61,
    actor,
    idempotencyKey: "exact-create-key",
  };
}

describe("exact SQLite idempotency fingerprints", () => {
  test("replays an exact create and rejects every omitted durable field", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    try {
      const request = createRequest();
      const created = await ledger.createItem(request);
      expect((await ledger.createItem(request)).id).toBe(created.id);

      await expect(ledger.createItem({ ...request, summary: "Changed" }))
        .rejects.toThrow(/different/);
      await expect(ledger.createItem({ ...request, nextAction: "Changed" }))
        .rejects.toThrow(/different/);
      await expect(ledger.createItem({ ...request, priority: 62 }))
        .rejects.toThrow(/different/);
      await expect(ledger.createItem({
        ...request,
        actor: { id: "other-agent", name: "Other", kind: "agent" as const },
      })).rejects.toThrow(/different/);

      expect(store.listItems({ project: "alpha" })).toHaveLength(1);
      const event = store.listEvents(created.id).find((candidate) => candidate.type === "item.created");
      expect(event?.payload.requestFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(event?.payload).not.toHaveProperty("summary");
      expect(event?.payload).not.toHaveProperty("nextAction");
    } finally {
      store.close();
    }
  });

  test("replays reordered artifact metadata and rejects MIME or metadata changes", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    try {
      const item = await ledger.createItem({
        project: "alpha",
        kind: "task",
        title: "Attach exact evidence",
        priority: 50,
        actor,
      });
      const request = {
        id: item.id,
        actor,
        kind: "document" as const,
        label: "Evidence",
        uri: "https://example.test/evidence",
        mimeType: "application/json",
        metadata: { nested: { z: 3, a: 1 }, alpha: true },
        idempotencyKey: "exact-artifact-key",
      };
      const artifact = await ledger.attachArtifact(request);
      const replayed = await ledger.attachArtifact({
        ...request,
        metadata: { alpha: true, nested: { a: 1, z: 3 } },
      });
      expect(replayed.id).toBe(artifact.id);

      await expect(ledger.attachArtifact({ ...request, mimeType: "text/plain" }))
        .rejects.toThrow(/different/);
      await expect(ledger.attachArtifact({
        ...request,
        metadata: { nested: { z: 4, a: 1 }, alpha: true },
      })).rejects.toThrow(/different/);

      expect(await ledger.listArtifacts(item.id)).toHaveLength(1);
      const event = store.listEvents(item.id).find((candidate) => candidate.type === "artifact.attached");
      expect(event?.payload.requestFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(event?.payload).not.toHaveProperty("metadata");
      expect(event?.payload).not.toHaveProperty("mimeType");
    } finally {
      store.close();
    }
  });

  test("fails closed when a legacy create or artifact event lacks a fingerprint", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    try {
      const create = createRequest();
      const item = await ledger.createItem({ ...create, idempotencyKey: "legacy-create-key" });
      stripFingerprint(store, "legacy-create-key");
      await expect(ledger.createItem({ ...create, idempotencyKey: "legacy-create-key" }))
        .rejects.toThrow(/different/);

      const artifactRequest = {
        id: item.id,
        actor,
        kind: "commit" as const,
        label: "Legacy evidence",
        uri: "git:legacy",
        metadata: { sha: "deadbeef" },
        idempotencyKey: "legacy-artifact-key",
      };
      await ledger.attachArtifact(artifactRequest);
      stripFingerprint(store, "legacy-artifact-key");
      await expect(ledger.attachArtifact(artifactRequest)).rejects.toThrow(/different/);
    } finally {
      store.close();
    }
  });
});

function stripFingerprint(store: StensiblyStore, key: string): void {
  const row = store.db
    .query<{ payload_json: string }, [string]>(
      "SELECT payload_json FROM events WHERE idempotency_key = ?1",
    )
    .get(key);
  if (!row) throw new Error("Missing idempotency fixture");
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  delete payload.requestFingerprint;
  store.db
    .query("UPDATE events SET payload_json = ?1 WHERE idempotency_key = ?2")
    .run(JSON.stringify(payload), key);
}
