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

type BoundRepository = Readonly<{
  repositoryFullName: string;
  repositoryId: string;
}>;

const admitBoundRepository = admitGitHubRepositoryNodeIdResponse as unknown as (
  value: unknown,
  expectedRepositoryFullName: string,
) => BoundRepository;

const buildBoundCas = buildGitHubUpdateRefsCasRequest as unknown as (
  input: Omit<
    GitHubUpdateRefsCasInput,
    "repositoryFullName" | "repositoryId"
  > & {
    repository: BoundRepository;
  },
) => unknown;

function providerBoundRepository(): BoundRepository {
  return admitBoundRepository({
    data: {
      repository: {
        id: repositoryId,
        nameWithOwner: repositoryFullName,
      },
    },
  }, repositoryFullName);
}

test("binds the repository node lookup receipt to the requested canonical repository", () => {
  const request = buildGitHubRepositoryNodeIdRequest(
    "https://api.github.com",
    repositoryFullName,
  );
  expect(String(request.body.query)).toContain("nameWithOwner");

  expect(providerBoundRepository()).toEqual({
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

test("builds CAS from the exact provider-admitted repository receipt", () => {
  expect(() => buildBoundCas({
    apiBaseUrl: "https://api.github.com",
    repository: providerBoundRepository(),
    targetRef,
    expectedHeadSha,
    newHeadSha,
  })).not.toThrow();
});

test("rejects a caller-fabricated lookalike repository receipt", () => {
  const forged = Object.freeze({
    repositoryFullName,
    repositoryId,
  });

  expect(() => buildBoundCas({
    apiBaseUrl: "https://api.github.com",
    repository: forged,
    targetRef,
    expectedHeadSha,
    newHeadSha,
  })).toThrow("GitHub updateRefs CAS input is invalid");
});
