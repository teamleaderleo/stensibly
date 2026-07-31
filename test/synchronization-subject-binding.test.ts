import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  compileSubjectBoundSynchronizationState,
  fingerprintSubjectBoundSynchronizationCoordinationInput,
  fingerprintSynchronizationSubject,
  synchronizationSubjectBindingRevision,
  type SubjectBoundSynchronizationCompilerInputV1,
} from "../src/synchronization-subject-binding.ts";

const evaluatedAt = "2026-08-01T00:00:00.000Z";
const subject = Object.freeze({
  owner: "github" as const,
  repository: "teamleaderleo/stensibly",
  kind: "pull_request" as const,
  id: "github:pull_request:849",
  revision: "6e0329ad9afa28c75f6eb0ca073ad8f24e7cb6ac",
});

function hash(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

function fixture(): SubjectBoundSynchronizationCompilerInputV1 {
  const subjectFingerprint = fingerprintSynchronizationSubject(subject);
  const withoutCoordination: SubjectBoundSynchronizationCompilerInputV1 = {
    schemaVersion: 1,
    policyVersion: "github-proofwake-stensibly/v1",
    evaluatedAt,
    subject,
    source: {
      id: "github-observation-849",
      deliveryId: "delivery-849",
      revision: subject.revision,
      observedAt: "2026-07-31T23:55:00.000Z",
      freshnessUntil: "2026-08-01T00:05:00.000Z",
      status: "accepted",
      subjectFingerprint,
    },
    evidence: {
      id: "proofwake-projection-849",
      projectionFingerprint: hash("proofwake-projection-849"),
      sourceRevision: subject.revision,
      observedAt: "2026-07-31T23:56:00.000Z",
      freshnessUntil: "2026-08-01T00:05:00.000Z",
      status: "accepted",
      subjectFingerprint,
    },
    operation: null,
    authority: {
      id: "authority-849",
      generation: 7,
      currentGeneration: 7,
      status: "active",
      observedAt: "2026-07-31T23:50:00.000Z",
      subjectFingerprint,
    },
    coordination: null,
    declaredConflicts: [],
  };
  return {
    ...withoutCoordination,
    coordination: {
      id: "coordination-849",
      inputFingerprint: fingerprintSubjectBoundSynchronizationCoordinationInput(
        withoutCoordination,
      ),
      status: "accepted",
      observedAt: "2026-07-31T23:57:00.000Z",
      subjectFingerprint,
    },
  };
}

describe("subject-bound synchronization composition", () => {
  test("binds every admitted fact to one canonical subject fingerprint", () => {
    const input = fixture();
    const projection = compileSubjectBoundSynchronizationState(input);

    expect(projection.bindingRevision).toBe(synchronizationSubjectBindingRevision);
    expect(projection.subjectFingerprint).toBe(
      fingerprintSynchronizationSubject(subject),
    );
    expect(projection.state).toBe("synchronized");
    expect(projection.conflicts).toEqual([]);
    expect(projection.authorizesMutation).toBe(false);
    expect(projection.authorizesAuthority).toBe(false);
    expect(projection.inputFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(projection.projectionFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.subject)).toBe(true);
    expect(Object.isFrozen(projection.facts)).toBe(true);
  });

  test("rejects each fact when its subject fingerprint belongs to another object", () => {
    const wrongSubjectFingerprint = fingerprintSynchronizationSubject({
      ...subject,
      id: "github:pull_request:850",
    });

    for (const field of [
      "source",
      "evidence",
      "authority",
      "coordination",
    ] as const) {
      const input = fixture();
      const fact = input[field];
      if (fact === null) throw new Error(`${field} fixture was unexpectedly absent`);
      expect(() => compileSubjectBoundSynchronizationState({
        ...input,
        [field]: {
          ...fact,
          subjectFingerprint: wrongSubjectFingerprint,
        },
      })).toThrow("fact subject did not match compiler subject");
    }

    const input = fixture();
    expect(() => compileSubjectBoundSynchronizationState({
      ...input,
      operation: {
        id: "operation-849",
        state: "verified",
        targetRevision: subject.revision,
        providerRevision: subject.revision,
        observedAt: "2026-07-31T23:58:00.000Z",
        subjectFingerprint: wrongSubjectFingerprint,
      },
    })).toThrow("fact subject did not match compiler subject");
  });

  test("rejects missing, malformed, accessor-backed, and hidden binding fields", () => {
    const input = fixture();
    const { subjectFingerprint: _omitted, ...sourceWithoutBinding } = input.source!;
    expect(() => compileSubjectBoundSynchronizationState({
      ...input,
      source: sourceWithoutBinding,
    })).toThrow("fields were invalid");

    expect(() => compileSubjectBoundSynchronizationState({
      ...input,
      source: {
        ...input.source!,
        subjectFingerprint: hash("UPPER").toUpperCase(),
      },
    })).toThrow("lowercase SHA-256 fingerprint");

    const accessor = { ...input.source! } as Record<string, unknown>;
    Object.defineProperty(accessor, "subjectFingerprint", {
      enumerable: true,
      get: () => fingerprintSynchronizationSubject(subject),
    });
    expect(() => compileSubjectBoundSynchronizationState({
      ...input,
      source: accessor,
    })).toThrow("enumerable data properties");

    const hidden = { ...input.source! } as Record<string, unknown>;
    Object.defineProperty(hidden, "hidden", {
      enumerable: false,
      value: "outside-canonical-input",
    });
    expect(() => compileSubjectBoundSynchronizationState({
      ...input,
      source: hidden,
    })).toThrow("fields were invalid");
  });

  test("keeps an empty fact set representable without inventing bindings", () => {
    const projection = compileSubjectBoundSynchronizationState({
      schemaVersion: 1,
      policyVersion: "github-proofwake-stensibly/v1",
      evaluatedAt,
      subject,
      source: null,
      evidence: null,
      operation: null,
      authority: null,
      coordination: null,
      declaredConflicts: [],
    });

    expect(projection.state).toBe("unknown");
    expect(projection.nextAction).toBe("collect_missing_facts");
    expect(projection.subjectFingerprint).toBe(
      fingerprintSynchronizationSubject(subject),
    );
  });

  test("changes wrapper identity when the canonical subject changes", () => {
    const first = compileSubjectBoundSynchronizationState(fixture());
    const secondSubject = {
      ...subject,
      id: "github:pull_request:850",
    };
    const secondFingerprint = fingerprintSynchronizationSubject(secondSubject);
    const secondWithoutCoordination: SubjectBoundSynchronizationCompilerInputV1 = {
      ...fixture(),
      subject: secondSubject,
      source: {
        ...fixture().source!,
        id: "github-observation-850",
        subjectFingerprint: secondFingerprint,
      },
      evidence: {
        ...fixture().evidence!,
        id: "proofwake-projection-850",
        subjectFingerprint: secondFingerprint,
      },
      authority: {
        ...fixture().authority!,
        id: "authority-850",
        subjectFingerprint: secondFingerprint,
      },
      coordination: null,
    };
    const second = compileSubjectBoundSynchronizationState({
      ...secondWithoutCoordination,
      coordination: {
        ...fixture().coordination!,
        id: "coordination-850",
        subjectFingerprint: secondFingerprint,
        inputFingerprint:
          fingerprintSubjectBoundSynchronizationCoordinationInput(
            secondWithoutCoordination,
          ),
      },
    });

    expect(second.state).toBe("synchronized");
    expect(second.subjectFingerprint).not.toBe(first.subjectFingerprint);
    expect(second.inputFingerprint).not.toBe(first.inputFingerprint);
    expect(second.projectionFingerprint).not.toBe(first.projectionFingerprint);
  });
});
