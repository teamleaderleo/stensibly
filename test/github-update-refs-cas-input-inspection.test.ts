import { expect, test } from "bun:test";
import {
  admitGitHubRepositoryNodeIdResponse,
  buildGitHubUpdateRefsCasRequest,
} from "../src/github-update-refs-cas.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const repositoryId = "R_kgDOAtomicRepository";

function repositoryIdentity() {
  return admitGitHubRepositoryNodeIdResponse({
    data: {
      repository: {
        id: repositoryId,
        nameWithOwner: repositoryFullName,
      },
    },
  }, repositoryFullName);
}

function baseInput(repository = repositoryIdentity()) {
  return {
    apiBaseUrl: "https://api.github.com",
    repository,
    targetRef: "feature/exact-cas",
    expectedHeadSha: "a".repeat(40),
    newHeadSha: "b".repeat(40),
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
          name: "refs/heads/feature/exact-cas",
          beforeOid: "a".repeat(40),
          afterOid: "b".repeat(40),
          force: false,
        }],
        clientMutationId: request.clientMutationId,
      },
    },
  });
  expect(getCalls).toBe(0);
  expect(ownKeysCalls).toBe(0);
});

test("rejects a Proxy wrapper around an admitted repository receipt without invoking traps", () => {
  let getCalls = 0;
  let ownKeysCalls = 0;
  const proxied = new Proxy(repositoryIdentity(), {
    get() {
      getCalls += 1;
      throw new Error("repository get must not run");
    },
    ownKeys() {
      ownKeysCalls += 1;
      throw new Error("repository ownKeys must not run");
    },
  });

  expect(() => buildGitHubUpdateRefsCasRequest(baseInput(proxied)))
    .toThrow("GitHub updateRefs CAS input is invalid");
  expect(getCalls).toBe(0);
  expect(ownKeysCalls).toBe(0);
});

test("rejects accessor-backed forged repository identity without invoking getters", () => {
  let getterCalls = 0;
  const forged = {
    repositoryFullName,
    repositoryId,
  } as Record<string, unknown>;
  Object.defineProperty(forged, "repositoryId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return repositoryId;
    },
  });

  expect(() => buildGitHubUpdateRefsCasRequest(baseInput(forged as never)))
    .toThrow("GitHub updateRefs CAS input is invalid");
  expect(getterCalls).toBe(0);
});

test("normalizes revoked top-level and repository inputs", () => {
  const revokedInput = Proxy.revocable(baseInput(), {});
  revokedInput.revoke();
  expect(() => buildGitHubUpdateRefsCasRequest(revokedInput.proxy))
    .toThrow("GitHub updateRefs CAS input is invalid");

  const revokedRepository = Proxy.revocable(repositoryIdentity(), {});
  revokedRepository.revoke();
  expect(() => buildGitHubUpdateRefsCasRequest(baseInput(revokedRepository.proxy)))
    .toThrow("GitHub updateRefs CAS input is invalid");
});
