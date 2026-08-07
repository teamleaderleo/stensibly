import { describe, expect, test } from "bun:test";
import {
  admitGitHubRepositoryNodeIdResponse,
  buildGitHubUpdateRefsCasRequest,
} from "../src/github-update-refs-cas.ts";

function repositoryIdentity(
  repositoryFullName = "teamleaderleo/stensibly",
  repositoryId = "R_kgDOExample",
) {
  return admitGitHubRepositoryNodeIdResponse({
    data: {
      repository: {
        id: repositoryId,
        nameWithOwner: repositoryFullName,
      },
    },
  }, repositoryFullName);
}

function base() {
  return {
    apiBaseUrl: "https://api.github.com",
    repository: repositoryIdentity(),
    targetRef: "topic/exact-cas",
    expectedHeadSha: "1".repeat(40),
    newHeadSha: "abcdef0123456789" + "2".repeat(24),
  };
}

describe("GitHub updateRefs CAS mutation identity", () => {
  test("changes when any exact CAS identity changes", () => {
    const originalInput = base();
    const original = buildGitHubUpdateRefsCasRequest(originalInput).clientMutationId;
    const variants = [
      {
        ...originalInput,
        repository: repositoryIdentity("teamleaderleo/other", "R_kgDOExample"),
      },
      {
        ...originalInput,
        repository: repositoryIdentity("teamleaderleo/stensibly", "R_kgDOOther"),
      },
      { ...originalInput, targetRef: "topic/other" },
      { ...originalInput, expectedHeadSha: "3".repeat(40) },
      {
        ...originalInput,
        newHeadSha: "abcdef0123456789" + "4".repeat(24),
      },
    ];

    for (const variant of variants) {
      expect(buildGitHubUpdateRefsCasRequest(variant).clientMutationId)
        .not.toBe(original);
    }
  });

  test("does not collapse distinct full new object IDs behind one public prefix", () => {
    const originalInput = base();
    const first = buildGitHubUpdateRefsCasRequest(originalInput).clientMutationId;
    const second = buildGitHubUpdateRefsCasRequest({
      ...originalInput,
      newHeadSha: "abcdef0123456789" + "5".repeat(24),
    }).clientMutationId;

    expect(second).not.toBe(first);
  });
});
