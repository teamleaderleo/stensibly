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
    operationRef: "operation-certainty-opaque-uri-review",
    requestFingerprint: hash("a"),
    authorityFingerprint: hash("b"),
    runGeneration: 2,
    observedAt: "2026-08-01T10:00:00.000Z",
    evidence: {
      dispatchState: "possibly_started",
      cancellationState: "requested_delivery_unknown",
      remoteResult: null,
      localFailureClass: "timeout",
    },
    ...overrides,
  };
}

describe("execution certainty opaque URI retention boundary", () => {
  test("rejects opaque URI schemes in operation and operation reference", () => {
    for (const candidate of [
      "mailto:user@example.com",
      "urn:github:issue:1",
      "tel:15551234567",
    ]) {
      for (const field of ["operation", "operationRef"] as const) {
        expect(() =>
          createExecutionCertaintyReceipt({
            ...baseInput(),
            [field]: candidate,
          })
        ).toThrow("is invalid");
      }
    }
  });

  test("rejects opaque URI schemes in remote result identity", () => {
    for (const resultIdentity of [
      "mailto:user@example.com",
      "urn:github:issue:1",
      "tel:15551234567",
    ]) {
      expect(() =>
        createExecutionCertaintyReceipt(
          baseInput({
            evidence: {
              dispatchState: "started",
              cancellationState: "not_requested",
              remoteResult: {
                outcome: "success",
                resultIdentity,
              },
              localFailureClass: null,
            },
          }),
        )
      ).toThrow("is invalid");
    }
  });

  test("preserves the explicit provider-result namespace", () => {
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

    expect(receipt.evidence.remoteResult?.resultIdentity).toBe(
      "provider-result:github:issue:1",
    );
  });
});
