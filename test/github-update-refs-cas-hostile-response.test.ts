import { expect, test } from "bun:test";
import {
  admitGitHubRepositoryNodeIdResponse,
  admitGitHubUpdateRefsCasResponse,
} from "../src/github-update-refs-cas.ts";

const clientMutationId = `stensibly-write-${"b".repeat(64)}`;

test("normalizes revoked repository-node response proxies", () => {
  const revocable = Proxy.revocable({
    data: { repository: { id: "R_kgDORepository" } },
  }, {});
  revocable.revoke();
  expect(() => admitGitHubRepositoryNodeIdResponse(revocable.proxy))
    .toThrow("GitHub updateRefs GraphQL response is invalid");
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