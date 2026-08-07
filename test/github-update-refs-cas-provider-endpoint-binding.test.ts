import { expect, test } from "bun:test";
import {
  admitGitHubRepositoryNodeIdResponse,
  buildGitHubRepositoryNodeIdRequest,
} from "../src/github-update-refs-cas.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const repositoryId = "R_kgDOAtomicRepository";
const response = {
  data: {
    repository: { id: repositoryId, nameWithOwner: repositoryFullName },
  },
};

test("repository response admission derives endpoint only from exact lookup context", () => {
  const lookup = buildGitHubRepositoryNodeIdRequest(
    "https://api.github.com",
    repositoryFullName,
  );
  const repository = admitGitHubRepositoryNodeIdResponse(response, lookup);
  expect(repository).toEqual({
    graphqlUrl: "https://api.github.com/graphql",
    repositoryFullName,
    repositoryId,
  });

  const legacyAdmit = admitGitHubRepositoryNodeIdResponse as unknown as (
    value: unknown,
    lookup: unknown,
    repository?: unknown,
  ) => unknown;
  expect(() => legacyAdmit(
    response,
    "https://github.example.com/api/graphql",
    repositoryFullName,
  )).toThrow("GitHub updateRefs GraphQL response is invalid");
});

test("structural lookup lookalikes cannot relabel provider endpoint", () => {
  const lookup = buildGitHubRepositoryNodeIdRequest(
    "https://api.github.com",
    repositoryFullName,
  );
  expect(() => admitGitHubRepositoryNodeIdResponse(
    response,
    { ...lookup },
  )).toThrow("GitHub updateRefs GraphQL response is invalid");
});
