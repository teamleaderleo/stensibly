import { describe, expect, test } from "bun:test";
import {
  admitGitHubRepositoryNodeIdResponse,
  admitGitHubUpdateRefsCasResponse,
  buildGitHubRepositoryNodeIdRequest,
  buildGitHubUpdateRefsCasRequest,
  githubGraphqlUrl,
} from "../src/github-update-refs-cas.ts";

const apiBaseUrl = "https://api.github.com";
const graphqlUrl = "https://api.github.com/graphql";
const repositoryFullName = "teamleaderleo/stensibly";
const repositoryId = "R_kgDOAtomicRepository";
const targetRef = "feature/exact-cas";
const sha1Parent = "a".repeat(40);
const sha1Commit = "b".repeat(40);
const sha256Parent = "c".repeat(64);
const sha256Commit = "d".repeat(64);

function admittedRepository(
  base = apiBaseUrl,
  expected = repositoryFullName,
  nameWithOwner = expected,
  id = repositoryId,
) {
  const request = buildGitHubRepositoryNodeIdRequest(base, expected);
  return admitGitHubRepositoryNodeIdResponse({
    data: { repository: { id, nameWithOwner } },
  }, expected, request.url.href);
}

function sha1Request() {
  return buildGitHubUpdateRefsCasRequest({
    repository: admittedRepository(),
    targetRef,
    expectedHeadSha: sha1Parent,
    newHeadSha: sha1Commit,
  });
}

describe("GitHub updateRefs exact-old-ref CAS", () => {
  test("builds exact github.com repository identity query", () => {
    const request = buildGitHubRepositoryNodeIdRequest(
      apiBaseUrl,
      repositoryFullName,
    );
    expect(request.url.href).toBe(graphqlUrl);
    expect(request.body).toEqual({
      query: "query StensiblyRepositoryNodeId($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id nameWithOwner } }",
      variables: { owner: "teamleaderleo", name: "stensibly" },
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.body)).toBe(true);
  });

  test("maps GHES REST API base to GraphQL endpoint", () => {
    expect(githubGraphqlUrl("https://github.example.com/api/v3").href)
      .toBe("https://github.example.com/api/graphql");
    expect(githubGraphqlUrl("https://github.example.com/custom/api").href)
      .toBe("https://github.example.com/custom/api/graphql");
  });

  test("binds endpoint, canonical repository, and node ID in one admitted receipt", () => {
    for (const nameWithOwner of [repositoryFullName, "TeamLeaderLeo/Stensibly"]) {
      const admitted = admittedRepository(
        apiBaseUrl,
        repositoryFullName,
        nameWithOwner,
      );
      expect(admitted).toEqual({ graphqlUrl, repositoryFullName, repositoryId });
      expect(Object.isFrozen(admitted)).toBe(true);
    }

    expect(admittedRepository("https://github.example.com/api/v3")).toEqual({
      graphqlUrl: "https://github.example.com/api/graphql",
      repositoryFullName,
      repositoryId,
    });

    expect(() => admittedRepository(
      apiBaseUrl,
      repositoryFullName,
      "teamleaderleo/other",
    )).toThrow("GitHub updateRefs GraphQL response is invalid");
  });

  test("uses the provider-bound endpoint for exact SHA-1 CAS", () => {
    const request = sha1Request();
    expect(request.url.href).toBe(graphqlUrl);
    expect(request.clientMutationId).toMatch(/^stensibly-write-[a-f0-9]{64}$/);
    expect(request.body).toEqual({
      query: "mutation StensiblyUpdateRefs($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
      variables: {
        input: {
          repositoryId,
          refUpdates: [{
            name: `refs/heads/${targetRef}`,
            beforeOid: sha1Parent,
            afterOid: sha1Commit,
            force: false,
          }],
          clientMutationId: request.clientMutationId,
        },
      },
    });
  });

  test("admits SHA-256 CAS and rejects mixed object formats", () => {
    const repository = admittedRepository();
    expect(() => buildGitHubUpdateRefsCasRequest({
      repository,
      targetRef,
      expectedHeadSha: sha256Parent,
      newHeadSha: sha256Commit,
    })).not.toThrow();

    expect(() => buildGitHubUpdateRefsCasRequest({
      repository,
      targetRef,
      expectedHeadSha: sha1Parent,
      newHeadSha: sha256Commit,
    })).toThrow("GitHub updateRefs object format is invalid");
  });

  test("admits only the exact successful client mutation identity", () => {
    const clientMutationId = sha1Request().clientMutationId;
    expect(admitGitHubUpdateRefsCasResponse({
      data: { updateRefs: { clientMutationId } },
    }, clientMutationId)).toEqual({ clientMutationId });

    expect(() => admitGitHubUpdateRefsCasResponse({
      data: { updateRefs: { clientMutationId: `stensibly-write-${"0".repeat(64)}` } },
    }, clientMutationId)).toThrow("GitHub updateRefs GraphQL response is invalid");
  });

  test("keeps all GraphQL mutation errors generic without provider prose", () => {
    const clientMutationId = sha1Request().clientMutationId;
    for (const value of [
      { data: { updateRefs: null }, errors: [{ message: "stale", type: "STALE_REF" }] },
      { data: { updateRefs: null }, errors: [{ message: "other", type: "OTHER" }] },
    ]) {
      let caught: unknown;
      try {
        admitGitHubUpdateRefsCasResponse(value, clientMutationId);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("GitHub could not publish repository ref");
      expect(JSON.stringify(caught)).not.toContain("stale");
    }
  });

  test("normalizes a revoked GraphQL envelope", () => {
    const revoked = Proxy.revocable({
      data: {
        repository: { id: repositoryId, nameWithOwner: repositoryFullName },
      },
    }, {});
    revoked.revoke();
    expect(() => admitGitHubRepositoryNodeIdResponse(
      revoked.proxy,
      repositoryFullName,
      graphqlUrl,
    )).toThrow("GitHub updateRefs GraphQL response is invalid");
  });
});
