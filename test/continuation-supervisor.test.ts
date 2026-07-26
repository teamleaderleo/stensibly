import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { ConflictError, StensiblyStore } from "../src/store.ts";

const human = { id: "human:leo", name: "Leo", kind: "human" as const };
const supervisor = {
  id: "service:supervisor",
  name: "Supervisor",
  kind: "service" as const,
};
const agent = { id: "agent:worker", name: "Worker", kind: "agent" as const };

let store: StensiblyStore;
let ledger: SqliteWorkLedger;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
  ledger = new SqliteWorkLedger(store);
});

afterEach(() => store.close());

describe("continuation supervisor dispatch", () => {
  test("approves, dispatches the exact item, and consumes the proposal atomically", async () => {
    const source = await createItem("source", 90);
    const target = await createItem("target", 10);
    await createItem("higher unrelated work", 100);
    const proposal = await ledger.proposeContinuation({
      sourceItemId: source.id,
      title: "Dispatch the exact target",
      rationale: "The target is the durable owner of the follow-up.",
      instruction: "Run the exact target through the supervisor.",
      action: {
        kind: "dispatch_item",
        itemId: target.id,
        runnerProfile: "special-profile",
      },
      actor: agent,
      approvalMode: "human",
      deliveryMode: "supervisor",
    });
    const input = {
      id: proposal.id,
      actor: human,
      supervisor,
      expectedGeneration: proposal.generation,
      runnerType: "generic-mcp",
      runnerProfile: "fallback-profile",
      idempotencyKey: "queue-continuation-1",
    };

    const result = await ledger.queueContinuationForSupervisor(input);
    expect(result).toMatchObject({
      continuation: {
        id: proposal.id,
        status: "consumed",
        generation: proposal.generation + 2,
        result: {
          itemId: target.id,
          runId: result.run.id,
        },
      },
      item: {
        id: target.id,
        status: "active",
        claimedBy: supervisor.id,
      },
      run: {
        itemId: target.id,
        runnerProfile: "special-profile",
        continuationRef: proposal.id,
        status: "queued",
      },
      createdItemId: null,
      notificationRecommended: false,
    });
    expect(await ledger.queueContinuationForSupervisor(input)).toEqual(result);
    expect(store.getItem(source.id).status).toBe("ready");
    expect(store.listEvents(source.id).map((event) => event.type)).toEqual([
      "item.created",
      "continuation.proposed",
      "continuation.approved",
      "continuation.consumed",
    ]);

    await expect(ledger.queueContinuationForSupervisor({
      ...input,
      runnerProfile: "changed-replay",
    })).rejects.toThrow(ConflictError);
  });

  test("creates and dispatches a tracked item for create-item actions", async () => {
    const source = await createItem("create source", 72, "alpha");
    const proposal = await ledger.proposeContinuation({
      sourceItemId: source.id,
      title: "Implement the follow-up",
      rationale: "The follow-up deserves its own tracked item.",
      instruction: "Implement and verify the follow-up.",
      action: { kind: "create_item", project: "beta" },
      actor: agent,
      approvalMode: "human",
      deliveryMode: "supervisor",
    });

    const result = await ledger.queueContinuationForSupervisor({
      id: proposal.id,
      actor: human,
      supervisor,
      expectedGeneration: proposal.generation,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      idempotencyKey: "queue-create-item",
    });
    expect(result.createdItemId).toBe(result.item.id);
    expect(result.item).toMatchObject({
      project: "beta",
      title: proposal.title,
      summary: proposal.rationale,
      nextAction: proposal.instruction,
      priority: source.priority,
      status: "active",
    });
    expect(result.run.itemId).toBe(result.item.id);
    expect(result.continuation.result).toEqual({
      itemId: result.item.id,
      runId: result.run.id,
    });
  });

  test("rolls approval and created work back when dispatch cannot start", async () => {
    const source = await createItem("rollback source", 60);
    const target = await createItem("blocked target", 50);
    await ledger.blockWork({
      id: target.id,
      actor: supervisor,
      expectedClaimGeneration: target.claimGeneration,
      reason: "Target is not ready.",
    });
    const proposal = await ledger.proposeContinuation({
      sourceItemId: source.id,
      title: "Resume the blocked target",
      rationale: "This should fail atomically while blocked.",
      instruction: "Resume the target.",
      action: { kind: "resume_item", itemId: target.id },
      actor: agent,
      approvalMode: "human",
      deliveryMode: "supervisor",
    });

    await expect(ledger.queueContinuationForSupervisor({
      id: proposal.id,
      actor: human,
      supervisor,
      expectedGeneration: proposal.generation,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      idempotencyKey: "queue-rollback",
    })).rejects.toThrow("not eligible for supervisor dispatch");

    expect(await ledger.getContinuation(proposal.id)).toMatchObject({
      status: "proposed",
      generation: proposal.generation,
    });
    expect(store.getItem(target.id).status).toBe("blocked");
    expect(store.listEvents(source.id).map((event) => event.type)).toEqual([
      "item.created",
      "continuation.proposed",
    ]);
  });

  test("rejects stale generations and terminal rejected proposals without dispatch", async () => {
    const source = await createItem("guard source", 60);
    const staleTarget = await createItem("stale target", 50);
    const stale = await ledger.proposeContinuation({
      sourceItemId: source.id,
      title: "Stale dispatch",
      rationale: "The generation guard must win.",
      instruction: "Queue only from the current generation.",
      action: { kind: "dispatch_item", itemId: staleTarget.id },
      actor: agent,
      approvalMode: "human",
      deliveryMode: "supervisor",
    });

    await expect(ledger.queueContinuationForSupervisor({
      id: stale.id,
      actor: human,
      supervisor,
      expectedGeneration: stale.generation + 1,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
    })).rejects.toThrow(ConflictError);
    expect(await ledger.getContinuation(stale.id)).toMatchObject({
      status: "proposed",
      generation: stale.generation,
    });
    expect(store.getItem(staleTarget.id).status).toBe("ready");

    const rejectedTarget = await createItem("rejected target", 40);
    const rejectable = await ledger.proposeContinuation({
      sourceItemId: source.id,
      title: "Rejected dispatch",
      rationale: "Rejected work stays human-owned.",
      instruction: "Do not queue after rejection.",
      action: { kind: "dispatch_item", itemId: rejectedTarget.id },
      actor: agent,
      approvalMode: "human",
      deliveryMode: "supervisor",
    });
    const rejected = await ledger.resolveContinuation({
      id: rejectable.id,
      actor: human,
      command: "reject",
      expectedGeneration: rejectable.generation,
      note: "Declined.",
    });

    await expect(ledger.queueContinuationForSupervisor({
      id: rejected.id,
      actor: human,
      supervisor,
      expectedGeneration: rejected.generation,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
    })).rejects.toThrow("cannot queue for supervisor while rejected");
    expect(await ledger.getContinuation(rejected.id)).toMatchObject({
      status: "rejected",
      generation: rejected.generation,
    });
    expect(store.getItem(rejectedTarget.id).status).toBe("ready");
  });

  test("runs automatic and notify policy while skipping human and decision work", async () => {
    const automaticTarget = await createItem("automatic target", 50, "alpha");
    const notifyTarget = await createItem("notify target", 40, "alpha");
    const humanTarget = await createItem("human target", 30, "alpha");
    const crossProjectTarget = await createItem("cross-project target", 20, "beta");
    const source = await createItem("policy source", 60, "alpha");

    const automatic = await proposePolicy(
      source.id,
      "automatic",
      { kind: "dispatch_item", itemId: automaticTarget.id },
    );
    const notify = await proposePolicy(
      source.id,
      "notify",
      { kind: "resume_item", itemId: notifyTarget.id },
    );
    await proposePolicy(
      source.id,
      "human",
      { kind: "dispatch_item", itemId: humanTarget.id },
    );
    const decision = await proposePolicy(
      source.id,
      "automatic",
      { kind: "request_decision", decisionType: "human_review" },
    );
    const crossProject = await proposePolicy(
      source.id,
      "automatic",
      { kind: "dispatch_item", itemId: crossProjectTarget.id },
    );

    const result = await ledger.runContinuationSupervisorPolicy({
      supervisor,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      project: "alpha",
      limit: 10,
    });
    expect(result.considered).toBe(3);
    expect(result.dispatched.map((entry) => entry.continuation.id).sort()).toEqual([
      automatic.id,
      notify.id,
    ].sort());
    expect(result.dispatched.find((entry) => entry.continuation.id === notify.id))
      .toMatchObject({ notificationRecommended: true });
    expect(result.skipped).toEqual([
      expect.objectContaining({
        id: decision.id,
        reason: "Decision requests remain human-owned.",
      }),
    ]);
    expect(store.getItem(humanTarget.id).status).toBe("ready");
    expect(store.getItem(crossProjectTarget.id).status).toBe("ready");
    expect(await ledger.getContinuation(crossProject.id)).toMatchObject({
      status: "proposed",
      generation: crossProject.generation,
    });
    expect(store.listEvents(source.id).map((event) => event.type)).toContain(
      "continuation.supervisor_notified",
    );

    const replay = await ledger.runContinuationSupervisorPolicy({
      supervisor,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      project: "alpha",
      limit: 10,
    });
    expect(replay.dispatched).toEqual([]);
    expect(replay.skipped.map((entry) => entry.id)).toEqual([decision.id]);
  });
});

async function createItem(title: string, priority: number, project = "orchestration") {
  return await ledger.createItem({
    project,
    kind: "task",
    title,
    nextAction: `Continue ${title}.`,
    priority,
    actor: supervisor,
  });
}

async function proposePolicy(
  sourceItemId: string,
  approvalMode: "automatic" | "notify" | "human",
  action:
    | { kind: "dispatch_item"; itemId: string }
    | { kind: "resume_item"; itemId: string }
    | { kind: "request_decision"; decisionType: string },
) {
  return await ledger.proposeContinuation({
    sourceItemId,
    title: `${approvalMode} supervisor proposal`,
    rationale: "Supervisor policy should evaluate this proposal.",
    instruction: "Queue the typed action.",
    action,
    actor: agent,
    approvalMode,
    deliveryMode: "supervisor",
  });
}
