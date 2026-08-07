import { expect, test } from "bun:test";
import { buildGitHubUpdateRefsCasRequest } from "../src/github-update-refs-cas.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const repositoryId = "R_kgDOAtomicRepository";
const baseRepository = {
  repositoryFullName,
  repositoryId,
};
const baseInput = {
  apiBaseUrl: "https://api.github.com",
  repository: baseRepository,
  targetRef: "feature/exact-cas",
  expectedHeadSha: "a".repeat(40),
  newHeadSha: "b".repeat(40),
};

test("builds CAS request without caller get or ownKeys", () => {
  let getCalls = 0;
  let ownKeysCalls = 0;
  const repository = new Proxy(baseRepository, {
    get() {
      getCalls += 1;
      throw new Error("repository get must not run");
    },
    ownKeys() {
      ownKeysCalls += 1;
      throw new Error("repository ownKeys must not run");
    },
  });
  const input = new Proxy({ ...baseInput, repository }, {
    get() {
      getCalls += 1;
      throw new Error("caller get must not run");
    },
    ownKeys() {
      ownKeysCalls += 1;
      throw new Error("caller ownKeys must not run");
    },
  });

  const request = buildGitHubUpdateRefsCasRequest(input);
  expect(request.clientMutationId).toMatch(/^stensibly-write-[a-f0-9]{64}$/);
  expect(request.body).toEqual({
    query: "mutation StensiblyUpdateRefs($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
    variables: {
      input: {
        repositoryId,
        refUpdates: [{
          name: `refs/heads/${baseInput.targetRef}`,
          beforeOid: baseInput.expectedHeadSha,
          afterOid: baseInput.newHeadSha,
          force: false,
        }],
        clientMutationId: request.clientMutationId,
      },
    },
  });
  expect(getCalls).toBe(0);
  expect(ownKeysCalls).toBe(0);
});

test("rejects accessor-backed repository identity without invoking getters", () => {
  let getterCalls = 0;
  const repository = { ...baseRepository } as Record<string, unknown>;
  Object.defineProperty(repository, "repositoryId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return repositoryId;
    },
  });

  expect(() => buildGitHubUpdateRefsCasRequest({
    ...baseInput,
    repository: repository as never,
  })).toThrow("GitHub updateRefs CAS input is invalid");
  expect(getterCalls).toBe(0);
});

test("normalizes revoked top-level and repository inputs", () => {
  const revokedInput = Proxy.revocable(baseInput, {});
  revokedInput.revoke();
  expect(() => buildGitHubUpdateRefsCasRequest(revokedInput.proxy))
    .toThrow("GitHub updateRefs CAS input is invalid");

  const revokedRepository = Proxy.revocable(baseRepository, {});
  revokedRepository.revoke();
  expect(() => buildGitHubUpdateRefsCasRequest({
    ...baseInput,
    repository: revokedRepository.proxy,
  })).toThrow("GitHub updateRefs CAS input is invalid");
});
