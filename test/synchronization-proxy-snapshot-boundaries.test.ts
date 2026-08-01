import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  compileSubjectBoundSynchronizationState,
  fingerprintSubjectBoundSynchronizationCoordinationInput,
  fingerprintSynchronizationSubject,
  type SubjectBoundSynchronizationCompilerInputV1,
} from "../src/synchronization-subject-binding.js";
import { compileSynchronizationState } from "../src/synchronization-state.js";

const evaluatedAt = "2026-08-01T00:00:00.000Z";
const subject = {
  owner: "github" as const,
  repository: "teamleaderleo/stensibly",
  kind: "pull_request" as const,
  id: "github:pull_request:853",
  revision: "b024298f630527d8d697af3acee3d08376f41916",
};

function hash(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

function proxyReads<T extends object>(
  target: T,
  overrides: Readonly<Record<string, unknown>>,
): T {
  return new Proxy(target, {
    get(current, key, receiver) {
      if (
        typeof key === "string"
        && Object.prototype.hasOwnProperty.call(overrides, key)
      ) {
        return overrides[key];
      }
      return Reflect.get(current, key, receiver);
    },
  });
}

function fixture(): SubjectBoundSynchronizationCompilerInputV1 {
  const subjectFingerprint = fingerprintSynchronizationSubject(subject);
  const withoutCoordination: SubjectBoundSynchronizationCompilerInputV1 = {
    schemaVersion: 1,
    policyVersion: "github-proofwake-stensibly/v1",
    evaluatedAt,
    subject,
    source: {
      id: "github-observation-853",
      deliveryId: "delivery-853",
      revision: subject.revision,
      observedAt: "2026-07-31T23:55:00.000Z",
      freshnessUntil: "2026-08-01T00:05:00.000Z",
      status: "accepted",
      subjectFingerprint,
    },
    evidence: {
      id: "proofwake-projection-853",
      projectionFingerprint: hash("proofwake-projection-853"),
      sourceRevision: subject.revision,
      observedAt: "2026-07-31T23:56:00.000Z",
      freshnessUntil: "2026-08-01T00:05:00.000Z",
      status: "accepted",
      subjectFingerprint,
    },
    operation: {
      id: "operation-853",
      state: "verified",
      targetRevision: subject.revision,
      providerRevision: subject.revision,
      observedAt: "2026-07-31T23:58:00.000Z",
      subjectFingerprint,
    },
    authority: {
      id: "authority-853",
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
      id: "coordination-853",
      inputFingerprint: fingerprintSubjectBoundSynchronizationCoordinationInput(
        withoutCoordination,
      ),
      status: "accepted",
      observedAt: "2026-07-31T23:59:00.000Z",
      subjectFingerprint,
    },
  };
}

describe("synchronization proxy snapshot admission", () => {
  test("the low-level compiler uses admitted subject descriptors instead of later proxy reads", () => {
    const hostileSubject = proxyReads(subject, {
      id: "github:pull_request:forged",
      revision: "forged-revision",
    });

    const projection = compileSynchronizationState({
      schemaVersion: 1,
      policyVersion: "github-proofwake-stensibly/v1",
      evaluatedAt,
      subject: hostileSubject,
      source: null,
      evidence: null,
      operation: null,
      authority: null,
      coordination: null,
      declaredConflicts: [],
    });

    expect(projection.subject).toEqual(subject);
  });

  test("the subject-bound wrapper reuses one admitted subject snapshot", () => {
    const input = fixture();
    const hostileSubject = proxyReads(subject, {
      id: "github:pull_request:forged",
      revision: "forged-revision",
    });

    const projection = compileSubjectBoundSynchronizationState({
      ...input,
      subject: hostileSubject,
    });

    expect(projection.state).toBe("synchronized");
    expect(projection.subject).toEqual(subject);
    expect(projection.subjectFingerprint).toBe(
      fingerprintSynchronizationSubject(subject),
    );
  });

  test("every bound fact family uses descriptor values rather than later proxy reads", () => {
    const cases = [
      ["source", { status: "delivery_conflict" }],
      ["evidence", { status: "conflicted" }],
      ["operation", { state: "mismatched" }],
      ["authority", { status: "revoked" }],
      ["coordination", { status: "competing" }],
    ] as const;

    for (const [field, overrides] of cases) {
      const input = fixture();
      const fact = input[field];
      if (fact === null) throw new Error(`${field} fixture was unexpectedly absent`);

      const projection = compileSubjectBoundSynchronizationState({
        ...input,
        [field]: proxyReads(fact, overrides),
      });

      expect(projection.state, field).toBe("synchronized");
      expect(projection.conflicts, field).toEqual([]);
    }
  });

  test("only public wrappers import synchronization snapshot internals", async () => {
    const stateWrapper = "src/synchronization-state.ts";
    const subjectWrapper = "src/synchronization-subject-binding.ts";
    const allowed = new Set([stateWrapper, subjectWrapper]);
    const sourceFiles = Array.from(
      new Bun.Glob("src/**/*.ts").scanSync({ cwd: "." }),
    );

    for (const path of sourceFiles) {
      const source = await Bun.file(path).text();
      const importsInternalBase = source.includes("synchronization-state-base.js")
        || source.includes("synchronization-subject-binding-base.js");
      const importsSnapshot = source.includes("synchronization-descriptor-snapshot.js");
      if (importsInternalBase || importsSnapshot) {
        expect(allowed.has(path), path).toBe(true);
      }
    }
  });
});
