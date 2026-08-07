import { expect, test } from "bun:test";
import {
  admitGitHubRepositoryNodeIdResponse,
  buildGitHubUpdateRefsCasRequest,
} from "../src/github-update-refs-cas.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const repositoryId = "R_kgDOAtomicRepository";
const baseInput = {
  targetRef: "feature/exact-cas",
  expectedHeadSha: "a".repeat(40),
  newHeadSha: "b".repeat(40),
};

function admittedRepository() {
  return admitGitHubRepositoryNodeIdResponse({
    data: {
      repository: {
        id: repositoryId,
        nameWithOwner: repositoryFullName,
      },
    },
  }, "https://api.github.com", repositoryFullName);
}

test("builds CAS request without top-level caller get or ownKeys", () => {
  const repository = admittedRepository();
  let getCalls = 0;
  let ownKeysCalls = 0;
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
  expect(request.url.href).toBe(repository.graphqlUrl);
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

test("rejects forged or wrapped repository receipts without caller execution", () => {
  const repository = admittedRepository();
  expect(() => buildGitHubUpdateRefsCasRequest({
    ...baseInput,
    repository: { ...repository },
  })).toThrow("GitHub updateRefs CAS input is invalid");

  let getCalls = 0;
  let ownKeysCalls = 0;
  const wrapped = new Proxy(repository, {
    get() {
      getCalls += 1;
      throw new Error("repository get must not run");
    },
    ownKeys() {
      ownKeysCalls += 1;
      throw new Error("repository ownKeys must not run");
    },
  });
  expect(() => buildGitHubUpdateRefsCasRequest({
    ...baseInput,
    repository: wrapped,
  })).toThrow("GitHub updateRefs CAS input is invalid");
  expect(getCalls).toBe(0);
  expect(ownKeysCalls).toBe(0);
});

test("normalizes a revoked top-level CAS input", () => {
  const revoked = Proxy.revocable({
    ...baseInput,
    repository: admittedRepository(),
  }, {});
  revoked.revoke();
  expect(() => buildGitHubUpdateRefsCasRequest(revoked.proxy))
    .toThrow("GitHub updateRefs CAS input is invalid");
});
