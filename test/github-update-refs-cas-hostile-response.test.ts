import { expect, test } from "bun:test";
import {
  admitGitHubRepositoryNodeIdResponse,
  admitGitHubUpdateRefsCasResponse,
  buildGitHubRepositoryNodeIdRequest,
} from "../src/github-update-refs-cas.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const clientMutationId = `stensibly-write-${"b".repeat(64)}`;
const repositoryRequest = buildGitHubRepositoryNodeIdRequest(
  "https://api.github.com",
  repositoryFullName,
);

test("normalizes revoked repository-node response proxies", () => {
  const revocable = Proxy.revocable({
    data: {
      repository: {
        id: "R_kgDORepository",
        nameWithOwner: repositoryFullName,
      },
    },
  }, {});
  revocable.revoke();
  expect(() => admitGitHubRepositoryNodeIdResponse(
    revocable.proxy,
    repositoryRequest,
  )).toThrow("GitHub updateRefs GraphQL response is invalid");
});

test("normalizes revoked updateRefs response proxies", () => {
  const revocable = Proxy.revocable({
    data: { updateRefs: { clientMutationId } },
  }, {});
  revocable.revoke();
  expect(() => admitGitHubUpdateRefsCasResponse(
    revocable.proxy,
    clientMutationId,
  )).toThrow("GitHub updateRefs GraphQL response is invalid");
});

test("keeps revoked GraphQL error arrays generic", () => {
  const errors = Proxy.revocable([
    { message: "provider stale detail", type: "STALE_REF" },
  ], {});
  errors.revoke();
  expect(() => admitGitHubUpdateRefsCasResponse({
    data: { updateRefs: null },
    errors: errors.proxy,
  }, clientMutationId)).toThrow("GitHub could not publish repository ref");
});
