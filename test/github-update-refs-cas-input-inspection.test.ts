import { expect, test } from "bun:test";
import {
  buildGitHubUpdateRefsCasRequest,
  githubGraphqlUrl,
} from "../src/github-update-refs-cas.ts";

const baseInput = {
  apiBaseUrl: "https://api.github.com",
  repositoryFullName: "teamleaderleo/stensibly",
  repositoryId: "R_kgDOAtomicRepository",
  targetRef: "feature/exact-cas",
  expectedHeadSha: "a".repeat(40),
  newHeadSha: "b".repeat(40),
};

test("builds CAS request without caller get or ownKeys", () => {
  let getCalls = 0;
  let ownKeysCalls = 0;
  const input = new Proxy(baseInput, {
    get() {
      getCalls += 1;
      throw new Error("caller get must not run");
    },
    ownKeys() {
      ownKeysCalls += 1;
      throw new Error("caller ownKeys must not run");
    },
  });

  expect(buildGitHubUpdateRefsCasRequest(input).body).toEqual({
    query: "mutation StensiblyUpdateRefs($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
    variables: {
      input: {
        repositoryId: baseInput.repositoryId,
        refUpdates: [{
          name: `refs/heads/${baseInput.targetRef}`,
          beforeOid: baseInput.expectedHeadSha,
          afterOid: baseInput.newHeadSha,
          force: false,
        }],
        clientMutationId: expect.stringMatching(/^stensibly-write-[a-f0-9]{64}$/),
      },
    },
  });
  expect(getCalls).toBe(0);
  expect(ownKeysCalls).toBe(0);
});

test("rejects accessor-backed CAS fields without invoking getters", () => {
  let getterCalls = 0;
  const input = { ...baseInput } as Record<string, unknown>;
  Object.defineProperty(input, "repositoryId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return baseInput.repositoryId;
    },
  });

  expect(() => buildGitHubUpdateRefsCasRequest(input as never))
    .toThrow("GitHub updateRefs CAS input is invalid");
  expect(getterCalls).toBe(0);
});

test("normalizes revoked CAS request proxies", () => {
  const revocable = Proxy.revocable({ ...baseInput }, {});
  revocable.revoke();
  expect(() => buildGitHubUpdateRefsCasRequest(revocable.proxy as never))
    .toThrow("GitHub updateRefs CAS input is invalid");
});

test("rejects non-string API bases without conversion hooks", () => {
  let conversionCalls = 0;
  const hostile = {
    toString() {
      conversionCalls += 1;
      throw new Error("must not convert");
    },
  };
  expect(() => githubGraphqlUrl(hostile as never))
    .toThrow("GitHub API base URL is invalid");
  expect(conversionCalls).toBe(0);
});