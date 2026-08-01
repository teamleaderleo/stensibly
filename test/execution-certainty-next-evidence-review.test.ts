import { expect, test } from "bun:test";
import {
  createExecutionCertaintyReceipt,
  type ExecutionCertaintyInput,
} from "../src/execution-certainty.js";

const hash = (character: string) => `sha256:${character.repeat(64)}`;

function receivedResultInput(): ExecutionCertaintyInput {
  return {
    workspace: "default",
    project: "certainty-review",
    executionPath: "provider_adapter",
    operation: "github.issue.update",
    operationKind: "mutation",
    operationRef: "operation-certainty-review",
    requestFingerprint: hash("a"),
    authorityFingerprint: hash("b"),
    runGeneration: 2,
    observedAt: "2026-08-01T06:00:00.000Z",
    evidence: {
      dispatchState: "started",
      cancellationState: "not_requested",
      remoteResult: {
        outcome: "success",
        resultIdentity: "provider-result-1",
      },
      localFailureClass: null,
    },
  };
}

test("does not request evidence that the receipt already contains", () => {
  const receipt = createExecutionCertaintyReceipt(receivedResultInput());

  expect(receipt.certainty).toMatchObject({
    state: "remote_result_received",
    remoteResultReceived: true,
    reconciliationRequired: "none",
    nextEvidence: "none",
  });
});
