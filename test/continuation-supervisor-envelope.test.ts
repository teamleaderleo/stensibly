import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { queueContinuationForSupervisorSchema } from "../src/continuation-supervisor-contracts.ts";
import type { ExecutionEnvelope } from "../src/execution-envelope.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { ConflictError, StensiblyStore } from "../src/store.ts";

const human = { id: "human:leo", name: "Leo", kind: "human" as const };
const supervisor = {
  id: "service:supervisor",
  name: "Supervisor",
  kind: "service" as const,
};
const agent = { id: "agent:worker", name: "Worker", kind: "agent" as const };
const executionEnvelope: ExecutionEnvelope = {
  schemaVersion: 1,
  objective: "Dispatch and verify the exact continuation",
  scopeClass: "segmented",
  estimate: {
    lowMinutes: 20,
    likelyMinutes: 40,
    highMinutes: 70,
    confidence: 0.65,
  },
  budget: {
    expectedMessages: 3,
    expectedToolCalls: 24,
    expectedReviewMinutes: 8,
  },
  boundaries: {
    softCheckpointMinutes: 50,
    forcedHandoffMinutes: 75,
    hardRecoveryMinutes: 90,
  },
  completion: {
    requiredOutputs: ["implementation", "tests"],
    verificationRequired: true,
    continuationStateRequired: true,
    acceptanceChecks: ["targeted checks pass"],
  },
  durableState: {
    accessClass: "project",
    retentionClass: "standard",
    redactionRequired: true,
    deleteAfter: null,
  },
};

let store: StensiblyStore;
let ledger: SqliteWorkLedger;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  ledger = new SqliteWorkLedger(store);
});

afterEach(() => store.close());

describe("local continuation supervisor execution envelopes", () => {
  test("validates, persists, and compares the exact envelope on replay", async () => {
    const source = await ledger.createItem({
      project: "orchestration",
      kind: "task",
      title: "Envelope source",
      nextAction: "Queue the bounded continuation.",
      priority: 80,
      actor: supervisor,
    });
    const target = await ledger.createItem({
      project: "orchestration",
      kind: "task",
      title: "Envelope target",
      nextAction: "Execute the bounded continuation.",
      priority: 70,
      actor: supervisor,
    });
    const proposal = await ledger.proposeContinuation({
      sourceItemId: source.id,
      title: "Dispatch with an envelope",
      rationale: "The run needs one durable execution contract.",
      instruction: "Execute and verify the target.",
      action: { kind: "dispatch_item", itemId: target.id },
      actor: agent,
      approvalMode: "human",
      deliveryMode: "supervisor",
    });
    const parsed = queueContinuationForSupervisorSchema.parse({
      actor: human,
      supervisor,
      expectedGeneration: proposal.generation,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      executionEnvelope,
    });
    const input = {
      id: proposal.id,
      ...parsed,
      idempotencyKey: "local-supervisor-envelope",
    };

    const first = await ledger.queueContinuationForSupervisor(input);
    const replay = await ledger.queueContinuationForSupervisor(input);

    expect(first.run.executionEnvelope).toEqual(executionEnvelope);
    expect(first.run.executionRecords).toEqual([]);
    expect(replay).toEqual(first);
    await expect(ledger.queueContinuationForSupervisor({
      ...input,
      executionEnvelope: {
        ...executionEnvelope,
        objective: "Changed replay objective",
      },
    })).rejects.toThrow(ConflictError);
  });

  test("rejects malformed envelope ordering at the request boundary", () => {
    const parsed = queueContinuationForSupervisorSchema.safeParse({
      actor: human,
      supervisor,
      expectedGeneration: 1,
      executionEnvelope: {
        ...executionEnvelope,
        estimate: {
          lowMinutes: 50,
          likelyMinutes: 40,
          highMinutes: 70,
          confidence: 0.65,
        },
      },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toContain(
        "Execution estimate must satisfy lowMinutes <= likelyMinutes <= highMinutes",
      );
    }
  });
});
