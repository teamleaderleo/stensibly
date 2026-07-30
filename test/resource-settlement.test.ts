import { describe, expect, test } from "bun:test";
import {
  AuthoritativeSettlementController,
  createResourceSettlementReceipt,
  evaluateResourceGenerationAdvance,
  parseResourceSettlementReceipt,
  type ResourceSettlementInput,
  type ResourceSettlementOwnerInput,
} from "../src/resource-settlement.js";

const hash = (digit: number): string => `sha256:${String(digit).repeat(64).slice(0, 64)}`;
const at = (second: number): string =>
  `2026-07-30T00:00:${String(second).padStart(2, "0")}.000Z`;

function owner(
  id: string,
  state: ResourceSettlementOwnerInput["state"],
  overrides: Partial<ResourceSettlementOwnerInput> = {},
): ResourceSettlementOwnerInput {
  const failed = state === "settled_failure"
    || state === "reconciliation_required"
    || state === "publication_fenced";
  return {
    id,
    kind: id.startsWith("artifact") ? "artifact" : "worker",
    generation: 1,
    attempted: state !== "pending",
    state,
    attemptedAt: state === "pending" ? null : at(2),
    settledAt: state === "pending" ? null : at(3),
    failureClass: failed ? "worker_failure" : null,
    reconciliationRequired: state === "reconciliation_required",
    canPublishLate: state === "publication_fenced",
    outputFingerprint: null,
    publicationFenceFingerprint: state === "publication_fenced" ? hash(9) : null,
    ...overrides,
  };
}

