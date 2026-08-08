import { expect, test } from "bun:test";
import {
  admitGitHubRepositoryNodeIdResponse,
} from "../src/github-update-refs-cas.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const graphqlUrl = "https://api.github.com/graphql";

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
    }, repositoryFullName, graphqlUrl);
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
  }, repositoryFullName, graphqlUrl)).toEqual({
    graphqlUrl,
    repositoryFullName,
    repositoryId: "R_kgDOCanonicalRepository",
  });
});