import { describe, expect, test } from "bun:test";
import {
  admitProjectRepositorySetupObservation,
  compileProjectRepositorySetupObservation,
} from "../src/project-repository-setup-observation.ts";

const base = {
  project: "scrapbook",
  repositoryFullName: "teamleaderleo/scrapbook",
  defaultBranch: "main",
  sourceKind: "github_conversation_context" as const,
  observedAt: "2026-08-10T00:30:00.000Z",
};

describe("pre-attachment repository setup observation", () => {
  test("compiles one deterministic non-authorizing observation", () => {
    const first = compileProjectRepositorySetupObservation(base);
    const second = compileProjectRepositorySetupObservation({ ...base });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      version: 1,
      project: "scrapbook",
      repositoryFullName: "teamleaderleo/scrapbook",
      defaultBranch: "main",
      sourceKind: "github_conversation_context",
      observedAt: "2026-08-10T00:30:00.000Z",
      authorizesProviderEffect: false,
      containsSecrets: false,
    });
    expect(first.id).toMatch(/^repo_setup_[a-f0-9]{64}$/);
    expect(first.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(admitProjectRepositorySetupObservation(first)).toEqual(first);
  });

  test("makes repository, branch, source, and observation time part of identity", () => {
    const original = compileProjectRepositorySetupObservation(base);
    for (const changed of [
      { ...base, repositoryFullName: "teamleaderleo/stensibly" },
      { ...base, defaultBranch: "develop" },
      { ...base, sourceKind: "operator_supplied" as const },
      { ...base, observedAt: "2026-08-10T00:31:00.000Z" },
    ]) {
      expect(compileProjectRepositorySetupObservation(changed).fingerprint)
        .not.toBe(original.fingerprint);
    }
  });

  test("rejects malformed or credential-shaped repository context", () => {
    expect(() => compileProjectRepositorySetupObservation({
      ...base,
      project: "Scrapbook",
    })).toThrow("lowercase slug");
    expect(() => compileProjectRepositorySetupObservation({
      ...base,
      repositoryFullName: "teamleaderleo/scrapbook ",
    })).toThrow();
    expect(() => compileProjectRepositorySetupObservation({
      ...base,
      defaultBranch: "refs/heads/main",
    })).toThrow("Default branch is invalid");
    expect(() => compileProjectRepositorySetupObservation({
      ...base,
      defaultBranch: ["stn", "tok", "x".repeat(44)].join("."),
    })).toThrow("Default branch is invalid");
    expect(() => compileProjectRepositorySetupObservation({
      ...base,
      observedAt: "2026-08-10T00:30:00Z",
    })).toThrow("canonical UTC");
  });

  test("rejects decorations and accessors without executing getters", () => {
    let getterCalls = 0;
    const decorated = {
      ...base,
      extra: true,
    };
    expect(() => compileProjectRepositorySetupObservation(decorated)).toThrow("invalid");

    const accessor = { ...base } as Record<string, unknown>;
    Object.defineProperty(accessor, "project", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "scrapbook";
      },
    });
    expect(() => compileProjectRepositorySetupObservation(accessor)).toThrow("invalid");
    expect(getterCalls).toBe(0);
  });

  test("rejects altered stored identity or authority metadata", () => {
    const observation = compileProjectRepositorySetupObservation(base);
    expect(() => admitProjectRepositorySetupObservation({
      ...observation,
      fingerprint: `sha256:${"0".repeat(64)}`,
    })).toThrow("identity");
    expect(() => admitProjectRepositorySetupObservation({
      ...observation,
      authorizesProviderEffect: true,
    })).toThrow("metadata");
  });
});
