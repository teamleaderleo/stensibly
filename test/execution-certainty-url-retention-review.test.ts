import { describe, expect, test } from "bun:test";
import {
  createExecutionCertaintyReceipt,
  type ExecutionCertaintyInput,
} from "../src/execution-certainty.js";

function hash(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

function baseInput(
  overrides: Partial<ExecutionCertaintyInput> = {},
): ExecutionCertaintyInput {
  return {
    workspace: "default",
    project: "certainty-url-review",
    executionPath: "provider_adapter",
    operation: "github.issue.update",
    operationKind: "mutation",
    operationRef: "operation-certainty-url-review",
    requestFingerprint: hash("a"),
    authorityFingerprint: hash("b"),
    runGeneration: 2,
    observedAt: "2026-08-01T08:00:00.000Z",
    evidence: {
      dispatchState: "not_started",
      cancellationState: "not_requested",
      remoteResult: null,
      localFailureClass: "policy_denied",
    },
    ...overrides,
  };
}

describe("execution certainty URL retention boundary", () => {
  test("rejects URL-shaped operation names and references", () => {
    for (const field of ["operation", "operationRef"] as const) {
      for (const value of [
        "https://github.com/teamleaderleo/stensibly/issues/1",
        "file://provider/results/receipt-1",
      ]) {
        expect(() =>
          createExecutionCertaintyReceipt({
            ...baseInput(),
            [field]: value,
          })
        ).toThrow("is invalid");
      }
    }
  });

  test("rejects embedded direct URLs in retained identities", () => {
    for (const field of ["operation", "operationRef"] as const) {
      expect(() =>
        createExecutionCertaintyReceipt({
          ...baseInput(),
          [field]: "receipt:https://github.com/teamleaderleo/stensibly/issues/1",
        })
      ).toThrow("is invalid");
    }

    expect(() =>
      createExecutionCertaintyReceipt(
        baseInput({
          evidence: {
            dispatchState: "started",
            cancellationState: "not_requested",
            remoteResult: {
              outcome: "success",
              resultIdentity: "receipt:file://provider/results/receipt-1",
            },
            localFailureClass: null,
          },
        }),
      )
    ).toThrow("is invalid");
  });

  test("rejects URL-shaped remote-result identities", () => {
    for (const resultIdentity of [
      "https://provider.example/results/receipt-1",
      "file://provider/results/receipt-1",
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

  test("rejects opaque and namespace-wrapped URI schemes", () => {
    for (const value of [
      "mailto:user@example.com",
      "urn:github:issue:1",
      "tel:15551234567",
      "receipt:mailto:user@example.com",
      "receipt:urn:github:issue:1",
      "github:mailto:user@example.com",
      "provider-result:github:urn:issue:1",
    ]) {
      for (const field of ["operation", "operationRef"] as const) {
        expect(() =>
          createExecutionCertaintyReceipt({
            ...baseInput(),
            [field]: value,
          })
        ).toThrow("is invalid");
      }

      expect(() =>
        createExecutionCertaintyReceipt(
          baseInput({
            evidence: {
              dispatchState: "started",
              cancellationState: "not_requested",
              remoteResult: {
                outcome: "success",
                resultIdentity: value,
              },
              localFailureClass: null,
            },
          }),
        )
      ).toThrow("is invalid");
    }
  });

  test("preserves explicit bounded provider identities", () => {
    expect(
      createExecutionCertaintyReceipt(
        baseInput({
          operationRef: "github:workflow-run:12345",
          evidence: {
            dispatchState: "started",
            cancellationState: "not_requested",
            remoteResult: {
              outcome: "success",
              resultIdentity: "github:result:98765",
            },
            localFailureClass: null,
          },
        }),
      ),
    ).toMatchObject({
      operationRef: "github:workflow-run:12345",
      evidence: {
        remoteResult: { resultIdentity: "github:result:98765" },
      },
      certainty: {
        state: "remote_result_received",
        reconciliationRequired: "none",
        nextEvidence: "none",
      },
    });

    expect(
      createExecutionCertaintyReceipt(
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
      ).evidence.remoteResult?.resultIdentity,
    ).toBe("provider-result:github:issue:1");
  });
});
