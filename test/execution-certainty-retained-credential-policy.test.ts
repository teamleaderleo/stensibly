import { describe, expect, test } from "bun:test";
import {
  createExecutionCertaintyReceipt,
  type ExecutionCertaintyInput,
} from "../src/execution-certainty.ts";

const fingerprint = `sha256:${"a".repeat(64)}`;

function baseInput(
  overrides: Partial<ExecutionCertaintyInput> = {},
): ExecutionCertaintyInput {
  return {
    workspace: "default",
    project: "certainty-review",
    executionPath: "provider_adapter",
    operation: "github.issue.update",
    operationKind: "mutation",
    operationRef: "operation-certainty-review",
    requestFingerprint: fingerprint,
    authorityFingerprint: `sha256:${"b".repeat(64)}`,
    runGeneration: 1,
    observedAt: "2026-08-07T00:00:00.000Z",
    evidence: {
      dispatchState: "possibly_started",
      cancellationState: "requested_delivery_unknown",
      remoteResult: null,
      localFailureClass: "timeout",
    },
    ...overrides,
  };
}

describe("execution certainty shared retained credential policy", () => {
  test("rejects shared-policy Stensibly identities at the realistic threshold", () => {
    const serviceIdentity = `stn.svc_${"a".repeat(12)}`;
    const tokenIdentity = `stn.tok_${"b".repeat(12)}`;

    expect(() => createExecutionCertaintyReceipt(baseInput({
      operation: serviceIdentity,
    }))).toThrow("Execution operation is invalid");

    expect(() => createExecutionCertaintyReceipt(baseInput({
      operationRef: tokenIdentity,
    }))).toThrow("Execution operation reference is invalid");

    expect(() => createExecutionCertaintyReceipt(baseInput({
      evidence: {
        dispatchState: "started",
        cancellationState: "not_requested",
        remoteResult: {
          outcome: "success",
          resultIdentity: `result-${serviceIdentity}`,
        },
        localFailureClass: null,
      },
    }))).toThrow("Execution remote result identity is invalid");
  });

  test("retains benign Stensibly-like aliases below the shared threshold", () => {
    const benign = `stn.tok_${"a".repeat(11)}`;
    expect(createExecutionCertaintyReceipt(baseInput({
      operationRef: benign,
    })).operationRef).toBe(benign);
  });
});
