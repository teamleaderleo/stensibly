import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  compileSynchronizationState,
  fingerprintSynchronizationCoordinationInput,
  synchronizationCompilerRevision,
  type SynchronizationCompilerInputV1,
  type SynchronizationConflictInputV1,
} from "../src/synchronization-state.ts";

const evaluatedAt = "2026-08-01T00:00:00.000Z";

function hash(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

function fixture(
  overrides: Partial<SynchronizationCompilerInputV1> = {},
  options: Readonly<{ coordinationInputFingerprint?: string }> = {},
): SynchronizationCompilerInputV1 {
  const { coordination: coordinationOverride, ...rest } = overrides;
  const withoutCoordination: SynchronizationCompilerInputV1 = {
    schemaVersion: 1,
    policyVersion: "github-proofwake-stensibly/v1",
    evaluatedAt,
    subject: {
      owner: "github",
      repository: "teamleaderleo/stensibly",
      kind: "pull_request",
      id: "github:pull_request:786",
      revision: "b886ed6f95e03984df0ae1760e2b5e186f3683be",
    },
    source: {
      id: "github-observation-1",
      deliveryId: "delivery-1",
      revision: "b886ed6f95e03984df0ae1760e2b5e186f3683be",
      observedAt: "2026-07-31T23:55:00.000Z",
      freshnessUntil: "2026-08-01T00:05:00.000Z",
      status: "accepted",
    },
    evidence: {
      id: "proofwake-projection-1",
      projectionFingerprint: hash("proofwake-projection-1"),
      sourceRevision: "b886ed6f95e03984df0ae1760e2b5e186f3683be",
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
    coordination: null,
    declaredConflicts: [],
    ...rest,
  };
  if (coordinationOverride === null) return withoutCoordination;
  const coordination = coordinationOverride ?? {
    id: "coordination-receipt-1",
    inputFingerprint: hash("placeholder"),
    status: "accepted" as const,
    observedAt: "2026-07-31T23:57:00.000Z",
  };
  return {
    ...withoutCoordination,
    coordination: {
      ...coordination,
      inputFingerprint: options.coordinationInputFingerprint
        ?? fingerprintSynchronizationCoordinationInput(withoutCoordination),
    },
  };
}

function conflict(
  type: SynchronizationConflictInputV1["type"],
  factIds: string[],
  sourceOwners: SynchronizationConflictInputV1["sourceOwners"],
): SynchronizationConflictInputV1 {
  return { type, factIds, sourceOwners };
}

describe("compileSynchronizationState", () => {
  test("emits one frozen synchronized projection from complete current facts", () => {
    const projection = compileSynchronizationState(fixture());

    expect(projection.schemaVersion).toBe(1);
    expect(projection.compilerRevision).toBe(synchronizationCompilerRevision);
    expect(projection.state).toBe("synchronized");
    expect(projection.conflicts).toEqual([]);
    expect(projection.nextAction).toBe("none");
    expect(projection.authorizesMutation).toBe(false);
    expect(projection.authorizesAuthority).toBe(false);
    expect(projection.inputFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(projection.projectionFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(projection.facts).toEqual({
      sourceObservationId: "github-observation-1",
      evidenceProjectionId: "proofwake-projection-1",
      operationId: null,
      authorityId: "authority-1",
      authorityGeneration: 4,
      coordinationReceiptId: "coordination-receipt-1",
    });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.subject)).toBe(true);
    expect(Object.isFrozen(projection.conflicts)).toBe(true);
    expect(Object.isFrozen(projection.facts)).toBe(true);
  });

  test("normalizes declared conflict ordering into one deterministic fingerprint", () => {
    const a = conflict(
      "competing_producer",
      ["producer-b", "producer-a"],
      ["stensibly"],
    );
    const b = conflict(
      "delivery_identity_conflict",
      ["delivery-1", "observation-1"],
      ["github"],
    );

    const left = compileSynchronizationState(fixture({ declaredConflicts: [a, b] }));
    const right = compileSynchronizationState(fixture({
      declaredConflicts: [
        { ...b, factIds: [...b.factIds].reverse() },
        { ...a, factIds: [...a.factIds].reverse() },
      ],
    }));

    expect(left.state).toBe("conflicted");
    expect(left.nextAction).toBe("inspect_delivery_conflict");
    expect(left.conflicts.map((entry) => entry.type)).toEqual([
      "delivery_identity_conflict",
      "competing_producer",
    ]);
    expect(left.inputFingerprint).toBe(right.inputFingerprint);
    expect(left.projectionFingerprint).toBe(right.projectionFingerprint);
  });

  test("emits pending_outbound while an exact operation is reserved or dispatched", () => {
    for (const state of ["reserved", "dispatched"] as const) {
      const projection = compileSynchronizationState(fixture({
        operation: {
          id: `operation-${state}`,
          state,
          targetRevision: "b886ed6f95e03984df0ae1760e2b5e186f3683be",
          providerRevision: null,
          observedAt: "2026-07-31T23:58:00.000Z",
        },
      }));
      expect(projection.state).toBe("pending_outbound");
      expect(projection.nextAction).toBe("await_provider_result");
      expect(projection.conflicts).toEqual([]);
    }
  });

  test("emits pending_reconciliation for an ambiguous outbound operation", () => {
    const projection = compileSynchronizationState(fixture({
      operation: {
        id: "operation-ambiguous",
        state: "pending_reconciliation",
        targetRevision: "b886ed6f95e03984df0ae1760e2b5e186f3683be",
        providerRevision: null,
        observedAt: "2026-07-31T23:58:00.000Z",
      },
    }));

    expect(projection.state).toBe("pending_reconciliation");
    expect(projection.nextAction).toBe("reconcile_outbound_operation");
    expect(projection.conflicts).toEqual([
      {
        type: "ambiguous_outbound_operation",
        factIds: ["operation-ambiguous"],
        sourceOwners: ["github", "stensibly"],
      },
    ]);
  });

  test("emits stale when accepted source evidence is outside its freshness window", () => {
    const projection = compileSynchronizationState(fixture({
      source: {
        ...fixture().source!,
        freshnessUntil: "2026-07-31T23:59:59.000Z",
      },
    }));

    expect(projection.state).toBe("stale");
    expect(projection.nextAction).toBe("refresh_source_observation");
    expect(projection.conflicts[0]).toEqual({
      type: "stale_source_observation",
      factIds: ["github-observation-1"],
      sourceOwners: ["github"],
    });
  });

  test("emits degraded for missing source coverage without inventing source truth", () => {
    const projection = compileSynchronizationState(fixture({ evidence: null }));

    expect(projection.state).toBe("degraded");
    expect(projection.nextAction).toBe("restore_source_coverage");
    expect(projection.conflicts).toContainEqual({
      type: "missing_source_coverage",
      factIds: ["github:pull_request:786"],
      sourceOwners: ["proofwake"],
    });
  });

  test("emits unknown when no accepted current facts exist", () => {
    const projection = compileSynchronizationState(fixture({
      source: null,
      evidence: null,
      operation: null,
      authority: null,
      coordination: null,
    }));

    expect(projection.state).toBe("unknown");
    expect(projection.conflicts).toEqual([]);
    expect(projection.nextAction).toBe("collect_missing_facts");
  });

  test("classifies source revision divergence before stale or missing states", () => {
    const projection = compileSynchronizationState(fixture({
      source: {
        ...fixture().source!,
        revision: "f5e5c0aa64c0b9df29e0a3c08f53469ab5f2dd0e",
      },
    }));

    expect(projection.state).toBe("conflicted");
    expect(projection.nextAction).toBe("refresh_source_observation");
    expect(projection.conflicts).toContainEqual({
      type: "source_revision_divergence",
      factIds: ["github-observation-1", "github:pull_request:786"],
      sourceOwners: ["github"],
    });
  });

  test("classifies provider readback mismatch", () => {
    const projection = compileSynchronizationState(fixture({
      operation: {
        id: "operation-mismatch",
        state: "verified",
        targetRevision: "b886ed6f95e03984df0ae1760e2b5e186f3683be",
        providerRevision: "f5e5c0aa64c0b9df29e0a3c08f53469ab5f2dd0e",
        observedAt: "2026-07-31T23:58:00.000Z",
      },
    }));

    expect(projection.state).toBe("conflicted");
    expect(projection.nextAction).toBe("verify_provider_readback");
    expect(projection.conflicts).toContainEqual({
      type: "provider_readback_mismatch",
      factIds: ["github:pull_request:786", "operation-mismatch"],
      sourceOwners: ["github", "stensibly"],
    });
  });

  test("classifies authority generation mismatch", () => {
    const projection = compileSynchronizationState(fixture({
      authority: {
        ...fixture().authority!,
        generation: 3,
        currentGeneration: 4,
      },
    }));

    expect(projection.state).toBe("conflicted");
    expect(projection.nextAction).toBe("renew_authority");
    expect(projection.conflicts).toContainEqual({
      type: "authority_generation_mismatch",
      factIds: ["authority-1"],
      sourceOwners: ["stensibly"],
    });
  });

  test("classifies changed ProofWake projection inputs", () => {
    const projection = compileSynchronizationState(fixture({
      evidence: {
        ...fixture().evidence!,
        sourceRevision: "f5e5c0aa64c0b9df29e0a3c08f53469ab5f2dd0e",
      },
    }));

    expect(projection.state).toBe("conflicted");
    expect(projection.nextAction).toBe("refresh_evidence_projection");
    expect(projection.conflicts).toContainEqual({
      type: "projection_input_changed",
      factIds: ["github:pull_request:786", "proofwake-projection-1"],
      sourceOwners: ["github", "proofwake"],
    });
  });

  test("classifies changed coordination inputs", () => {
    const projection = compileSynchronizationState(fixture(
      {},
      { coordinationInputFingerprint: hash("unrelated-coordination-input") },
    ));

    expect(projection.state).toBe("conflicted");
    expect(projection.nextAction).toBe("refresh_evidence_projection");
    expect(projection.conflicts).toContainEqual({
      type: "projection_input_changed",
      factIds: ["coordination-receipt-1"],
      sourceOwners: ["stensibly"],
    });
  });

  test("classifies competing coordination producers", () => {
    const projection = compileSynchronizationState(fixture({
      coordination: {
        ...fixture().coordination!,
        status: "competing",
      },
    }));

    expect(projection.state).toBe("conflicted");
    expect(projection.nextAction).toBe("resolve_competing_producer");
    expect(projection.conflicts).toContainEqual({
      type: "competing_producer",
      factIds: ["coordination-receipt-1"],
      sourceOwners: ["stensibly"],
    });
  });

  test("rejects unsupported source transitions with one fixed next action", () => {
    const projection = compileSynchronizationState(fixture({
      source: {
        ...fixture().source!,
        status: "unsupported",
      },
    }));

    expect(projection.state).toBe("conflicted");
    expect(projection.nextAction).toBe("admit_supported_transition");
    expect(projection.conflicts).toContainEqual({
      type: "unsupported_source_transition",
      factIds: ["github-observation-1"],
      sourceOwners: ["github"],
    });
  });

  test("rejects padded identities, aliases, and non-canonical timestamps", () => {
    expect(() => compileSynchronizationState(fixture({
      subject: { ...fixture().subject, id: " github:pull_request:786 " },
    }))).toThrow("exact control-free bytes");

    expect(() => compileSynchronizationState(fixture({
      subject: { ...fixture().subject, repository: "TeamLeaderLeo/Stensibly" },
    }))).toThrow("exact lowercase owner/name");

    expect(() => compileSynchronizationState(fixture({
      evaluatedAt: "2026-08-01T00:00:00Z",
    }))).toThrow("canonical ISO timestamp");
  });

  test("rejects realistic credential values while preserving benign sk text", () => {
    expect(() => compileSynchronizationState(fixture({
      policyVersion: `policy-sk-${"A".repeat(24)}`,
    }))).toThrow("credential value or reference");

    const benign = compileSynchronizationState(fixture({
      policyVersion: "policy-sk-review",
      coordination: {
        ...fixture().coordination!,
        id: "runner-sk-proj-review",
      },
    }));
    expect(benign.state).toBe("synchronized");
  });

  test("rejects unknown fields, accessors, sparse arrays, and decorated arrays", () => {
    expect(() => compileSynchronizationState({
      ...fixture(),
      invented: true,
    })).toThrow("fields were invalid");

    const accessor = fixture() as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "policyVersion", {
      enumerable: true,
      get: () => "policy-v1",
    });
    expect(() => compileSynchronizationState(accessor)).toThrow(
      "enumerable data properties",
    );

    const sparse = new Array(1);
    expect(() => compileSynchronizationState(fixture({
      declaredConflicts: sparse as SynchronizationConflictInputV1[],
    }))).toThrow("dense and undecorated");

    const decorated: SynchronizationConflictInputV1[] = [];
    Object.defineProperty(decorated, "note", { enumerable: true, value: "x" });
    expect(() => compileSynchronizationState(fixture({
      declaredConflicts: decorated,
    }))).toThrow("dense and undecorated");

    const customPrototype: SynchronizationConflictInputV1[] = [];
    Object.setPrototypeOf(customPrototype, Object.create(Array.prototype));
    expect(() => compileSynchronizationState(fixture({
      declaredConflicts: customPrototype,
    }))).toThrow("ordinary array prototype");
  });

  test("rejects duplicate declared conflicts after canonical ordering", () => {
    const first = conflict(
      "competing_producer",
      ["producer-a", "producer-b"],
      ["stensibly"],
    );
    const second = conflict(
      "competing_producer",
      ["producer-b", "producer-a"],
      ["stensibly"],
    );
    expect(() => compileSynchronizationState(fixture({
      declaredConflicts: [first, second],
    }))).toThrow("declared conflict was duplicated");
  });

  test("rejects future facts and impossible operation settlement claims", () => {
    expect(() => compileSynchronizationState(fixture({
      source: {
        ...fixture().source!,
        observedAt: "2026-08-01T00:00:01.000Z",
        freshnessUntil: "2026-08-01T00:05:00.000Z",
      },
    }))).toThrow("fact time cannot be after evaluatedAt");

    expect(() => compileSynchronizationState(fixture({
      operation: {
        id: "operation-verified",
        state: "verified",
        targetRevision: fixture().subject.revision,
        providerRevision: null,
        observedAt: "2026-07-31T23:58:00.000Z",
      },
    }))).toThrow("requires providerRevision");

    expect(() => compileSynchronizationState(fixture({
      operation: {
        id: "operation-reserved",
        state: "reserved",
        targetRevision: fixture().subject.revision,
        providerRevision: fixture().subject.revision,
        observedAt: "2026-07-31T23:58:00.000Z",
      },
    }))).toThrow("cannot claim providerRevision");
  });
});
