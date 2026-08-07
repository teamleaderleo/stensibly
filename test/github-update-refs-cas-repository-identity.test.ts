import { expect, test } from "bun:test";
import {
  admitGitHubRepositoryNodeIdResponse,
  buildGitHubRepositoryNodeIdRequest,
  buildGitHubUpdateRefsCasRequest,
} from "../src/github-update-refs-cas.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const repositoryId = "R_kgDOAtomicRepository";
const targetRef = "feature/exact-cas";
const expectedHeadSha = "a".repeat(40);
const newHeadSha = "b".repeat(40);

test("binds lookup endpoint, repository, and node ID in one admitted identity", () => {
  const request = buildGitHubRepositoryNodeIdRequest(
    "https://api.github.com",
    repositoryFullName,
  );
  expect(String(request.body.query)).toContain("nameWithOwner");

  const repository = admitGitHubRepositoryNodeIdResponse({
    data: {
      repository: {
        id: repositoryId,
        nameWithOwner: repositoryFullName,
      },
    },
  }, "https://api.github.com", repositoryFullName);

  expect(repository).toEqual({
    graphqlUrl: "https://api.github.com/graphql",
    repositoryFullName,
    repositoryId,
  });
  expect(Object.isFrozen(repository)).toBe(true);
  expect(buildGitHubUpdateRefsCasRequest({
    repository,
    targetRef,
    expectedHeadSha,
    newHeadSha,
  }).url.href).toBe(repository.graphqlUrl);
});

test("rejects structural receipt forgery and provider repository substitution", () => {
  expect(() => buildGitHubUpdateRefsCasRequest({
    repository: {
      graphqlUrl: "https://api.github.com/graphql",
      repositoryFullName,
      repositoryId,
    },
    targetRef,
    expectedHeadSha,
    newHeadSha,
  })).toThrow("GitHub updateRefs CAS input is invalid");

  expect(() => admitGitHubRepositoryNodeIdResponse({
    data: {
      repository: {
        id: repositoryId,
        nameWithOwner: "teamleaderleo/other-repository",
      },
    },
  }, "https://api.github.com", repositoryFullName)).toThrow(
    "GitHub updateRefs GraphQL response is invalid",
  );
});

test("a receipt from endpoint A cannot be paired with endpoint B", () => {
  const repository = admitGitHubRepositoryNodeIdResponse({
    data: {
      repository: {
        id: repositoryId,
        nameWithOwner: repositoryFullName,
      },
    },
  }, "https://github.example.com/api/v3", repositoryFullName);

  const request = buildGitHubUpdateRefsCasRequest({
    repository,
    targetRef,
    expectedHeadSha,
    newHeadSha,
  });
  expect(request.url.href).toBe("https://github.example.com/api/graphql");
  expect(request.url.href).not.toBe("https://api.github.com/graphql");
});