function canonicalOwners(owners: ResourceSettlementOwnerInput[]): ResourceSettlementOwnerInput[] {
  return [...owners].sort((left, right) => {
    const leftKey = `${left.kind}:${left.id}:g${left.generation}`;
    const rightKey = `${right.kind}:${right.id}:g${right.generation}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function input(
  owners: ResourceSettlementOwnerInput[],
  overrides: Partial<ResourceSettlementInput> = {},
): ResourceSettlementInput {
  return {
    workspace: "default",
    project: "alpha",
    resourceId: "runner:one",
    resourceKind: "runner",
    generation: 1,
    operationRef: "stop:one",
    policyVersion: "settlement-v1",
    failureMode: "continue_through_error",
    admissionState: "closed",
    disposition: null,
    openedAt: at(0),
    closingStartedAt: at(1),
    terminalAt: null,
    observedAt: at(9),
    owners: canonicalOwners(owners),
    ...overrides,
  };
}

describe("authoritative resource settlement", () => {
  test("joins one completion and shields it from a cancelled waiter", async () => {
    const controller = new AuthoritativeSettlementController<number>();
    let calls = 0;
    let resolve!: (value: number) => void;

    const first = controller.start(() => {
      calls += 1;
      return new Promise<number>((done) => {
        resolve = done;
      });
    });
    const second = controller.start(() => {
      calls += 1;
      return 99;
    });

    expect(second).toBe(first);
    expect(controller.phase).toBe("closing");
    expect(controller.admissionOpen).toBe(false);

    const abort = new AbortController();
    const cancelled = controller.wait(abort.signal);
    const surviving = controller.wait();
    abort.abort();
    await Promise.resolve();
    resolve(7);

    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await expect(surviving).resolves.toBe(7);
    await expect(first).resolves.toBe(7);
    expect(controller.phase).toBe("settled_success");
    expect(controller.start(() => 8)).toBe(first);
    expect(calls).toBe(1);
  });

  test("shares one terminal failure with concurrent and later callers", async () => {
    const controller = new AuthoritativeSettlementController<number>();
    const failure = new Error("synthetic cleanup failure");
    const first = controller.start(() => Promise.reject(failure));
    const second = controller.start(() => 1);

    expect(second).toBe(first);
    await expect(first).rejects.toBe(failure);
    await expect(controller.wait()).rejects.toBe(failure);
    expect(controller.phase).toBe("settled_failure");
    expect(controller.admissionOpen).toBe(false);
  });

  test("rejects waiting before the authoritative operation starts", () => {
    const controller = new AuthoritativeSettlementController<void>();
    expect(() => controller.wait()).toThrow("has not started");
    expect(controller.admissionOpen).toBe(true);
  });
});

describe("resource settlement receipts", () => {
  test("keeps a closed resource nonterminal while any owner remains pending", () => {
    const receipt = createResourceSettlementReceipt(input([
      owner("worker-a", "pending", { attempted: true, attemptedAt: at(2) }),
      owner("worker-b", "settled_success"),
    ]));

    expect(receipt.phase).toBe("closing");
    expect(receipt.counts).toEqual({
      total: 2,
      pending: 1,
      settledSuccess: 1,
      settledFailure: 0,
      reconciliationRequired: 0,
      publicationFenced: 0,
    });
    expect(evaluateResourceGenerationAdvance(receipt, 2)).toMatchObject({
      allowed: false,
      reason: "settlement_not_terminal",
    });
  });

  test("retains successful outputs when aggregate settlement fails", () => {
    const receipt = createResourceSettlementReceipt(input([
      owner("artifact-a", "settled_success", {
        kind: "artifact",
        outputFingerprint: hash(1),
      }),
      owner("worker-a", "settled_failure", {
        outputFingerprint: hash(2),
      }),
      owner("worker-b", "publication_fenced"),
    ], {
      terminalAt: at(5),
      disposition: "retired",
    }));

    expect(receipt.phase).toBe("settled_failure");
    expect(receipt.successfulOutputs).toEqual([
      { ownerKey: "artifact:artifact-a:g1", outputFingerprint: hash(1) },
      { ownerKey: "worker:worker-a:g1", outputFingerprint: hash(2) },
    ]);
    expect(receipt.counts.publicationFenced).toBe(1);
    expect(receipt.settlementRetryAuthorization).toBe("not_authorized");
    expect(evaluateResourceGenerationAdvance(receipt, 2)).toMatchObject({
      allowed: true,
      reason: "next_generation_allowed",
    });
    expect(parseResourceSettlementReceipt(receipt)).toEqual(receipt);
  });

  test("blocks generation advancement while reconciliation remains required", () => {
    const receipt = createResourceSettlementReceipt(input([
      owner("worker-a", "reconciliation_required", {
        failureClass: "unknown_outcome",
        canPublishLate: true,
      }),
    ], {
      terminalAt: at(5),
      disposition: "reconciliation_hold",
    }));

    expect(receipt.reconciliationOwnerKeys).toEqual(["worker:worker-a:g1"]);
    expect(evaluateResourceGenerationAdvance(receipt, 2)).toMatchObject({
      allowed: false,
      reason: "reconciliation_still_required",
    });
    expect(evaluateResourceGenerationAdvance(receipt, 3)).toMatchObject({
      allowed: false,
      reason: "generation_must_increase_by_one",
    });
  });

  test("enforces stop-after-failure by chronology rather than owner sort order", () => {
    const owners = [
      owner("worker-a", "pending", {
        attempted: true,
        attemptedAt: at(5),
      }),
      owner("worker-z", "settled_failure", {
        attemptedAt: at(2),
        settledAt: at(3),
      }),
    ];

    expect(() => createResourceSettlementReceipt(input(owners, {
      failureMode: "stop_after_failure",
    }))).toThrow("after failure settlement");
  });

  test("requires exact publication-fence evidence", () => {
    expect(() => createResourceSettlementReceipt(input([
      owner("worker-a", "publication_fenced", {
        publicationFenceFingerprint: null,
      }),
    ], {
      terminalAt: at(5),
      disposition: "retired",
    }))).toThrow("Publication-fenced owner evidence is inconsistent");

    expect(() => createResourceSettlementReceipt(input([
      owner("worker-a", "settled_failure", {
        publicationFenceFingerprint: hash(7),
      }),
    ], {
      terminalAt: at(5),
      disposition: "retired",
    }))).toThrow("Failed settlement owner evidence is inconsistent");
  });

  test("rejects terminal publication before all owner settlement evidence", () => {
    expect(() => createResourceSettlementReceipt(input([
      owner("worker-a", "settled_success", { settledAt: at(4) }),
    ], {
      terminalAt: at(3),
      disposition: "reusable",
    }))).toThrow("precedes owner settlement evidence");
  });

  test("rejects unknown fields, malformed time, duplicates, and noncanonical order", () => {
    expect(() => createResourceSettlementReceipt({
      ...input([owner("worker-a", "pending")]),
      rawFailure: "secret",
    })).toThrow("unknown field rawFailure");

    expect(() => createResourceSettlementReceipt(input([
      owner("worker-a", "pending"),
    ], {
      observedAt: "2026-07-30 00:00:09Z",
    }))).toThrow("canonical UTC timestamp");

    expect(() => createResourceSettlementReceipt(input([
      owner("worker-a", "pending"),
      owner("worker-a", "pending"),
    ]))).toThrow("unique and in canonical order");

    const unsorted = input([
      owner("worker-b", "pending"),
      owner("worker-a", "pending"),
    ]);
    unsorted.owners.reverse();
    expect(() => createResourceSettlementReceipt(unsorted)).toThrow("canonical order");
  });

  test("fails closed when derived receipt fields are altered", () => {
    const receipt = createResourceSettlementReceipt(input([
      owner("worker-a", "settled_success", { outputFingerprint: hash(3) }),
    ], {
      terminalAt: at(5),
      disposition: "reusable",
    }));

    const counts = structuredClone(receipt) as unknown as Record<string, unknown>;
    counts.counts = { ...receipt.counts, settledSuccess: 0 };
    expect(() => parseResourceSettlementReceipt(counts)).toThrow("counts are not derived correctly");

    const outputs = structuredClone(receipt) as unknown as Record<string, unknown>;
    outputs.successfulOutputs = [];
    expect(() => parseResourceSettlementReceipt(outputs)).toThrow("outputs are not derived correctly");

    const retry = structuredClone(receipt) as unknown as Record<string, unknown>;
    retry.settlementRetryAuthorization = "authorized";
    expect(() => parseResourceSettlementReceipt(retry)).toThrow("cannot authorize retry");
  });
});
