import { describe, expect, test } from "bun:test";
import { stableJson } from "../src/canonical-json.ts";
import {
  admitOrchestratorActivityIngestionReceipt,
  compileOrchestratorActivityIngestionCandidate,
} from "../src/orchestrator-activity-ingestion-candidate.ts";
import { InMemoryOrchestratorActivityIngestionStore } from "../src/orchestrator-activity-ingestion.ts";

function input() {
  return {
    deliveryId: "delivery_candidate_1",
    deliveryFingerprint: `sha256:${"a".repeat(64)}`,
    acceptedAt: "2026-08-16T06:30:01.000Z",
    observation: {
      workspace: "default",
      project: "stensibly",
      actorId: "actor_candidate",
      sourceClass: "ledger_event",
      sourceId: "event_candidate_1",
      sourceFingerprint: `sha256:${"b".repeat(64)}`,
      observedAt: "2026-08-16T06:30:00.000Z",
      activityClass: "progress_evidence",
      activityState: "in_progress",
    },
  };
}

describe("shared orchestrator activity ingestion candidate", () => {
  test("matches the in-memory reference receipt and observation bytes", () => {
    const candidate = compileOrchestratorActivityIngestionCandidate(input());
    const reference = new InMemoryOrchestratorActivityIngestionStore().ingest(input());
    expect(stableJson(reference.receipt)).toBe(stableJson(candidate.receipt));
    expect(stableJson(reference.observation)).toBe(stableJson(candidate.observation));
    expect(reference.receipt.requestFingerprint).toBe(candidate.requestFingerprint);
  });

  test("re-admits an exact receipt and rejects request or receipt ID drift", () => {
    const candidate = compileOrchestratorActivityIngestionCandidate(input());
    expect(admitOrchestratorActivityIngestionReceipt(candidate.receipt)).toEqual(candidate.receipt);
    expect(() => admitOrchestratorActivityIngestionReceipt({
      ...candidate.receipt,
      requestFingerprint: `sha256:${"c".repeat(64)}`,
    })).toThrow("request fingerprint is inconsistent");
    expect(() => admitOrchestratorActivityIngestionReceipt({
      ...candidate.receipt,
      receiptId: "oair_00000000000000000000000000000000",
    })).toThrow("receipt ID is inconsistent");
  });

  test("does not invoke accessors while admitting a durable receipt", () => {
    const candidate = compileOrchestratorActivityIngestionCandidate(input());
    let getterCalls = 0;
    const hostile = Object.create(null);
    for (const [key, value] of Object.entries(candidate.receipt)) {
      Object.defineProperty(hostile, key, {
        enumerable: true,
        configurable: true,
        ...(key === "sourceId"
          ? {
              get() {
                getterCalls += 1;
                return value;
              },
            }
          : { value, writable: true }),
      });
    }
    expect(() => admitOrchestratorActivityIngestionReceipt(hostile))
      .toThrow("receipt field sourceId is invalid");
    expect(getterCalls).toBe(0);
  });
});
