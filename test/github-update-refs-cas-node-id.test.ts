import { expect, test } from "bun:test";
import {
  admitGitHubRepositoryNodeIdResponse,
  buildGitHubRepositoryNodeIdRequest,
  buildGitHubUpdateRefsCasRequest,
} from "../src/github-update-refs-cas.ts";

const apiBaseUrl = "https://api.github.com";
const repositoryFullName = "teamleaderleo/stensibly";
const opaqueNodeId = "R_kgDOAtomic/Repository+legacy=";

test("admits a bounded opaque node ID inside its exact lookup context", () => {
  const lookup = buildGitHubRepositoryNodeIdRequest(apiBaseUrl, repositoryFullName);
  const repository = admitGitHubRepositoryNodeIdResponse({
    data: {
      repository: { id: opaqueNodeId, nameWithOwner: repositoryFullName },
    },
  }, lookup);

  expect(repository).toEqual({
    graphqlUrl: "https://api.github.com/graphql",
    repositoryFullName,
    repositoryId: opaqueNodeId,
  });
  expect(buildGitHubUpdateRefsCasRequest({
    repository,
    targetRef: "feature/exact-cas",
    expectedHeadSha: "a".repeat(40),
    newHeadSha: "b".repeat(40),
  }).body).toEqual(expect.objectContaining({
    variables: { input: expect.objectContaining({ repositoryId: opaqueNodeId }) },
  }));
});

test("rejects repository substitution, whitespace, and overlong node IDs", () => {
  const lookup = buildGitHubRepositoryNodeIdRequest(apiBaseUrl, repositoryFullName);
  expect(() => admitGitHubRepositoryNodeIdResponse({
    data: {
      repository: { id: opaqueNodeId, nameWithOwner: "teamleaderleo/other" },
    },
  }, lookup)).toThrow("GitHub updateRefs GraphQL response is invalid");

  for (const id of ["node id", "x".repeat(257)]) {
    expect(() => admitGitHubRepositoryNodeIdResponse({
      data: { repository: { id, nameWithOwner: repositoryFullName } },
    }, lookup)).toThrow("GitHub updateRefs GraphQL response is invalid");
  }
});
