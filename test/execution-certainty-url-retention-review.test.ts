import { describe, expect, test } from "bun:test";
import {
  createExecutionCertaintyReceipt,
  type ExecutionCertaintyInput,
} from "../src/execution-certainty.ts";

function hash(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

function baseInput(
  overrides: Partial<ExecutionCertaintyInput> = {},
): ExecutionCertaintyInput {
  return {
    workspace: "default",
    project: "certainty-review",
    executionPath: "provider_adapter",
    operation: "github.issue.update",
    operationKind: "mutation",
    operationRef: "operation-certainty-url-review",
    requestFingerprint: hash("a"),
    authorityFingerprint: hash("b"),
    runGeneration: 2,
    observedAt: "2026-08-01T09:20:00.000Z",
    evidence: {
      dispatchState: "possibly_started",
      cancellationState: "requested_delivery_unknown",
      remoteResult: null,
      localFailureClass: "timeout",
    },
    ...overrides,
  };
}

describe("execution certainty URL retention boundary", () => {
  test("rejects URL-shaped operation and operation-reference identities", () => {
    for (const field of ["operation", "operationRef"] as const) {
      expect(() =>
        createExecutionCertaintyReceipt({
          ...baseInput(),
          [field]: "https://github.com/teamleaderleo/stensibly/issues/1",
        })
      ).toThrow("is invalid");
    }
  });

  test("rejects URL-shaped remote-result identities", () => {
    expect(() =>
      createExecutionCertaintyReceipt(
        baseInput({
          evidence: {
            dispatchState: "started",
            cancellationState: "not_requested",
            remoteResult: {
              outcome: "success",
              resultIdentity: "file://provider/results/receipt-1",
            },
            localFailureClass: null,
          },
        }),
      )
    ).toThrow("is invalid");
  });

  test("continues to admit canonical provider identities", () => {
    const receipt = createExecutionCertaintyReceipt(
      baseInput({
        evidence: {
          dispatchState: "started",
          cancellationState: "not_requested",
          remoteResult: {
            outcome: "success",
            resultIdentity: "provider-result:github:issue:1",
          },
          localFailureClass: null,
        },
      }),
    );

    expect(receipt.operation).toBe("github.issue.update");
    expect(receipt.operationRef).toBe("operation-certainty-url-review");
    expect(receipt.evidence.remoteResult?.resultIdentity).toBe(
      "provider-result:github:issue:1",
    );
  });
});
