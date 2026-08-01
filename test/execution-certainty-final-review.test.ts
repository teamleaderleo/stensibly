import { describe, expect, test } from "bun:test";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";
import {
  createExecutionCertaintyReceipt,
  parseExecutionCertaintyReceipt,
  parseExecutionReconciliationRecord,
  reconcileExecutionCertainty,
} from "../src/execution-certainty.ts";

function hash(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

function uncertainReceipt() {
  return createExecutionCertaintyReceipt({
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
      dispatchState: "possibly_started",
      cancellationState: "requested_delivery_unknown",
      remoteResult: null,
      localFailureClass: "timeout",
    },
  });
}

function certainReceipt() {
  return createExecutionCertaintyReceipt({
    workspace: "default",
    project: "certainty-review",
    executionPath: "provider_adapter",
    operation: "github.issue.update",
    operationKind: "mutation",
    operationRef: "operation-certainty-certain",
    requestFingerprint: hash("d"),
    authorityFingerprint: hash("e"),
    runGeneration: 3,
    observedAt: "2026-08-01T06:00:00.000Z",
    evidence: {
      dispatchState: "not_started",
      cancellationState: "not_requested",
      remoteResult: null,
      localFailureClass: "policy_denied",
    },
  });
}

describe("execution certainty final review controls", () => {
  test("receipt-bound parsing rejects reconciliation for certain receipts", () => {
    const receipt = certainReceipt();
    const unsigned = {
      schemaVersion: 1 as const,
      originalReceiptFingerprint: receipt.receiptFingerprint,
      operationRef: receipt.operationRef,
      requestFingerprint: receipt.requestFingerprint,
      authorityFingerprint: receipt.authorityFingerprint,
      runGeneration: receipt.runGeneration,
      resolvedAt: "2026-08-01T06:01:00.000Z",
      source: "provider_state" as const,
      outcome: "effect_recorded" as const,
      evidenceFingerprint: hash("f"),
      resolution: {
        effect: "effect_recorded" as const,
        status: "resolved" as const,
        replayAuthorization: "not_authorized" as const,
        nextEvidence: "none" as const,
      },
    };
    const record = {
      ...unsigned,
      reconciliationFingerprint: fingerprintCanonicalRequest(unsigned),
    };

    expect(() => parseExecutionReconciliationRecord(record, receipt)).toThrow(
      "does not require reconciliation",
    );
  });

  test("rejects unsupported receipt and reconciliation schema versions", () => {
    const receipt = uncertainReceipt();
    const receiptVersion = JSON.parse(JSON.stringify(receipt)) as Record<string, unknown>;
    receiptVersion.schemaVersion = 2;
    expect(() => parseExecutionCertaintyReceipt(receiptVersion)).toThrow(
      "receipt schema version is unsupported",
    );

    const record = reconcileExecutionCertainty(receipt, {
      resolvedAt: "2026-08-01T06:01:00.000Z",
      source: "provider_state",
      outcome: "effect_recorded",
      evidenceFingerprint: hash("c"),
    });
    const recordVersion = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    recordVersion.schemaVersion = 2;
    expect(() => parseExecutionReconciliationRecord(recordVersion)).toThrow(
      "record schema version is unsupported",
    );
  });
});
