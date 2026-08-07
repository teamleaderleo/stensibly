import { expect, test } from "bun:test";
import {
  admitGitHubRepositoryNodeIdResponse,
  buildGitHubUpdateRefsCasRequest,
} from "../src/github-update-refs-cas.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const repositoryId = "R_kgDOAtomicRepository";
const targetRef = "feature/exact-cas";
const expectedHeadSha = "a".repeat(40);
const newHeadSha = "b".repeat(40);

function repositoryIdentity() {
  return admitGitHubRepositoryNodeIdResponse({
    data: {
      repository: {
        repositoryFullName,
        id: repositoryId,
        nameWithOwner: repositoryFullName,
      },
    },
  }, repositoryFullName);
}

function baseInput() {
  return {
    apiBaseUrl: "https://api.github.com",
    repository: repositoryIdentity(),
    targetRef,
    expectedHeadSha,
    newHeadSha,
  };
}

test("builds CAS request without caller get or ownKeys", () => {
  let getCalls = 0;
  let ownKeysCalls = 0;
  const input = new Proxy(baseInput(), {
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
          name: `refs/heads/${targetRef}`,
          beforeOid: expectedHeadSha,
          afterOid: newHeadSha,
          force: false,
        }],
        clientMutationId: request.clientMutationId,
      },
    },
  });
  expect(getCalls).toBe(0);
  expect(ownKeysCalls).toBe(0);
});

test("rejects accessor-backed fabricated repository identity without invoking getters", () => {
  let getterCalls = 0;
  const repository = {
    repositoryFullName,
  } as Record<string, unknown>;
  Object.defineProperty(repository, "repositoryId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return repositoryId;
    },
  });

  expect(() => buildGitHubUpdateRefsCasRequest({
    ...baseInput(),
    repository: repository as never,
  })).toThrow("GitHub updateRefs CAS input is invalid");
  expect(getterCalls).toBe(0);
});

test("normalizes revoked top-level and rejects revoked lookalike repository inputs", () => {
  const revokedInput = Proxy.revocable(baseInput(), {});
  revokedInput.revoke();
  expect(() => buildGitHubUpdateRefsCasRequest(revokedInput.proxy))
    .toThrow("GitHub updateRefs CAS input is invalid");

  const revokedRepository = Proxy.revocable({
    repositoryFullName,
    repositoryId,
  }, {});
  revokedRepository.revoke();
  expect(() => buildGitHubUpdateRefsCasRequest({
    ...baseInput(),
    repository: revokedRepository.proxy as never,
  })).toThrow("GitHub updateRefs CAS input is invalid");
});
