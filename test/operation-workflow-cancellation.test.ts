import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertOperationWorkflowTransition,
  canonicalOperationWorkflowJson,
} from "../src/operation-workflow-admission.js";
import {
  OperationWorkflowCancellationService,
  operationWorkflowCancellationActionId,
  type OperationWorkflowCancellationAuthorityInput,
  type OperationWorkflowCancellationInput,
} from "../src/operation-workflow-cancellation.js";
import {
  OperationWorkflowConflictError,
  type OperationWorkflow,
  type OperationWorkflowReservation,
  type OperationWorkflowStore,
} from "../src/operation-workflow-contracts.js";
import {
  buildOperationWorkflow,
  reserveOperationWorkflowStep,
  settleOperationWorkflowStep,
} from "../src/operation-workflow-machine.js";
import { SqliteOperationWorkflowStore } from "../src/operation-workflow-sqlite-store.js";
import { StensiblyStore } from "../src/store.js";

const at = (second: number) => `2026-08-15T10:00:${String(second).padStart(2, "0")}.000Z`;
const generation = 3;

function workflow(id = "opw_cancel_race"): OperationWorkflow {
  return buildOperationWorkflow({
    id,
    project: "stensibly",
    itemId: "item_1567",
    runId: "run_cancel",
    actorId: "agent_cancel",
    clientId: "codex",
    kind: "github_publish_change",
    target: "teamleaderleo/stensibly:refs/heads/cancel-race",
    request: { issue: 1567, purpose: "truthful cancellation" },
    idempotencyKey: "operation-cancel:1567",
    authorityFence: {
      resource: `run:run_cancel:generation:${generation}`,
      holderId: "agent_cancel",
      generation,
      expiresAt: at(59),
    },
    steps: [
      {
        kind: "external_one",
        command: { ordinal: 1 },
        compensation: { disposition: "irreversible" },
      },
      {
        kind: "external_two",
        command: { ordinal: 2 },
        compensation: { disposition: "irreversible" },
      },
      {
        kind: "external_three",
        command: { ordinal: 3 },
        compensation: { disposition: "irreversible" },
      },
    ],
    now: at(0),
  });
}

function cancellationInput(overrides: Partial<OperationWorkflowCancellationInput> = {}): OperationWorkflowCancellationInput {
  return {
    project: "stensibly",
    workflowId: "opw_cancel_race",
    workflowIdempotencyKey: "operation-cancel:1567",
    actorId: "agent_cancel",
    clientId: "codex",
    authorityGeneration: generation,
    ...overrides,
  };
}

class MemoryWorkflowStore implements OperationWorkflowStore {
  current: OperationWorkflow;
  transitions = 0;

  constructor(initial = workflow()) {
    this.current = initial;
  }

  async reserveOperationWorkflow(requested: OperationWorkflow): Promise<OperationWorkflowReservation> {
    if (canonicalOperationWorkflowJson(requested) === canonicalOperationWorkflowJson(this.current)) {
      return { outcome: "replay", workflow: this.current };
    }
    return { outcome: "conflict", workflow: this.current };
  }

  async transitionOperationWorkflow(input: {
    current: OperationWorkflow;
    next: OperationWorkflow;
  }): Promise<OperationWorkflow> {
    assertOperationWorkflowTransition(input.current, input.next);
    if (canonicalOperationWorkflowJson(input.current) !== canonicalOperationWorkflowJson(this.current)) {
      throw new Error("memory workflow CAS changed");
    }
    this.transitions += 1;
    this.current = input.next;
    return this.current;
  }

  async getOperationWorkflow(project: string, idempotencyKey: string): Promise<OperationWorkflow | null> {
    return this.current.project === project && this.current.idempotencyKey === idempotencyKey
      ? this.current
      : null;
  }
}

class ProviderSettlementWinsStore extends MemoryWorkflowStore {
  injectedProviderSettlement = false;

  override async transitionOperationWorkflow(input: {
    current: OperationWorkflow;
    next: OperationWorkflow;
  }): Promise<OperationWorkflow> {
    if (!this.injectedProviderSettlement && input.next.cancellationRequestedAt !== null) {
      this.injectedProviderSettlement = true;
      const current = this.current;
      const providerSettled = settleOperationWorkflowStep(current, {
        stepId: current.steps[0]!.id,
        outcome: "verified",
        settledAt: at(5),
        providerReceiptRef: "provider-receipt:settlement-won",
        before: { absent: true },
        after: { providerEffect: "exists" },
        verification: { exactProviderReadback: true },
      });
      await super.transitionOperationWorkflow({ current, next: providerSettled });
      throw new Error("memory workflow CAS changed");
    }
    return super.transitionOperationWorkflow(input);
  }
}

