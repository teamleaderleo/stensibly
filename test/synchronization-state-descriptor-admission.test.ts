import { expect, test } from "bun:test";
import { compileSynchronizationState } from "../src/synchronization-state.ts";

const base = {
  schemaVersion: 1 as const,
  policyVersion: "policy-v1",
  evaluatedAt: "2026-08-01T00:00:00.000Z",
  subject: {
    owner: "github" as const,
    repository: "teamleaderleo/stensibly",
    kind: "pull_request" as const,
    id: "github:pull_request:838",
    revision: "91b98a95281dd7d9dfcf29e4c218f2ae9c1b1962",
  },
  source: null,
  evidence: null,
  operation: null,
  authority: null,
  coordination: null,
  declaredConflicts: [],
};

test("rejects non-enumerable extra object fields", () => {
  const input = { ...base } as Record<string, unknown>;
  Object.defineProperty(input, "hidden", { value: "caller-data" });
  expect(() => compileSynchronizationState(input)).toThrow("fields were invalid");
});

test("rejects non-enumerable array decorations", () => {
  const conflicts: unknown[] = [];
  Object.defineProperty(conflicts, "hidden", { value: "caller-data" });
  expect(() => compileSynchronizationState({
    ...base,
    declaredConflicts: conflicts,
  })).toThrow("dense and undecorated");
});

test("retains plain null-prototype records and dense arrays", () => {
  const input = Object.assign(Object.create(null), base);
  const projection = compileSynchronizationState(input);
  expect(projection.state).toBe("unknown");
});
