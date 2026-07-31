import { expect, test } from "bun:test";
import {
  createResourceSettlementReceipt,
  type ResourceSettlementInput,
  type ResourceSettlementOwnerInput,
} from "../src/resource-settlement.js";

const at = (second: number): string =>
  `2026-07-30T00:00:${String(second).padStart(2, "0")}.000Z`;

function owner(id = "worker-a"): ResourceSettlementOwnerInput {
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

function input(): ResourceSettlementInput {
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
    owners: [owner()],
  };
}

test("rejects credential-shaped retained settlement identifiers", () => {
  const cases: ResourceSettlementInput[] = [
    { ...input(), workspace: `github_pat_${"a".repeat(40)}` },
    { ...input(), project: `stn_tok_${"a".repeat(40)}` },
    { ...input(), resourceId: `ghp_${"a".repeat(36)}` },
    { ...input(), resourceKind: `sk-proj-${"a".repeat(32)}` },
    { ...input(), operationRef: "secret://github/app-private-key" },
    { ...input(), policyVersion: `xoxb-${"a".repeat(40)}` },
    { ...input(), owners: [owner(`github_pat_${"a".repeat(40)}`)] },
  ];

  for (const candidate of cases) {
    expect(() => createResourceSettlementReceipt(candidate)).toThrow();
  }
});

test("preserves benign sk-like settlement identifiers", () => {
  const receipt = createResourceSettlementReceipt({
    ...input(),
    resourceId: "runner-sk-review",
    operationRef: "task-sk-review",
    policyVersion: "policy-v1",
    owners: [owner("sk-checks-bot")],
  });

  expect(receipt.resourceId).toBe("runner-sk-review");
  expect(receipt.operationRef).toBe("task-sk-review");
  expect(receipt.owners[0]?.id).toBe("sk-checks-bot");
});
