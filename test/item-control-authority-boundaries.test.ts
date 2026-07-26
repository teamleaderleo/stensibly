import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dispatchNextWork } from "../src/dispatcher.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const human = { id: "human:leo", name: "Leo", kind: "human" as const };
const supervisor = {
  id: "service:supervisor",
  name: "Supervisor",
  kind: "service" as const,
};
const intruder = { id: "agent:intruder", name: "Intruder", kind: "agent" as const };

let store: StensiblyStore;
let ledger: SqliteWorkLedger;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  ledger = new SqliteWorkLedger(store);
});

afterEach(() => store.close());

describe("local item-control authority boundaries", () => {
  test("rejects public attempts to forge authority lifecycle events", async () => {
    const item = await ledger.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Reject forged lifecycle evidence",
      priority: 80,
      actor: human,
    });

    for (const type of ["claim.created", "run.queued"]) {
      await expect(ledger.recordEvent({
        id: item.id,
        actor: supervisor,
        type,
        payload: {
          generation: 1,
          runId: "run_forged",
          source: "supervisor_dispatch",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          leaseExpiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      })).rejects.toThrow("reserved for internal lifecycle writers");
    }

    const ordinary = await ledger.recordEvent({
      id: item.id,
      actor: supervisor,
      type: "progress.recorded",
      payload: { message: "ordinary public evidence" },
    });
    expect(ordinary.type).toBe("progress.recorded");
  });

  test("keeps dispatcher authority when terminal history displaces the live run", async () => {
    const { itemId, runId } = createDispatchedItem("History-independent authority");
    insertTerminalHistory(itemId, supervisor.id, 25, Date.now() + 1_000);

    const detail = await ledger.getItem(itemId);
    expect(detail.runs).toHaveLength(20);
    expect(detail.runs.some((run) => run.id === runId)).toBe(false);
    expect(detail.control.authority).toMatchObject({
      state: "live",
      holderActorId: supervisor.id,
      source: "dispatcher",
    });
  });

  test("fails closed for a hidden malformed live run beyond public history", async () => {
    const { itemId, runId } = createDispatchedItem("Hidden live-run conflict");
    store.db.exec("DROP INDEX idx_work_runs_one_live_item");
    insertRun({
      id: "run_imported_malformed",
      itemId,
      actorId: supervisor.id,
      status: "running",
      createdAt: new Date(Date.now() - 1_000).toISOString(),
      leaseOwnerId: null,
      leaseExpiresAt: null,
    });
    insertTerminalHistory(itemId, supervisor.id, 25, Date.now() + 1_000);

    const detail = await ledger.getItem(itemId);
    expect(detail.runs).toHaveLength(20);
    expect(detail.runs.some((run) => run.id === runId)).toBe(false);
    expect(detail.runs.some((run) => run.id === "run_imported_malformed")).toBe(false);
    expect(detail.control.authority).toMatchObject({
      state: "superseded",
      holderActorId: null,
      source: "none",
      allowedOperations: [],
    });
  });

  test("expired rows cannot hide an older unexpired conflicting run", async () => {
    const now = Date.now();
    const item = await ledger.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Keep old live conflicts visible",
      priority: 80,
      actor: human,
    });
    await ledger.createItem({
      project: "scrapbook",
      kind: "note",
      title: "Register conflicting actor",
      priority: 1,
      actor: intruder,
    });
    await ledger.claimWork({ id: item.id, actor: supervisor, leaseSeconds: 900 });
    store.db.exec("DROP INDEX idx_work_runs_one_live_item");

    insertRun({
      id: "run_hidden_live_conflict",
      itemId: item.id,
      actorId: intruder.id,
      status: "running",
      createdAt: new Date(now).toISOString(),
      leaseOwnerId: intruder.id,
      leaseExpiresAt: new Date(now + 600_000).toISOString(),
    });
    for (let index = 0; index < 2; index += 1) {
      insertRun({
        id: `run_newer_expired_${index}`,
        itemId: item.id,
        actorId: supervisor.id,
        status: "running",
        createdAt: new Date(now + 1_000 + index).toISOString(),
        leaseOwnerId: supervisor.id,
        leaseExpiresAt: new Date(now - 1_000 - index).toISOString(),
      });
    }

    const detail = await ledger.getItem(item.id);
    expect(detail.control.authority).toMatchObject({
      state: "superseded",
      holderActorId: null,
      source: "none",
      allowedOperations: [],
    });
  });
});

function createDispatchedItem(title: string): { itemId: string; runId: string } {
  const item = store.createItem({
    project: "scrapbook",
    kind: "task",
    title,
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
  return { itemId: item.id, runId: dispatched.run.id };
}

function insertTerminalHistory(
  itemId: string,
  actorId: string,
  count: number,
  startMillis: number,
): void {
  for (let index = 0; index < count; index += 1) {
    insertRun({
      id: `run_terminal_${index}`,
      itemId,
      actorId,
      status: "succeeded",
      createdAt: new Date(startMillis + index).toISOString(),
      leaseOwnerId: null,
      leaseExpiresAt: null,
    });
  }
}

function insertRun(input: {
  id: string;
  itemId: string;
  actorId: string;
  status: "running" | "succeeded";
  createdAt: string;
  leaseOwnerId: string | null;
  leaseExpiresAt: string | null;
}): void {
  store.db.query(`
    INSERT INTO work_runs (
      id, item_id, actor_id, runner_type, runner_profile, external_run_id,
      status, generation, lease_generation, lease_owner_id, lease_expires_at,
      last_heartbeat_at, checkpoint, outcome, continuation_ref, usage_json,
      retry_attempt, max_attempts, retry_backoff_seconds, next_retry_at,
      creation_request_json, idempotency_key, created_at, updated_at,
      started_at, ended_at
    ) VALUES (
      ?1, ?2, ?3, 'generic-mcp', 'codex-default', NULL,
      ?4, 1, 1, ?5, ?6,
      NULL, NULL, NULL, NULL, '{}',
      0, 1, 0, NULL,
      '{}', NULL, ?7, ?7,
      ?7, ?8
    )
  `).run(
    input.id,
    input.itemId,
    input.actorId,
    input.status,
    input.leaseOwnerId,
    input.leaseExpiresAt,
    input.createdAt,
    input.status === "succeeded" ? input.createdAt : null,
  );
}
