import { expect, test } from "bun:test";
import {
  admitGitHubRepositoryNodeIdResponse,
  buildGitHubRepositoryNodeIdRequest,
  buildGitHubUpdateRefsCasRequest,
  type GitHubUpdateRefsCasInput,
} from "../src/github-update-refs-cas.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const repositoryId = "R_kgDOAtomicRepository";
const targetRef = "feature/exact-cas";
const expectedHeadSha = "a".repeat(40);
const newHeadSha = "b".repeat(40);

test("binds the repository node lookup receipt to the requested canonical repository", () => {
  const request = buildGitHubRepositoryNodeIdRequest(
    "https://api.github.com",
    repositoryFullName,
  );
  expect(String(request.body.query)).toContain("nameWithOwner");

  const admitBoundRepository = admitGitHubRepositoryNodeIdResponse as unknown as (
    value: unknown,
    expectedRepositoryFullName: string,
  ) => Readonly<{
    repositoryFullName: string;
    repositoryId: string;
  }>;

  expect(admitBoundRepository({
    data: {
      repository: {
        id: repositoryId,
        nameWithOwner: repositoryFullName,
      },
    },
  }, repositoryFullName)).toEqual({
    repositoryFullName,
    repositoryId,
  });

  expect(() => admitBoundRepository({
    data: {
      repository: {
        id: repositoryId,
        nameWithOwner: "teamleaderleo/other-repository",
      },
    },
  }, repositoryFullName)).toThrow();
});

test("builds CAS only from a repository-bound lookup receipt", () => {
  const buildBoundCas = buildGitHubUpdateRefsCasRequest as unknown as (
    input: Omit<
      GitHubUpdateRefsCasInput,
      "repositoryFullName" | "repositoryId"
    > & {
      repository: Readonly<{
        repositoryFullName: string;
        repositoryId: string;
      }>;
    },
  ) => unknown;

  expect(() => buildBoundCas({
    apiBaseUrl: "https://api.github.com",
    repository: Object.freeze({ repositoryFullName, repositoryId }),
    targetRef,
    expectedHeadSha,
    newHeadSha,
  })).not.toThrow();
});
