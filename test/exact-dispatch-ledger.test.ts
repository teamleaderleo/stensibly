import { describe, expect, test } from "bun:test";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const actor = {
  id: "service:owned-workstation-dispatch",
  name: "Owned workstation dispatcher",
  kind: "service" as const,
};
const envelope = {
  schemaVersion: 1 as const,
  objective: "Run one exact bounded repository query on an eligible owned workstation.",
  scopeClass: "atomic" as const,
  estimate: { lowMinutes: 0, likelyMinutes: 1, highMinutes: 3, confidence: 0.8 },
  budget: { expectedMessages: 1, expectedToolCalls: 1, expectedReviewMinutes: 0 },
  boundaries: { softCheckpointMinutes: 1, forcedHandoffMinutes: 2, hardRecoveryMinutes: 3 },
  completion: {
    requiredOutputs: ["bounded repo-query/v1 receipt"],
    verificationRequired: true,
    continuationStateRequired: false,
    acceptanceChecks: ["receipt binds exact source and profile"],
  },
  durableState: {
    accessClass: "project" as const,
    retentionClass: "standard" as const,
    redactionRequired: true,
    deleteAfter: null,
  },
};

describe("runner-neutral exact work dispatch", () => {
  test("queues once and returns the same canonical run on exact replay", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    try {
      const item = await ledger.createItem({
        project: "glaeda",
        kind: "task",
        title: "Query one exact Glaeda candidate",
        priority: 90,
        actor,
      });
      const input = {
        project: "glaeda",
        itemId: item.id,
        expectedClaimGeneration: item.claimGeneration,
        actor,
        runnerType: "glaeda-workstation",
        runnerProfile: "repo-query/v1",
        runnerProfileVersion: `sha256:${"a".repeat(64)}`,
        executionEnvelope: envelope,
        leaseSeconds: 900,
        maxAttempts: 3,
        retryBackoffSeconds: 60,
        idempotencyKey: "dispatch-owned-workstation-query-1",
      };
      const dispatched = await ledger.dispatchWork(input);
      expect(dispatched).toMatchObject({
        status: "dispatched",
        replay: false,
        expectedClaimGeneration: 0,
        claimedGeneration: 1,
        item: { id: item.id, status: "active", claimGeneration: 1 },
        run: {
          status: "queued",
          runnerType: "glaeda-workstation",
          runnerProfile: "repo-query/v1",
          runnerProfileVersion: input.runnerProfileVersion,
          generation: 1,
          leaseGeneration: 1,
          executionEnvelope: envelope,
        },
      });

      const replay = await ledger.dispatchWork(input);
      expect(replay.replay).toBe(true);
      expect(replay.run).toEqual(dispatched.run);
      expect(replay.item).toEqual(dispatched.item);
      expect(await ledger.listRuns({ itemId: item.id })).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("refuses stale generations and changed reuse of one dispatch identity", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    try {
      const item = await ledger.createItem({
        project: "glaeda",
        kind: "task",
        title: "Fence one workstation dispatch",
        priority: 90,
        actor,
      });
      const input = {
        project: "glaeda",
        itemId: item.id,
        expectedClaimGeneration: 0,
        actor,
        runnerType: "glaeda-workstation",
        runnerProfile: "repo-query/v1",
        runnerProfileVersion: `sha256:${"b".repeat(64)}`,
        executionEnvelope: envelope,
        leaseSeconds: 900,
        maxAttempts: 3,
        retryBackoffSeconds: 60,
        idempotencyKey: "dispatch-owned-workstation-query-2",
      };
      await ledger.dispatchWork(input);
      await expect(ledger.dispatchWork({
        ...input,
        expectedClaimGeneration: 1,
      })).rejects.toThrow(/different dispatch request|changed requested work identity/);
      await expect(ledger.dispatchWork({
        ...input,
        idempotencyKey: "dispatch-owned-workstation-query-stale",
      })).rejects.toThrow(/not currently eligible/);
      expect(await ledger.listRuns({ itemId: item.id })).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
