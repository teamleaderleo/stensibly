import { expect, test } from "bun:test";
import {
  admitGitHubRepositoryNodeIdResponse,
  buildGitHubRepositoryNodeIdRequest,
  buildGitHubUpdateRefsCasRequest,
} from "../src/github-update-refs-cas.ts";

const apiBaseUrl = "https://api.github.com";
const repositoryFullName = "teamleaderleo/stensibly";
const opaqueNodeId = "R_kgDOAtomic/Repository+legacy=";

function admit(id: string, nameWithOwner = repositoryFullName) {
  const request = buildGitHubRepositoryNodeIdRequest(
    apiBaseUrl,
    repositoryFullName,
  );
  return admitGitHubRepositoryNodeIdResponse({
    data: { repository: { id, nameWithOwner } },
  }, repositoryFullName, request.url.href);
}

test("admits a bounded opaque node ID inside its exact endpoint/repository receipt", () => {
  const repository = admit(opaqueNodeId);

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
    variables: {
      input: expect.objectContaining({ repositoryId: opaqueNodeId }),
    },
  }));
});

test("rejects repository substitution, whitespace, and overlong node IDs", () => {
  expect(() => admit(opaqueNodeId, "teamleaderleo/other"))
    .toThrow("GitHub updateRefs GraphQL response is invalid");

  for (const id of ["node id", "x".repeat(257)]) {
    expect(() => admit(id))
      .toThrow("GitHub updateRefs GraphQL response is invalid");
  }
});
