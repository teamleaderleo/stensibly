import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dispatchNextWork } from "../src/dispatcher.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const human = { id: "human:leo", name: "Leo", kind: "human" as const };
const agent = { id: "agent:worker", name: "Worker", kind: "agent" as const };
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

describe("local item control detail", () => {
  test("projects ready and direct-claim authority through the ledger and REST", async () => {
    const item = await ledger.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Expose current authority",
      summary: "Keep control server owned.",
      nextAction: "Read the canonical projection.",
      priority: 70,
      actor: human,
    });

    const ready = await ledger.getItem(item.id);
    expect(ready.control).toMatchObject({
      schemaVersion: 1,
      authority: {
        state: "unclaimed",
        generation: 0,
        source: "none",
        allowedOperations: ["claim", "complete", "handoff", "block"],
      },
      responsibility: {
        actorId: null,
        summary: "Keep control server owned.",
        nextAction: "Read the canonical projection.",
      },
    });

    const claimed = await ledger.claimWork({
      id: item.id,
      actor: agent,
      leaseSeconds: 900,
    });
    const active = await ledger.getItem(item.id);
    expect(active.control.authority).toMatchObject({
      state: "live",
      holderActorId: agent.id,
      generation: claimed.claimGeneration,
      source: "claim",
      allowedOperations: ["renew", "release", "complete", "handoff", "block"],
    });
    expect(active.control.responsibility.actorId).toBe(agent.id);

    const app = createServerApp(store);
    const response = await app.request(`/api/v1/items/${encodeURIComponent(item.id)}`);
    expect(response.status).toBe(200);
    const body = await response.json() as { control: typeof active.control };
    expect(body.control).toEqual(active.control);
  });

  test("projects elapsed local authority without reconciling the read", async () => {
    const item = await ledger.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Show elapsed authority",
      priority: 65,
      actor: human,
    });
    const claimed = await ledger.claimWork({
      id: item.id,
      actor: agent,
      leaseSeconds: 900,
    });
    store.db.query(`
      UPDATE items
      SET claim_expires_at = '2000-01-01T00:00:00.000Z'
      WHERE id = ?1
    `).run(item.id);

    const detail = await ledger.getItem(item.id);
    expect(detail.item).toMatchObject({
      status: "active",
      claimedBy: agent.id,
      claimGeneration: claimed.claimGeneration,
    });
    expect(detail.control.authority).toMatchObject({
      state: "expired",
      holderActorId: agent.id,
      generation: claimed.claimGeneration,
      source: "claim",
      allowedOperations: [],
    });
    expect(store.getItem(item.id)).toMatchObject({
      status: "active",
      claimedBy: agent.id,
      claimGeneration: claimed.claimGeneration,
    });
    expect(store.listEvents(item.id).map((event) => event.type)).not.toContain("claim.expired");
  });

  test("identifies dispatcher authority from the current bounded run", async () => {
    const item = await ledger.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Dispatch this exact item",
      nextAction: "Start one bounded run.",
      priority: 80,
      actor: human,
    });
    const result = dispatchNextWork(store, {
      actor: supervisor,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      itemId: item.id,
      leaseSeconds: 900,
    });
    expect(result?.item.id).toBe(item.id);

    const detail = await ledger.getItem(item.id);
    expect(detail.control.authority).toMatchObject({
      state: "live",
      holderActorId: supervisor.id,
      source: "dispatcher",
      generation: result!.item.claimGeneration,
    });
    expect(detail.control.responsibility).toMatchObject({
      actorId: supervisor.id,
      heartbeatExpectedAt: result!.run.leaseExpiresAt,
    });
    expect(detail.runs).toHaveLength(1);
  });

  test("preserves current handoff responsibility without treating it as authority", async () => {
    const item = await ledger.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Hand this to review",
      priority: 60,
      actor: agent,
    });
    const handedOff = await ledger.handoffWork({
      id: item.id,
      actor: agent,
      expectedClaimGeneration: item.claimGeneration,
      summary: "Implementation is ready.",
      nextAction: "Review and record the decision.",
      toActorId: human.id,
    });

    const detail = await ledger.getItem(item.id);
    expect(detail.control.authority).toMatchObject({
      state: "unclaimed",
      holderActorId: null,
      generation: handedOff.claimGeneration,
      source: "none",
    });
    expect(detail.control.responsibility).toMatchObject({
      actorId: human.id,
      summary: "Implementation is ready.",
      nextAction: "Review and record the decision.",
    });
  });

  test("bounds same-millisecond history by insertion order", async () => {
    const item = await ledger.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Keep detail bounded",
      priority: 50,
      actor: human,
    });
    for (let index = 0; index < 120; index += 1) {
      store.recordEvent({
        itemId: item.id,
        actor: agent,
        type: "progress.recorded",
        payload: { index },
      });
    }
    store.db.query(`
      UPDATE events
      SET created_at = '2026-07-26T12:00:00.000Z'
      WHERE item_id = ?1
    `).run(item.id);

    const detail = await ledger.getItem(item.id);
    expect(detail.events).toHaveLength(100);
    expect(detail.events[0]?.payload).toEqual({ index: 20 });
    expect(detail.events.at(-1)?.payload).toEqual({ index: 119 });
  });

  test("indexes item-control provenance lookups", async () => {
    const item = await ledger.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Index semantic provenance",
      priority: 50,
      actor: human,
    });

    await ledger.getItem(item.id);
    const index = store.db
      .query<{ name: string }, [string]>(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index' AND name = ?1
      `)
      .get("idx_events_item_type_created");
    expect(index?.name).toBe("idx_events_item_type_created");
  });
});
