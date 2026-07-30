import { describe, expect, test } from "bun:test";
import {
  createExecutionCertaintyReceipt,
  parseExecutionCertaintyReceipt,
  parseExecutionReconciliationRecord,
  reconcileExecutionCertainty,
  type ExecutionCertaintyInput,
} from "../src/execution-certainty.ts";

const observedAt = "2026-07-30T12:00:00.000Z";

function hash(seed: number): string {
  return `sha256:${(seed % 16).toString(16).repeat(64)}`;
}

function input(overrides: Partial<ExecutionCertaintyInput> = {}): ExecutionCertaintyInput {
  return {
    workspace: "default",
    project: "oauth-dogfood",
    executionPath: "direct_mcp",
    operation: "github.issue.create",
    operationKind: "mutation",
    operationRef: "op_github_issue_create_1",
    requestFingerprint: hash(1),
    authorityFingerprint: hash(2),
    runGeneration: 3,
    observedAt,
    evidence: {
      dispatchState: "possibly_started",
      cancellationState: "not_requested",
      remoteResult: null,
      localFailureClass: "transport_failure",
    },
    ...overrides,
  };
}

describe("execution certainty", () => {
  test("classifies known pre-dispatch rejection without implying a remote effect", () => {
    const receipt = createExecutionCertaintyReceipt(input({
      evidence: {
        dispatchState: "not_started",
        cancellationState: "not_requested",
        remoteResult: null,
        localFailureClass: "policy_denied",
      },
    }));
    expect(receipt.certainty).toEqual({
      state: "not_dispatched",
      effectCertainty: "not_executed_by_this_call_path",
      remoteResultReceived: false,
      reconciliationRequired: "none",
      replayAuthorization: "not_authorized",
      nextEvidence: "none",
    });
  });

  test("treats remote success and application error as received remote results", () => {
    for (const outcome of ["success", "application_error"] as const) {
      const receipt = createExecutionCertaintyReceipt(input({
        evidence: {
          dispatchState: "started",
          cancellationState: "not_requested",
          remoteResult: { outcome, resultIdentity: `github:request:${outcome}` },
          localFailureClass: null,
        },
      }));
      expect(receipt.certainty).toEqual({
        state: "remote_result_received",
        effectCertainty: "remote_response_received",
        remoteResultReceived: true,
        reconciliationRequired: "none",
        replayAuthorization: "not_authorized",
        nextEvidence: "remote_result",
      });
      expect(receipt.evidence.remoteResult?.outcome).toBe(outcome);
    }
  });

  test("keeps mutation timeout outcome unknown and reconciliation-first", () => {
    const receipt = createExecutionCertaintyReceipt(input({
      evidence: {
        dispatchState: "possibly_started",
        cancellationState: "requested_delivery_unknown",
        remoteResult: null,
        localFailureClass: "timeout",
      },
    }));
    expect(receipt.certainty).toEqual({
      state: "local_timeout_outcome_unknown",
      effectCertainty: "may_still_run_or_may_have_committed",
      remoteResultReceived: false,
      reconciliationRequired: "operation_receipt_or_provider_state",
      replayAuthorization: "not_authorized",
      nextEvidence: "operation_receipt_or_provider_state",
    });
  });

  test("does not treat cancellation delivery as proof of non-execution", () => {
    for (const cancellationState of ["delivered", "observed_by_remote"] as const) {
      const receipt = createExecutionCertaintyReceipt(input({
        evidence: {
          dispatchState: "started",
          cancellationState,
          remoteResult: null,
          localFailureClass: "timeout",
        },
      }));
      expect(receipt.certainty.state).toBe("local_timeout_outcome_unknown");
      expect(receipt.certainty.effectCertainty).toBe("may_still_run_or_may_have_committed");
      expect(receipt.certainty.replayAuthorization).toBe("not_authorized");
    }
  });

  test("classifies non-timeout post-dispatch failure without inventing settlement", () => {
    const receipt = createExecutionCertaintyReceipt(input({
      evidence: {
        dispatchState: "started",
        cancellationState: "not_requested",
        remoteResult: null,
        localFailureClass: "result_serialization_failed",
      },
    }));
    expect(receipt.certainty).toMatchObject({
      state: "local_failure_unclassified",
      effectCertainty: "unknown",
      reconciliationRequired: "operation_receipt_or_provider_state",
      replayAuthorization: "not_authorized",
    });
  });

  test("does not require mutation reconciliation for a declared read-only path", () => {
    const receipt = createExecutionCertaintyReceipt(input({
      operation: "github.issue.get",
      operationKind: "read",
      evidence: {
        dispatchState: "possibly_started",
        cancellationState: "not_requested",
        remoteResult: null,
        localFailureClass: "transport_failure",
      },
    }));
    expect(receipt.certainty).toMatchObject({
      state: "local_failure_unclassified",
      reconciliationRequired: "none",
      replayAuthorization: "not_authorized",
      nextEvidence: "none",
    });
  });

  test("derives the same certainty semantics across direct, hosted, and runner paths", () => {
    const certainties = ["direct_mcp", "hosted_mcp", "runner_adapter", "provider_adapter"]
      .map((executionPath) => createExecutionCertaintyReceipt(input({
        executionPath: executionPath as ExecutionCertaintyInput["executionPath"],
        evidence: {
          dispatchState: "possibly_started",
          cancellationState: "requested_delivery_unknown",
          remoteResult: null,
          localFailureClass: "timeout",
        },
      })).certainty);
    expect(certainties).toEqual([certainties[0], certainties[0], certainties[0], certainties[0]]);
  });

  test("rejects contradictory dispatch, result, failure, and cancellation evidence", () => {
    expect(() => createExecutionCertaintyReceipt(input({
      evidence: {
        dispatchState: "possibly_started",
        cancellationState: "not_requested",
        remoteResult: { outcome: "success", resultIdentity: null },
        localFailureClass: null,
      },
    }))).toThrow("received remote result requires started dispatch");

    expect(() => createExecutionCertaintyReceipt(input({
      evidence: {
        dispatchState: "started",
        cancellationState: "not_requested",
        remoteResult: { outcome: "success", resultIdentity: null },
        localFailureClass: "transport_failure",
      },
    }))).toThrow("cannot carry a local failure class");

    expect(() => createExecutionCertaintyReceipt(input({
      evidence: {
        dispatchState: "not_started",
        cancellationState: "not_requested",
        remoteResult: null,
        localFailureClass: "timeout",
      },
    }))).toThrow("cannot report a tools-call timeout");

    expect(() => createExecutionCertaintyReceipt(input({
      evidence: {
        dispatchState: "not_started",
        cancellationState: "delivered",
        remoteResult: null,
        localFailureClass: "policy_denied",
      },
    }))).toThrow("cannot report remote cancellation delivery");

    expect(() => createExecutionCertaintyReceipt(input({
      evidence: {
        dispatchState: "started",
        cancellationState: "not_requested",
        remoteResult: null,
        localFailureClass: "policy_denied",
      },
    }))).toThrow("known pre-dispatch failure cannot follow dispatch");
  });

  test("fails closed on unknown fields and malformed canonical identities", () => {
    expect(() => createExecutionCertaintyReceipt({ ...input(), arguments: { secret: true } }))
      .toThrow("unknown field arguments");
    expect(() => createExecutionCertaintyReceipt({
      ...input(),
      evidence: { ...input().evidence, errorMessage: "raw provider error" },
    })).toThrow("unknown field errorMessage");
    expect(() => createExecutionCertaintyReceipt({ ...input(), requestFingerprint: "not-a-hash" }))
      .toThrow("SHA-256 identifier");
    expect(() => createExecutionCertaintyReceipt({ ...input(), observedAt: "July 30, 2026" }))
      .toThrow("canonical UTC timestamp");
    expect(() => createExecutionCertaintyReceipt({ ...input(), observedAt: "2026-02-30T12:00:00Z" }))
      .toThrow("canonical UTC timestamp");
  });

  test("detects certainty and fingerprint tampering", () => {
    const receipt = createExecutionCertaintyReceipt(input());
    expect(parseExecutionCertaintyReceipt(receipt)).toEqual(receipt);
    expect(() => parseExecutionCertaintyReceipt({
      ...receipt,
      certainty: { ...receipt.certainty, state: "not_dispatched" },
    })).toThrow("projection does not match");
    expect(() => parseExecutionCertaintyReceipt({
      ...receipt,
      receiptFingerprint: hash(15),
    })).toThrow("fingerprint does not match");
  });

  test("produces stable bounded fingerprints without retaining payloads", () => {
    const first = createExecutionCertaintyReceipt(input());
    const second = createExecutionCertaintyReceipt(input());
    expect(first.receiptFingerprint).toBe(second.receiptFingerprint);
    expect(first.receiptFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    const serialized = JSON.stringify(first);
    for (const forbidden of [
      "authorization",
      "credential",
      "requestBody",
      "responseBody",
      "arguments",
      "errorMessage",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("reconciles a recorded effect without replaying the original mutation", () => {
    const receipt = createExecutionCertaintyReceipt(input({
      evidence: {
        dispatchState: "possibly_started",
        cancellationState: "requested_delivery_unknown",
        remoteResult: null,
        localFailureClass: "timeout",
      },
    }));
    const resolution = reconcileExecutionCertainty(receipt, {
      resolvedAt: "2026-07-30T12:01:00.000Z",
      source: "operation_receipt",
      outcome: "effect_recorded",
      evidenceFingerprint: hash(8),
    });
    expect(resolution.resolution).toEqual({
      effect: "effect_recorded",
      status: "resolved",
      replayAuthorization: "not_authorized",
      nextEvidence: "none",
    });
    expect(resolution.originalReceiptFingerprint).toBe(receipt.receiptFingerprint);
    expect(parseExecutionReconciliationRecord(resolution)).toEqual(resolution);
  });

  test("keeps incomplete reconciliation explicitly unresolved", () => {
    const receipt = createExecutionCertaintyReceipt(input());
    const resolution = reconcileExecutionCertainty(receipt, {
      resolvedAt: "2026-07-30T12:01:00.000Z",
      source: "provider_state",
      outcome: "still_unknown",
      evidenceFingerprint: hash(9),
    });
    expect(resolution.resolution).toEqual({
      effect: "unknown",
      status: "required",
      replayAuthorization: "not_authorized",
      nextEvidence: "continue_reconciliation",
    });
  });

  test("requires coherent reconciliation source, ordering, and necessity", () => {
    const ambiguous = createExecutionCertaintyReceipt(input());
    expect(() => reconcileExecutionCertainty(ambiguous, {
      resolvedAt: "2026-07-30T11:59:59.000Z",
      source: "provider_state",
      outcome: "effect_recorded",
      evidenceFingerprint: hash(10),
    })).toThrow("cannot precede");
    expect(() => reconcileExecutionCertainty(ambiguous, {
      resolvedAt: "2026-07-30T12:01:00.000Z",
      source: "provider_state",
      outcome: "remote_result_recovered",
      evidenceFingerprint: hash(10),
    })).toThrow("require remote-result evidence");

    const settled = createExecutionCertaintyReceipt(input({
      evidence: {
        dispatchState: "started",
        cancellationState: "not_requested",
        remoteResult: { outcome: "success", resultIdentity: "provider-result-1" },
        localFailureClass: null,
      },
    }));
    expect(() => reconcileExecutionCertainty(settled, {
      resolvedAt: "2026-07-30T12:01:00.000Z",
      source: "provider_state",
      outcome: "effect_recorded",
      evidenceFingerprint: hash(10),
    })).toThrow("does not require reconciliation");
  });
});
