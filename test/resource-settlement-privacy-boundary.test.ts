import { expect, test } from "bun:test";
import {
  createResourceSettlementReceipt,
  type ResourceSettlementInput,
} from "../src/resource-settlement.js";

const credentialShapedOwnerId = `github_pat_${"a".repeat(40)}`;

test("rejects credential-shaped retained settlement identifiers", () => {
  const input: ResourceSettlementInput = {
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
    openedAt: "2026-07-30T00:00:00.000Z",
    closingStartedAt: "2026-07-30T00:00:01.000Z",
    terminalAt: "2026-07-30T00:00:05.000Z",
    observedAt: "2026-07-30T00:00:09.000Z",
    owners: [{
      id: credentialShapedOwnerId,
      kind: "worker",
      generation: 1,
      attempted: true,
      state: "settled_success",
      attemptedAt: "2026-07-30T00:00:02.000Z",
      settledAt: "2026-07-30T00:00:03.000Z",
      failureClass: null,
      reconciliationRequired: false,
      canPublishLate: false,
      outputFingerprint: null,
      publicationFenceFingerprint: null,
    }],
  };

  expect(() => createResourceSettlementReceipt(input)).toThrow(/credential|secret|token/i);
});
