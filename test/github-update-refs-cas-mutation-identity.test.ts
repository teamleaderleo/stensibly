import { describe, expect, test } from "bun:test";
import {
  admitGitHubRepositoryNodeIdResponse,
  buildGitHubUpdateRefsCasRequest,
} from "../src/github-update-refs-cas.ts";

function admittedRepository(
  apiBaseUrl: string,
  repositoryFullName: string,
  repositoryId: string,
) {
  return admitGitHubRepositoryNodeIdResponse({
    data: {
      repository: {
        id: repositoryId,
        nameWithOwner: repositoryFullName,
      },
    },
  }, apiBaseUrl, repositoryFullName);
}

const base = {
  repository: admittedRepository(
    "https://api.github.com",
    "teamleaderleo/stensibly",
    "R_kgDOExample",
  ),
  targetRef: "topic/exact-cas",
  expectedHeadSha: "1".repeat(40),
  newHeadSha: "abcdef0123456789" + "2".repeat(24),
};

describe("GitHub updateRefs CAS mutation identity", () => {
  test("changes when any exact CAS identity changes", () => {
    const original = buildGitHubUpdateRefsCasRequest(base).clientMutationId;
    const variants = [
      {
        ...base,
        repository: admittedRepository(
          "https://github.example.com/api/v3",
          "teamleaderleo/stensibly",
          "R_kgDOExample",
        ),
      },
      {
        ...base,
        repository: admittedRepository(
          "https://api.github.com",
          "teamleaderleo/other",
          "R_kgDOExample",
        ),
      },
      {
        ...base,
        repository: admittedRepository(
          "https://api.github.com",
          "teamleaderleo/stensibly",
          "R_kgDOOther",
        ),
      },
      { ...base, targetRef: "topic/other" },
      { ...base, expectedHeadSha: "3".repeat(40) },
      {
        ...base,
        newHeadSha: "abcdef0123456789" + "4".repeat(24),
      },
    ];

    for (const variant of variants) {
      expect(buildGitHubUpdateRefsCasRequest(variant).clientMutationId)
        .not.toBe(original);
    }
  });

  test("does not collapse distinct full new object IDs behind one public prefix", () => {
    const first = buildGitHubUpdateRefsCasRequest(base).clientMutationId;
    const second = buildGitHubUpdateRefsCasRequest({
      ...base,
      newHeadSha: "abcdef0123456789" + "5".repeat(24),
    }).clientMutationId;

    expect(second).not.toBe(first);
  });
});
