import { describe, expect, test } from "bun:test";
import {
  createResourceSettlementReceipt,
  type ResourceSettlementInput,
  type ResourceSettlementOwnerInput,
} from "../src/resource-settlement.ts";

const at = (second: number): string =>
  `2026-08-08T00:00:${String(second).padStart(2, "0")}.000Z`;

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

describe("resource settlement shared retained credential policy", () => {
  test("rejects realistic Stensibly identities at the shared 12-character threshold", () => {
    const serviceIdentity = `stn.svc_${"a".repeat(12)}`;
    const tokenIdentity = `stn.tok_${"b".repeat(12)}`;

    expect(() => createResourceSettlementReceipt({
      ...input(),
      resourceId: serviceIdentity,
    })).toThrow("Resource identity is invalid");

    expect(() => createResourceSettlementReceipt({
      ...input(),
      operationRef: tokenIdentity,
    })).toThrow("Settlement operation reference is invalid");

    expect(() => createResourceSettlementReceipt({
      ...input(),
      owners: [owner(serviceIdentity)],
    })).toThrow("Settlement owner identity is invalid");
  });

  test("retains benign Stensibly-like aliases below the shared threshold", () => {
    const benign = `stn.tok_${"a".repeat(11)}`;
    const receipt = createResourceSettlementReceipt({
      ...input(),
      resourceId: benign,
      operationRef: benign,
      owners: [owner(benign)],
    });

    expect(receipt.resourceId).toBe(benign);
    expect(receipt.operationRef).toBe(benign);
    expect(receipt.owners[0]?.id).toBe(benign);
  });
});
