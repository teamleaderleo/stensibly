import { describe, expect, test } from "bun:test";
import {
  compileSynchronizationState,
  type SynchronizationCompilerInputV1,
} from "../src/synchronization-state.ts";

const revision = "a".repeat(40);
const fingerprint = `sha256:${"b".repeat(64)}`;

function input(
  overrides: Partial<SynchronizationCompilerInputV1> = {},
): SynchronizationCompilerInputV1 {
  return {
    schemaVersion: 1,
    policyVersion: "github-proofwake-stensibly/v1",
    evaluatedAt: "2026-08-08T00:10:00.000Z",
    subject: {
      owner: "github",
      repository: "teamleaderleo/stensibly",
      kind: "pull_request",
      id: "github:pull_request:1183",
      revision,
    },
    source: {
      id: "github-observation-1183",
      deliveryId: "delivery-1183",
      revision,
      observedAt: "2026-08-08T00:01:00.000Z",
      freshnessUntil: "2026-08-08T00:20:00.000Z",
      status: "accepted",
    },
    evidence: {
      id: "proofwake-projection-1183",
      projectionFingerprint: fingerprint,
      sourceRevision: revision,
      observedAt: "2026-08-08T00:02:00.000Z",
      freshnessUntil: "2026-08-08T00:20:00.000Z",
      status: "accepted",
    },
    operation: null,
    authority: {
      id: "authority-1183",
      generation: 1,
      currentGeneration: 1,
      status: "active",
      observedAt: "2026-08-08T00:00:30.000Z",
    },
    coordination: null,
    declaredConflicts: [],
    ...overrides,
  };
}

describe("synchronization shared retained credential policy", () => {
  test("rejects realistic Stensibly synchronization identities at the shared 12-character threshold", () => {
    const serviceIdentity = `stn.svc_${"a".repeat(12)}`;
    const tokenIdentity = `stn.tok_${"b".repeat(12)}`;

    expect(() => compileSynchronizationState(input({
      policyVersion: serviceIdentity,
    }))).toThrow("Synchronization policy version must not contain a credential value or reference");

    expect(() => compileSynchronizationState(input({
      source: { ...input().source!, id: tokenIdentity },
    }))).toThrow("GitHub source fact ID must not contain a credential value or reference");

    expect(() => compileSynchronizationState(input({
      evidence: { ...input().evidence!, id: serviceIdentity },
    }))).toThrow("ProofWake evidence fact ID must not contain a credential value or reference");
  });

  test("rejects realistic Stensibly revision text through the same safeText boundary", () => {
    const credentialRevision = `stn.tok_${"c".repeat(12)}`;
    const base = input();

    expect(() => compileSynchronizationState(input({
      subject: { ...base.subject, revision: credentialRevision },
      source: { ...base.source!, revision: credentialRevision },
      evidence: { ...base.evidence!, sourceRevision: credentialRevision },
    }))).toThrow("Synchronization subject revision must not contain a credential value or reference");
  });

  test("retains benign Stensibly-like aliases below the shared threshold", () => {
    const benign = `stn.tok_${"a".repeat(11)}`;
    const projection = compileSynchronizationState(input({
      policyVersion: benign,
      source: { ...input().source!, id: benign },
      evidence: { ...input().evidence!, id: benign },
    }));

    expect(projection.policyVersion).toBe(benign);
    expect(projection.facts.sourceObservationId).toBe(benign);
    expect(projection.facts.evidenceProjectionId).toBe(benign);
    expect(projection.inputFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(projection.projectionFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });
});
