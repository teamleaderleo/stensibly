import { describe, expect, test } from "bun:test";
import { MAX_EXECUTION_RECORDS_PER_RUN } from "../src/execution-record-limits.ts";
import type { ExecutionEnvelope } from "../src/execution-envelope.ts";
import { createWorkRun, getWorkRun } from "../src/runs.ts";
import { StensiblyStore } from "../src/store.ts";

const actor = { id: "agent:bounds", name: "Bounds", kind: "agent" as const };
const envelope: ExecutionEnvelope = {
  schemaVersion: 1,
  objective: "Verify bounded local execution history",
  scopeClass: "atomic",
  estimate: { lowMinutes: 5, likelyMinutes: 10, highMinutes: 20, confidence: 0.8 },
  budget: { expectedMessages: 1, expectedToolCalls: 5, expectedReviewMinutes: 2 },
  boundaries: { softCheckpointMinutes: 12, forcedHandoffMinutes: 18, hardRecoveryMinutes: 25 },
  completion: {
    requiredOutputs: ["bounded projection"],
    verificationRequired: true,
    continuationStateRequired: false,
    acceptanceChecks: ["limit and overflow are deterministic"],
  },
  durableState: {
    accessClass: "project",
    retentionClass: "standard",
    redactionRequired: false,
    deleteAfter: null,
  },
};

describe("local execution-record projection bounds", () => {
  test("returns exactly the shared limit and fails closed above it", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = store.createItem({
        project: "bounds",
        kind: "task",
        title: "Bound local execution history",
        nextAction: "Read the bounded run.",
        priority: 50,
        actor,
      });
      const run = createWorkRun(store, {
        itemId: item.id,
        actor,
        runnerType: "generic-mcp",
        runnerProfile: "bounds",
        leaseSeconds: 300,
        executionEnvelope: envelope,
      });
      const insert = store.db.query(`
        INSERT INTO run_execution_records (
          id, run_id, run_generation, lease_generation,
          transition, actual_json, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      `);
      for (let index = 0; index < MAX_EXECUTION_RECORDS_PER_RUN; index += 1) {
        insert.run(
          `record-${index}`,
          run.id,
          index + 2,
          1,
          "succeed",
          JSON.stringify({ toolCalls: index }),
          new Date(1_000 + index).toISOString(),
        );
      }
      expect(getWorkRun(store, run.id).executionRecords).toHaveLength(
        MAX_EXECUTION_RECORDS_PER_RUN,
      );

      insert.run(
        "record-overflow",
        run.id,
        MAX_EXECUTION_RECORDS_PER_RUN + 2,
        1,
        "succeed",
        "{}",
        new Date(2_000).toISOString(),
      );
      expect(() => getWorkRun(store, run.id)).toThrow(
        "Run execution-result history exceeds the bounded projection",
      );
    } finally {
      store.close();
    }
  });
});
