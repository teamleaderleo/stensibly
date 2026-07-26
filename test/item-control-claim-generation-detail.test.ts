import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dispatchNextWork } from "../src/dispatcher.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const human = { id: "human:leo", name: "Leo", kind: "human" as const };
const supervisor = {
  id: "service:supervisor",
  name: "Supervisor",
  kind: "service" as const,
};

let store: StensiblyStore;
let ledger: SqliteWorkLedger;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  ledger = new SqliteWorkLedger(store);
});

afterEach(() => store.close());

describe("local dispatcher claim-generation authority", () => {
  test("keeps a newer direct claim from inheriting stale same-actor dispatcher evidence", async () => {
    const item = await ledger.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Fence the current grant",
      priority: 80,
      actor: human,
    });
    const dispatched = dispatchNextWork(store, {
      actor: supervisor,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      itemId: item.id,
      leaseSeconds: 900,
    });
    if (!dispatched) throw new Error("Dispatch fixture failed");

    const initial = await ledger.getItem(item.id);
    expect(initial.control.authority.source).toBe("dispatcher");

    const nextGeneration = dispatched.item.claimGeneration + 1;
    const nextExpiry = new Date(Date.now() + 15 * 60_000).toISOString();
    store.db.query(`
      UPDATE items
      SET claim_generation = ?1,
          claim_expires_at = ?2,
          version = version + 1,
          updated_at = ?3
      WHERE id = ?4
    `).run(nextGeneration, nextExpiry, new Date().toISOString(), item.id);
    store.recordEvent({
      itemId: item.id,
      actor: supervisor,
      type: "claim.created",
      payload: {
        generation: nextGeneration,
        source: "direct_claim",
      },
    });

    const detail = await ledger.getItem(item.id);
    expect(detail.control.authority).toMatchObject({
      state: "live",
      holderActorId: supervisor.id,
      generation: nextGeneration,
      source: "claim",
    });
    expect(detail.control.responsibility.heartbeatExpectedAt).toBeNull();

    const response = await createServerApp(store).request(
      `/api/v1/items/${encodeURIComponent(item.id)}`,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { control: typeof detail.control };
    expect(body.control).toEqual(detail.control);
  });

  test("fails closed when the current dispatcher run has no trusted lease expiry", async () => {
    const item = await ledger.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Reject a lease-less run",
      priority: 75,
      actor: human,
    });
    const dispatched = dispatchNextWork(store, {
      actor: supervisor,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      itemId: item.id,
      leaseSeconds: 900,
    });
    if (!dispatched) throw new Error("Dispatch fixture failed");

    store.db.query(`
      UPDATE work_runs
      SET lease_expires_at = NULL
      WHERE id = ?1
    `).run(dispatched.run.id);

    const detail = await ledger.getItem(item.id);
    expect(detail.control.authority).toMatchObject({
      state: "superseded",
      holderActorId: null,
      generation: dispatched.item.claimGeneration,
      source: "none",
      allowedOperations: [],
    });
    expect(detail.control.responsibility.heartbeatExpectedAt).toBeNull();
  });
});
