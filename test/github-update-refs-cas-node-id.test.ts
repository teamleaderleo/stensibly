import { expect, test } from "bun:test";
import {
  admitGitHubRepositoryNodeIdResponse,
  buildGitHubUpdateRefsCasRequest,
} from "../src/github-update-refs-cas.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const opaqueNodeId = "R_kgDOAtomic/Repository+legacy=";

function repositoryIdentity(
  fullName = repositoryFullName,
  id = opaqueNodeId,
) {
  return admitGitHubRepositoryNodeIdResponse({
    data: {
      repository: {
        id,
        nameWithOwner: fullName,
      },
    },
  }, fullName);
}

test("admits a bounded opaque node ID only with its exact provider repository", () => {
  expect(repositoryIdentity()).toEqual({
    repositoryFullName,
    repositoryId: opaqueNodeId,
  });

  expect(buildGitHubUpdateRefsCasRequest({
    apiBaseUrl: "https://api.github.com",
    repository: repositoryIdentity(),
    targetRef: "feature/exact-cas",
    expectedHeadSha: "a".repeat(40),
    newHeadSha: "b".repeat(40),
  }).body).toMatchObject({
    variables: {
      input: { repositoryId: opaqueNodeId },
    },
  });
});

test("rejects repository substitution, whitespace, and overlong node IDs", () => {
  expect(() => admitGitHubRepositoryNodeIdResponse({
    data: {
      repository: {
        id: opaqueNodeId,
        nameWithOwner: "teamleaderleo/other",
      },
    },
  }, repositoryFullName)).toThrow("GitHub updateRefs GraphQL response is invalid");

  for (const id of ["node id", "x".repeat(257)]) {
    expect(() => admitGitHubRepositoryNodeIdResponse({
      data: {
        repository: {
          id,
          nameWithOwner: repositoryFullName,
        },
      },
    }, repositoryFullName)).toThrow("GitHub updateRefs GraphQL response is invalid");
  }
});
