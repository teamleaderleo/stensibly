import { describe, expect, test } from "bun:test";
import {
  admitGitHubRepositoryNodeIdResponse,
  admitGitHubUpdateRefsCasResponse,
  buildGitHubRepositoryNodeIdRequest,
  buildGitHubUpdateRefsCasRequest,
  githubGraphqlUrl,
} from "../src/github-update-refs-cas.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const repositoryId = "R_kgDOAtomicRepository";
const targetRef = "feature/exact-cas";
const sha1Parent = "a".repeat(40);
const sha1Commit = "b".repeat(40);
const sha256Parent = "c".repeat(64);
const sha256Commit = "d".repeat(64);

function sha1Request() {
  return buildGitHubUpdateRefsCasRequest({
    apiBaseUrl: "https://api.github.com",
    repositoryFullName,
    repositoryId,
    targetRef,
    expectedHeadSha: sha1Parent,
    newHeadSha: sha1Commit,
  });
}

describe("GitHub updateRefs exact-old-ref CAS", () => {
  test("builds exact github.com repository node query", () => {
    const request = buildGitHubRepositoryNodeIdRequest(
      "https://api.github.com",
      repositoryFullName,
    );
    expect(request.url.href).toBe("https://api.github.com/graphql");
    expect(request.body).toEqual({
      query: "query StensiblyRepositoryNodeId($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }",
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

  test("admits exact repository node identity and rejects GraphQL errors", () => {
    expect(admitGitHubRepositoryNodeIdResponse({
      data: { repository: { id: repositoryId } },
    })).toBe(repositoryId);

    expect(() => admitGitHubRepositoryNodeIdResponse({
      data: { repository: { id: repositoryId } },
      errors: [{ message: "provider detail" }],
    })).toThrow("GitHub could not read repository node identity");

    expect(() => admitGitHubRepositoryNodeIdResponse({
      data: { repository: { id: "bad node id with spaces" } },
    })).toThrow("GitHub updateRefs GraphQL response is invalid");
  });

  test("builds exact SHA-1 updateRefs compare-and-swap request", () => {
    const request = sha1Request();
    expect(request.url.href).toBe("https://api.github.com/graphql");
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
    expect(() => buildGitHubUpdateRefsCasRequest({
      apiBaseUrl: "https://api.github.com",
      repositoryFullName,
      repositoryId,
      targetRef,
      expectedHeadSha: sha256Parent,
      newHeadSha: sha256Commit,
    })).not.toThrow();

    expect(() => buildGitHubUpdateRefsCasRequest({
      apiBaseUrl: "https://api.github.com",
      repositoryFullName,
      repositoryId,
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

  test("keeps every GraphQL mutation error generic without retaining provider prose", () => {
    const clientMutationId = sha1Request().clientMutationId;
    const values = [
      {
        data: { updateRefs: null },
        errors: [{
          message: "provider stale ref detail must never be echoed",
          type: "STALE_REF",
          path: ["updateRefs"],
        }],
      },
      {
        data: { updateRefs: null },
        errors: [{ message: "other", type: "OTHER" }],
      },
      {
        data: { updateRefs: null },
        errors: [
          { message: "stale", type: "STALE_REF" },
          { message: "other", type: "OTHER" },
        ],
      },
    ];
    for (const value of values) {
      let caught: unknown;
      try {
        admitGitHubUpdateRefsCasResponse(value, clientMutationId);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("GitHub could not publish repository ref");
      expect(JSON.stringify(caught)).not.toContain("provider stale ref detail");
    }
  });

  test("does not invoke caller ownKeys or getters for admitted fixed records", () => {
    let ownKeysCalls = 0;
    let getCalls = 0;
    const repository = new Proxy({ id: repositoryId }, {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("ownKeys must not run");
      },
      get() {
        getCalls += 1;
        throw new Error("get must not run");
      },
    });
    const data = new Proxy({ repository }, {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("ownKeys must not run");
      },
      get() {
        getCalls += 1;
        throw new Error("get must not run");
      },
    });
    const envelope = new Proxy({ data }, {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("ownKeys must not run");
      },
      get() {
        getCalls += 1;
        throw new Error("get must not run");
      },
    });
    expect(admitGitHubRepositoryNodeIdResponse(envelope)).toBe(repositoryId);
    expect(ownKeysCalls).toBe(0);
    expect(getCalls).toBe(0);
  });

  test("rejects credentialed, queried, or fragmented API bases", () => {
    for (const value of [
      "https://user:credential@api.github.com",
      "https://api.github.com?token=value",
      "https://api.github.com/#fragment",
      "ftp://api.github.com",
    ]) {
      expect(() => githubGraphqlUrl(value)).toThrow("GitHub API base URL is invalid");
    }
  });
});