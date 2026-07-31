import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  compileSynchronizationState,
  type SynchronizationCompilerInputV1,
  type SynchronizationConflictInputV1,
} from "../src/synchronization-state.ts";

const revision = "b886ed6f95e03984df0ae1760e2b5e186f3683be";

function hash(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

function fixture(): SynchronizationCompilerInputV1 {
  return {
    schemaVersion: 1,
    policyVersion: "github-proofwake-stensibly/v1",
    evaluatedAt: "2026-08-01T00:00:00.000Z",
    subject: {
      owner: "github",
      repository: "teamleaderleo/stensibly",
      kind: "pull_request",
      id: "github:pull_request:786",
      revision,
    },
    source: {
      id: "github-observation-1",
      deliveryId: "delivery-1",
      revision,
      observedAt: "2026-07-31T23:55:00.000Z",
      freshnessUntil: "2026-08-01T00:05:00.000Z",
      status: "accepted",
    },
    evidence: {
      id: "proofwake-projection-1",
      projectionFingerprint: hash("proofwake-projection-1"),
      sourceRevision: revision,
      observedAt: "2026-07-31T23:56:00.000Z",
      freshnessUntil: "2026-08-01T00:05:00.000Z",
      status: "accepted",
    },
    operation: null,
    authority: {
      id: "authority-1",
      generation: 4,
      currentGeneration: 4,
      status: "active",
      observedAt: "2026-07-31T23:50:00.000Z",
    },
    coordination: {
      id: "coordination-receipt-1",
      inputFingerprint: hash("unrelated-coordination-input"),
      status: "accepted",
      observedAt: "2026-07-31T23:57:00.000Z",
    },
    declaredConflicts: [],
  };
}

describe("synchronization-state review boundaries", () => {
  test("does not promote an unrelated coordination input fingerprint into synchronized", () => {
    const projection = compileSynchronizationState(fixture());

    expect(projection.state).toBe("conflicted");
    expect(projection.nextAction).toBe("refresh_evidence_projection");
    expect(projection.conflicts).toContainEqual({
      type: "projection_input_changed",
      factIds: ["coordination-receipt-1"],
      sourceOwners: ["stensibly"],
    });
  });

  test("rejects custom-prototype declared-conflict arrays", () => {
    const conflicts: SynchronizationConflictInputV1[] = [];
    Object.setPrototypeOf(conflicts, Object.create(Array.prototype));

    expect(() => compileSynchronizationState({
      ...fixture(),
      declaredConflicts: conflicts,
    })).toThrow("dense and undecorated");
  });
});