function service(
  store: OperationWorkflowStore,
  options: {
    now?: string;
    assertAuthority?: (input: OperationWorkflowCancellationAuthorityInput) => Promise<void>;
  } = {},
) {
  return new OperationWorkflowCancellationService({
    workflows: store,
    now: () => options.now ?? at(10),
    assertAuthority: options.assertAuthority ?? (async (input) => {
      expect(input).toEqual({
        project: "stensibly",
        itemId: "item_1567",
        runId: "run_cancel",
        actorId: "agent_cancel",
        clientId: "codex",
        authorityGeneration: generation,
      });
    }),
  });
}

async function persist(
  store: MemoryWorkflowStore,
  next: OperationWorkflow,
): Promise<OperationWorkflow> {
  return store.transitionOperationWorkflow({ current: store.current, next });
}

function verified(
  current: OperationWorkflow,
  second = 2,
): OperationWorkflow {
  return settleOperationWorkflowStep(current, {
    stepId: current.steps[0]!.id,
    outcome: "verified",
    settledAt: at(second),
    providerReceiptRef: "provider-receipt:effect-one",
    before: { state: "before" },
    after: { state: "after" },
    verification: { exact: true },
  });
}

describe("operation workflow cancellation", () => {
  test("cancellation before external dispatch cancels every unscheduled step with zero provider authority", async () => {
    const store = new MemoryWorkflowStore();
    const result = await service(store).cancel(cancellationInput());

    expect(result.outcome).toBe("admitted");
    expect(result.workflow.state).toBe("cancelled");
    expect(result.workflow.cancellationRequestedAt).toBe(at(10));
    expect(result.workflow.steps.map((step) => step.state)).toEqual([
      "cancelled", "cancelled", "cancelled",
    ]);
    expect(result.workflow.steps.every((step) => step.reservedAt === null)).toBe(true);
    expect(result.workflow.steps.every((step) => step.providerReceiptRef === null)).toBe(true);
    expect(store.transitions).toBe(1);
  });

  test("cancellation after dispatch reservation preserves the in-flight step and blocks every new dispatch", async () => {
    const store = new MemoryWorkflowStore();
    const reserved = reserveOperationWorkflowStep(store.current, store.current.steps[0]!.id, at(1));
    await persist(store, reserved);
    const inFlightBefore = JSON.stringify(store.current.steps[0]);

    const result = await service(store).cancel(cancellationInput());

    expect(result.workflow.state).toBe("running");
    expect(result.workflow.steps.map((step) => step.state)).toEqual([
      "dispatch_reserved", "cancelled", "cancelled",
    ]);
    expect(JSON.stringify(result.workflow.steps[0])).toBe(inFlightBefore);
    expect(() => reserveOperationWorkflowStep(
      result.workflow,
      result.workflow.steps[1]!.id,
      at(11),
    )).toThrow("Operation workflow cancellation stops new provider dispatch");
  });

  test("provider settlement winning the first CAS is preserved before cancellation retries from durable state", async () => {
    const store = new ProviderSettlementWinsStore();
    await persist(store, reserveOperationWorkflowStep(store.current, store.current.steps[0]!.id, at(1)));

    const result = await service(store).cancel(cancellationInput());

    expect(store.injectedProviderSettlement).toBe(true);
    expect(result.outcome).toBe("admitted");
    expect(result.workflow).toMatchObject({
      state: "cancelled",
      cancellationRequestedAt: at(10),
      terminalAt: at(10),
      recovery: { nextAction: "none" },
    });
    expect(result.workflow.steps.map((step) => step.state)).toEqual(["verified", "cancelled", "cancelled"]);
    expect(result.workflow.steps[0]).toMatchObject({
      providerReceiptRef: "provider-receipt:settlement-won",
      settledAt: at(5),
    });
    expect(store.transitions).toBe(3);
  });

  test("cancellation during an ambiguous provider outcome remains reconciliation-only", async () => {
    const store = new MemoryWorkflowStore();
    const reserved = reserveOperationWorkflowStep(store.current, store.current.steps[0]!.id, at(1));
    await persist(store, reserved);
    const pending = settleOperationWorkflowStep(store.current, {
      stepId: store.current.steps[0]!.id,
      outcome: "pending_reconciliation",
      settledAt: at(2),
      providerReceiptRef: "provider-receipt:ambiguous-one",
      errorCode: "provider_outcome_ambiguous",
    });
    await persist(store, pending);

    const result = await service(store).cancel(cancellationInput());

    expect(result.workflow.state).toBe("waiting_reconciliation");
    expect(result.workflow.recovery.nextAction).toBe("reconcile_current_step");
    expect(result.workflow.steps[0]).toMatchObject({
      state: "pending_reconciliation",
      providerReceiptRef: "provider-receipt:ambiguous-one",
      retry: "reconcile_before_retry",
    });
    expect(result.workflow.steps.slice(1).map((step) => step.state)).toEqual(["cancelled", "cancelled"]);
  });

  test("stale in-flight success loses the CAS, then exact reconciliation preserves success and cancellation", async () => {
    const store = new MemoryWorkflowStore();
    await persist(store, reserveOperationWorkflowStep(store.current, store.current.steps[0]!.id, at(1)));
    const staleInFlight = store.current;
    const cancelled = (await service(store).cancel(cancellationInput())).workflow;

    const staleProviderResult = settleOperationWorkflowStep(staleInFlight, {
      stepId: staleInFlight.steps[0]!.id,
      outcome: "verified",
      settledAt: at(11),
      providerReceiptRef: "provider-receipt:success-after-cancel",
      before: { absent: true },
      after: { providerEffect: "exists" },
      verification: { exactProviderReadback: true },
    });
    await expect(store.transitionOperationWorkflow({
      current: staleInFlight,
      next: staleProviderResult,
    })).rejects.toThrow("memory workflow CAS changed");
    expect(store.current).toEqual(cancelled);

    const reconciled = settleOperationWorkflowStep(store.current, {
      stepId: store.current.steps[0]!.id,
      outcome: "verified",
      settledAt: at(12),
      providerReceiptRef: "provider-receipt:success-after-cancel",
      before: { absent: true },
      after: { providerEffect: "exists" },
      verification: { exactProviderReadback: true },
    });
    await persist(store, reconciled);

    expect(store.current).toMatchObject({
      state: "cancelled",
      cancellationRequestedAt: at(10),
      terminalAt: at(12),
      recovery: { nextAction: "none" },
    });
    expect(store.current.steps.map((step) => step.state)).toEqual(["verified", "cancelled", "cancelled"]);
  });

  test("later exact reconciliation can prove definite failure or absence after prior success", async () => {
    const store = new MemoryWorkflowStore();
    await persist(store, reserveOperationWorkflowStep(store.current, store.current.steps[0]!.id, at(1)));
    await persist(store, verified(store.current));
    await persist(store, reserveOperationWorkflowStep(store.current, store.current.steps[1]!.id, at(3)));
    const completedBefore = JSON.stringify(store.current.steps[0]);
    const cancelled = (await service(store).cancel(cancellationInput())).workflow;
    const absent = settleOperationWorkflowStep(cancelled, {
      stepId: cancelled.steps[1]!.id,
      outcome: "rejected",
      settledAt: at(12),
      errorCode: "provider_effect_absent",
    });
    await persist(store, absent);

    expect(store.current.state).toBe("failed");
    expect(store.current.terminalAt).toBe(at(12));
    expect(JSON.stringify(store.current.steps[0])).toBe(completedBefore);
    expect(store.current.steps[0]).toMatchObject({
      state: "verified",
      providerReceiptRef: "provider-receipt:effect-one",
    });
    expect(store.current.steps[1]).toMatchObject({
      state: "rejected",
      errorCode: "provider_effect_absent",
      retry: "none",
    });
    expect(store.current.steps[2]!.state).toBe("cancelled");
  });

  test("cancellation preserves an already-completed external effect as immutable evidence", async () => {
    const store = new MemoryWorkflowStore();
    await persist(store, reserveOperationWorkflowStep(store.current, store.current.steps[0]!.id, at(1)));
    await persist(store, verified(store.current));
    const completedBefore = JSON.stringify(store.current.steps[0]);

    const result = await service(store).cancel(cancellationInput());

    expect(JSON.stringify(result.workflow.steps[0])).toBe(completedBefore);
    expect(result.workflow.steps[0]!.state).toBe("verified");
    expect(result.workflow.steps[0]!.providerReceiptRef).toBe("provider-receipt:effect-one");
    expect(result.workflow.steps.slice(1).map((step) => step.state)).toEqual(["cancelled", "cancelled"]);
    expect(result.workflow).toMatchObject({
      state: "cancelled",
      terminalAt: at(10),
      recovery: { nextAction: "none" },
    });
    expect(result.workflow.steps[0]!.compensation.state).toBe("unavailable");
  });

  test("exact cancellation replay creates zero second cancellation transition", async () => {
    const store = new MemoryWorkflowStore();
    const cancellation = service(store);
    const first = await cancellation.cancel(cancellationInput());
    const revision = first.workflow.revision;
    const timestamp = first.workflow.cancellationRequestedAt;
    const actionId = first.actionId;

    const replay = await cancellation.cancel(cancellationInput());

    expect(replay.outcome).toBe("replay");
    expect(replay.actionId).toBe(actionId);
    expect(replay.workflow.revision).toBe(revision);
    expect(replay.workflow.cancellationRequestedAt).toBe(timestamp);
    expect(store.transitions).toBe(1);
  });

  test("altered cancellation replay conflicts against durable workflow identity", async () => {
    const store = new MemoryWorkflowStore();
    const cancellation = service(store);
    await cancellation.cancel(cancellationInput());

    await expect(cancellation.cancel(cancellationInput({ clientId: "other-client" })))
      .rejects.toBeInstanceOf(OperationWorkflowConflictError);
    await expect(cancellation.cancel(cancellationInput({ workflowId: "opw_other" })))
      .rejects.toBeInstanceOf(OperationWorkflowConflictError);
    expect(store.transitions).toBe(1);
  });

  test("stale owner or authority generation fails closed before cancellation mutation", async () => {
    const generationStore = new MemoryWorkflowStore();
    let generationAuthorityCalls = 0;
    const generationService = service(generationStore, {
      assertAuthority: async () => { generationAuthorityCalls += 1; },
    });
    await expect(generationService.cancel(cancellationInput({ authorityGeneration: generation + 1 })))
      .rejects.toBeInstanceOf(OperationWorkflowConflictError);
    expect(generationAuthorityCalls).toBe(0);
    expect(generationStore.current.cancellationRequestedAt).toBeNull();
    expect(generationStore.transitions).toBe(0);

    const ownerStore = new MemoryWorkflowStore();
    const ownerService = service(ownerStore, {
      assertAuthority: async () => {
        throw new Error("workflow ownership changed");
      },
    });
    await expect(ownerService.cancel(cancellationInput())).rejects.toThrow("workflow ownership changed");
    expect(ownerStore.current.cancellationRequestedAt).toBeNull();
    expect(ownerStore.transitions).toBe(0);
  });

  test("restart after cancellation admission recovers from durable SQLite workflow state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "operation-workflow-cancel-restart-"));
    const database = join(directory, "db.sqlite");
    const firstStore = new StensiblyStore(database);
    firstStore.createItem({ project: "stensibly", kind: "task", title: "Cancellation fixture", priority: 50 });
    const firstWorkflows = new SqliteOperationWorkflowStore(firstStore);
    const initial = workflow();
    expect((await firstWorkflows.reserveOperationWorkflow(initial)).outcome).toBe("reserved");
    const reserved = reserveOperationWorkflowStep(initial, initial.steps[0]!.id, at(1));
    await firstWorkflows.transitionOperationWorkflow({ current: initial, next: reserved });
    const firstCancellation = new OperationWorkflowCancellationService({
      workflows: firstWorkflows,
      now: () => at(10),
      assertAuthority: async () => {},
    });
    const admitted = await firstCancellation.cancel(cancellationInput());
    const actionId = admitted.actionId;
    expect(admitted.workflow.steps.map((step) => step.state)).toEqual([
      "dispatch_reserved", "cancelled", "cancelled",
    ]);
    firstStore.close();

    const secondStore = new StensiblyStore(database);
    const secondWorkflows = new SqliteOperationWorkflowStore(secondStore);
    const recovered = await secondWorkflows.getOperationWorkflow("stensibly", "operation-cancel:1567");
    expect(recovered).not.toBeNull();
    expect(recovered!.cancellationRequestedAt).toBe(at(10));
    expect(recovered!.steps.map((step) => step.state)).toEqual([
      "dispatch_reserved", "cancelled", "cancelled",
    ]);
    expect(operationWorkflowCancellationActionId(recovered!, cancellationInput())).toBe(actionId);

    const replay = await new OperationWorkflowCancellationService({
      workflows: secondWorkflows,
      now: () => at(20),
      assertAuthority: async () => {},
    }).cancel(cancellationInput());
    expect(replay.outcome).toBe("replay");
    expect(replay.workflow.revision).toBe(recovered!.revision);

    const settled = settleOperationWorkflowStep(recovered!, {
      stepId: recovered!.steps[0]!.id,
      outcome: "verified",
      settledAt: at(21),
      providerReceiptRef: "provider-receipt:restart-success",
      before: { absent: true },
      after: { providerEffect: "exists" },
      verification: { exactProviderReadback: true },
    });
    const durableFinal = await secondWorkflows.transitionOperationWorkflow({
      current: recovered!,
      next: settled,
    });
    expect(durableFinal.state).toBe("cancelled");
    expect(durableFinal.terminalAt).toBe(at(21));
    expect(durableFinal.steps.map((step) => step.state)).toEqual(["verified", "cancelled", "cancelled"]);
    secondStore.close();
  });
});
