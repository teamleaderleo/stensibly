import { expect, test } from "bun:test";
import {
  admitGitHubRepositoryNodeIdResponse,
  buildGitHubRepositoryNodeIdRequest,
} from "../src/github-update-refs-cas.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const apiBaseUrl = "https://api.github.com";

function lookup() {
  return buildGitHubRepositoryNodeIdRequest(apiBaseUrl, repositoryFullName);
}

test("rejects substituted provider repository identity without retaining it", () => {
  let caught: unknown;
  try {
    admitGitHubRepositoryNodeIdResponse({
      data: {
        repository: {
          id: "R_kgDOSubstitutedRepository",
          nameWithOwner: "teamleaderleo/other-repository",
        },
      },
    }, lookup());
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message)
    .toBe("GitHub updateRefs GraphQL response is invalid");
  expect(JSON.stringify(caught)).not.toContain("other-repository");
});

test("admits provider case spelling only after canonical repository normalization", () => {
  expect(admitGitHubRepositoryNodeIdResponse({
    data: {
      repository: {
        id: "R_kgDOCanonicalRepository",
        nameWithOwner: "TeamLeaderLeo/Stensibly",
      },
    },
  }, lookup())).toEqual({
    graphqlUrl: "https://api.github.com/graphql",
    repositoryFullName,
    repositoryId: "R_kgDOCanonicalRepository",
  });
});
