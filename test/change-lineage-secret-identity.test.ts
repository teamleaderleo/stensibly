import { describe, expect, test } from "bun:test";
import { compileChangeLineage } from "../src/change-lineage.ts";

const revisionId = "a".repeat(40);
const observedAt = "2026-07-31T15:20:00.000Z";

function input(overrides: Record<string, unknown> = {}) {
  return {
    repository: "teamleaderleo/stensibly",
    observedAt,
    changes: [{
      changeId: "change-safe",
      provider: "github",
      providerChangeId: "pull:742",
      targetRef: "main",
      lifecycle: "open",
      currentRevisionId: revisionId,
      supersededBy: null,
      semanticDependencies: [],
      revisions: [{
        revisionId,
        generation: 1,
        observedAt: "2026-07-31T15:19:00.000Z",
        operation: "create",
        predecessors: [],
        stackParent: null,
        sourceReferences: ["github:observation:safe"],
        recoveryReference: `git:${revisionId}`,
      }],
      requiredChecks: [],
      checks: [],
      reviewedRevisionId: null,
      reviewDisposition: "none",
      unresolvedThreads: 0,
      ...overrides,
    }],
  };
}

describe("change lineage secret identity admission", () => {
  test("rejects secret-shaped identities after namespace delimiters", () => {
    for (const overrides of [
      { changeId: "work/github_pat_examplecredential" },
      { providerChangeId: "review:sk-proj-examplecredential" },
      {
        revisions: [{
          revisionId,
          generation: 1,
          observedAt: "2026-07-31T15:19:00.000Z",
          operation: "create",
          predecessors: [],
          stackParent: null,
          sourceReferences: ["github:delivery:ghp_examplecredential"],
          recoveryReference: `git:${revisionId}`,
        }],
      },
      {
        revisions: [{
          revisionId,
          generation: 1,
          observedAt: "2026-07-31T15:19:00.000Z",
          operation: "create",
          predecessors: [],
          stackParent: null,
          sourceReferences: ["github:observation:safe"],
          recoveryReference: "run/stn.tok_examplecredential",
        }],
      },
    ]) {
      expect(() => compileChangeLineage(input(overrides))).toThrow("secret-shaped");
    }
  });

  test("preserves ordinary exact identifiers containing non-token substrings", () => {
    const result = compileChangeLineage(input({
      changeId: "workgithub_pat_marker",
      providerChangeId: "reviewsk-marker",
    }));

    expect(result.changes[0]).toMatchObject({
      changeId: "workgithub_pat_marker",
      providerChangeId: "reviewsk-marker",
    });
  });
});
