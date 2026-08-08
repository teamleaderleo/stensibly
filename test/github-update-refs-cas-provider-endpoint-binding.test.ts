import { expect, test } from "bun:test";
import {
  admitGitHubRepositoryNodeIdResponse,
  buildGitHubRepositoryNodeIdRequest,
  buildGitHubUpdateRefsCasRequest,
} from "../src/github-update-refs-cas.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const repositoryId = "R_kgDOProviderEndpoint";

test("binds the admitted repository identity to the exact GraphQL provider endpoint", () => {
  const publicRequest = buildGitHubRepositoryNodeIdRequest(
    "https://api.github.com",
    repositoryFullName,
  );
  const enterpriseRequest = buildGitHubRepositoryNodeIdRequest(
    "https://github.example.com/api/v3",
    repositoryFullName,
  );
  const publicIdentity = admitGitHubRepositoryNodeIdResponse({
    data: {
      repository: {
        id: repositoryId,
        nameWithOwner: repositoryFullName,
      },
    },
  }, repositoryFullName, publicRequest.url.href);
  const enterpriseIdentity = admitGitHubRepositoryNodeIdResponse({
    data: {
      repository: {
        id: repositoryId,
        nameWithOwner: repositoryFullName,
      },
    },
  }, repositoryFullName, enterpriseRequest.url.href);

  const publicMutation = buildGitHubUpdateRefsCasRequest({
    repository: publicIdentity,
    targetRef: "topic/exact-cas",
    expectedHeadSha: "1".repeat(40),
    newHeadSha: "2".repeat(40),
  });
  const enterpriseMutation = buildGitHubUpdateRefsCasRequest({
    repository: enterpriseIdentity,
    targetRef: "topic/exact-cas",
    expectedHeadSha: "1".repeat(40),
    newHeadSha: "2".repeat(40),
  });

  expect(publicMutation.url.href).toBe("https://api.github.com/graphql");
  expect(enterpriseMutation.url.href).toBe(
    "https://github.example.com/api/graphql",
  );
  expect(publicMutation.clientMutationId).not.toBe(
    enterpriseMutation.clientMutationId,
  );
});

test("rejects forged repository identity objects even with valid-looking fields", () => {
  expect(() => buildGitHubUpdateRefsCasRequest({
    repository: {
      graphqlUrl: "https://api.github.com/graphql",
      repositoryFullName,
      repositoryId,
    },
    targetRef: "topic/exact-cas",
    expectedHeadSha: "1".repeat(40),
    newHeadSha: "2".repeat(40),
  })).toThrow("GitHub updateRefs CAS input is invalid");
});