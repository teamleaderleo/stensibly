import { expect, test } from "bun:test";
import {
  admitGitHubRepositoryNodeIdResponse,
  buildGitHubUpdateRefsCasRequest,
} from "../src/github-update-refs-cas.ts";

const opaqueNodeId = "R_kgDOAtomic/Repository+legacy=";

test("admits bounded opaque printable GitHub node IDs", () => {
  expect(admitGitHubRepositoryNodeIdResponse({
    data: { repository: { id: opaqueNodeId } },
  })).toBe(opaqueNodeId);

  expect(buildGitHubUpdateRefsCasRequest({
    apiBaseUrl: "https://api.github.com",
    repositoryFullName: "teamleaderleo/stensibly",
    repositoryId: opaqueNodeId,
    targetRef: "feature/exact-cas",
    expectedHeadSha: "a".repeat(40),
    newHeadSha: "b".repeat(40),
  }).body).toEqual(expect.objectContaining({
    variables: {
      input: expect.objectContaining({ repositoryId: opaqueNodeId }),
    },
  }));
});

test("rejects whitespace and overlong node IDs", () => {
  for (const id of ["node id", "x".repeat(257)]) {
    expect(() => admitGitHubRepositoryNodeIdResponse({
      data: { repository: { id } },
    })).toThrow("GitHub updateRefs GraphQL response is invalid");
  }
});