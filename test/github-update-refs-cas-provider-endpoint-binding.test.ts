import { expect, test } from "bun:test";
import {
  admitGitHubRepositoryNodeIdResponse,
  buildGitHubRepositoryNodeIdRequest,
  buildGitHubUpdateRefsCasRequest,
  githubGraphqlUrl,
  type GitHubUpdateRefsCasInput,
} from "../src/github-update-refs-cas.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const repositoryId = "R_kgDOProviderScopedRepository";
const graphqlUrl = "https://github-a.example/api/graphql";
const targetRef = "feature/exact-cas";
const expectedHeadSha = "a".repeat(40);
const newHeadSha = "b".repeat(40);

test("binds repository node identity to the exact GraphQL endpoint", () => {
  const request = buildGitHubRepositoryNodeIdRequest(
    "https://github-a.example/api/v3",
    repositoryFullName,
  );
  expect(request.url.href).toBe(graphqlUrl);

  const admitBoundRepository = admitGitHubRepositoryNodeIdResponse as unknown as (
    value: unknown,
    expectedRepositoryFullName: string,
    expectedGraphqlUrl: string,
  ) => Readonly<{
    graphqlUrl: string;
    repositoryFullName: string;
    repositoryId: string;
  }>;

  const repository = admitBoundRepository({
    data: {
      repository: {
        id: repositoryId,
        nameWithOwner: repositoryFullName,
      },
    },
  }, repositoryFullName, graphqlUrl);

  expect(repository).toEqual({
    graphqlUrl,
    repositoryFullName,
    repositoryId,
  });

  const buildBoundCas = buildGitHubUpdateRefsCasRequest as unknown as (
    input: Omit<GitHubUpdateRefsCasInput, "apiBaseUrl" | "repository"> & {
      repository: typeof repository;
    },
  ) => ReturnType<typeof buildGitHubUpdateRefsCasRequest>;

  const mutation = buildBoundCas({
    repository,
    targetRef,
    expectedHeadSha,
    newHeadSha,
  });
  expect(mutation.url.href).toBe(graphqlUrl);
});

test("rejects non-string API bases without conversion hooks", () => {
  let conversionCalls = 0;
  const hostile = {
    toString() {
      conversionCalls += 1;
      throw new Error("must not convert caller API base");
    },
  };

  expect(() => githubGraphqlUrl(hostile as never))
    .toThrow("GitHub API base URL is invalid");
  expect(conversionCalls).toBe(0);
});
