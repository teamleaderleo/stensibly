import { expect, test } from "bun:test";
import {
  createResourceSettlementReceipt,
  type ResourceSettlementInput,
  type ResourceSettlementOwnerInput,
} from "../src/resource-settlement.js";

const at = (second: number): string =>
  `2026-07-30T00:00:${String(second).padStart(2, "0")}.000Z`;

function owner(id: string): ResourceSettlementOwnerInput {
  return {
    id,
    kind: "worker",
    generation: 1,
    attempted: true,
    state: "settled_success",
    attemptedAt: at(2),
    settledAt: at(3),
    failureClass: null,
    reconciliationRequired: false,
    canPublishLate: false,
    outputFingerprint: null,
    publicationFenceFingerprint: null,
  };
}

function input(owners: ResourceSettlementOwnerInput[] = [owner("worker-a")]): ResourceSettlementInput {
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
    disposition: "reusable",
    openedAt: at(0),
    closingStartedAt: at(1),
    terminalAt: at(5),
    observedAt: at(9),
    owners,
  };
}

test("rejects top-level accessors without invoking them", () => {
  let getterCalls = 0;
  const hostile = input() as unknown as Record<string, unknown>;
  Object.defineProperty(hostile, "workspace", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("hostile workspace getter");
    },
  });

  expect(() => createResourceSettlementReceipt(hostile)).toThrow(
    "Resource settlement input must contain only enumerable data properties",
  );
  expect(getterCalls).toBe(0);
});

test("rejects inherited records before trusting their fields", () => {
  const inherited = Object.create(input()) as ResourceSettlementInput;
  expect(() => createResourceSettlementReceipt(inherited)).toThrow(
    "Resource settlement input must be a plain data object",
  );
});

test("rejects sparse, decorated, and symbolic owner arrays", () => {
  const sparse = new Array<ResourceSettlementOwnerInput>(1);
  expect(() => createResourceSettlementReceipt({ ...input(), owners: sparse })).toThrow(
    "Resource settlement owners must be a dense undecorated array",
  );

  const decorated = [owner("worker-a")];
  Object.defineProperty(decorated, "metadata", {
    enumerable: true,
    value: "unexpected",
  });
  expect(() => createResourceSettlementReceipt({ ...input(), owners: decorated })).toThrow(
    "Resource settlement owners must be a dense undecorated array",
  );

  const symbolic = [owner("worker-a")];
  Object.defineProperty(symbolic, Symbol("decoration"), {
    enumerable: true,
    value: "unexpected",
  });
  expect(() => createResourceSettlementReceipt({ ...input(), owners: symbolic })).toThrow(
    "Resource settlement owners must be a dense undecorated array",
  );
});

test("rejects owner accessors without invoking them", () => {
  let getterCalls = 0;
  const hostile = owner("worker-a") as unknown as Record<string, unknown>;
  Object.defineProperty(hostile, "id", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("hostile owner getter");
    },
  });

  expect(() => createResourceSettlementReceipt({
    ...input(),
    owners: [hostile as unknown as ResourceSettlementOwnerInput],
  })).toThrow("Resource settlement owner must contain only enumerable data properties");
  expect(getterCalls).toBe(0);
});

test("uses locale-independent code-unit owner ordering", () => {
  const receipt = createResourceSettlementReceipt(input([
    owner("B"),
    owner("a"),
  ]));
  expect(receipt.owners.map((entry) => entry.id)).toEqual(["B", "a"]);
});

test("rejects credential-shaped retained identifiers while preserving benign names", () => {
  const credentialValues = [
    `github_pat_${"a".repeat(40)}`,
    `ghp_${"a".repeat(36)}`,
    `stn.tok_${"a".repeat(24)}`,
    `sk-${"a".repeat(24)}`,
    `sk-proj-${"a".repeat(24)}`,
    `xoxb-${"a".repeat(20)}`,
    "secret://github/app-private-key",
    "env://GITHUB_TOKEN",
    `eyJ${"a".repeat(10)}.eyJ${"b".repeat(10)}.${"c".repeat(10)}`,
  ];

  for (const value of credentialValues) {
    expect(() => createResourceSettlementReceipt({
      ...input(),
      resourceId: value,
    })).toThrow("Resource identity is invalid");
    expect(() => createResourceSettlementReceipt(input([
      { ...owner("worker-a"), id: value },
    ]))).toThrow("Settlement owner identity is invalid");
  }

  const slugCredential = `sk-proj-${"a".repeat(24)}`;
  for (const field of ["workspace", "project"] as const) {
    expect(() => createResourceSettlementReceipt({
      ...input(),
      [field]: slugCredential,
    })).toThrow("bounded lowercase slug");
  }

  const benign = input([owner("runner-sk-review")]);
  benign.workspace = "task-sk-review";
  benign.project = "project-sk-review";
  benign.resourceId = "runner-sk-review";
  benign.resourceKind = "task-sk-review";
  benign.operationRef = "stop:sk-review";
  benign.policyVersion = "policy-sk-review";
  const receipt = createResourceSettlementReceipt(benign);
  expect(receipt.workspace).toBe("task-sk-review");
  expect(receipt.owners[0]?.id).toBe("runner-sk-review");
});
