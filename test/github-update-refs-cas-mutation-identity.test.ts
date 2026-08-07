import { describe, expect, test } from "bun:test";
import {
  admitGitHubRepositoryNodeIdResponse,
  buildGitHubUpdateRefsCasRequest,
} from "../src/github-update-refs-cas.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const repositoryId = "R_kgDOExample";
const apiBaseUrl = "https://api.github.com";
const targetRef = "topic/exact-cas";
const expectedHeadSha = "1".repeat(40);
const newHeadSha = "abcdef0123456789" + "2".repeat(24);

function repositoryIdentity(
  fullName = repositoryFullName,
  id = repositoryId,
) {
  return admitGitHubRepositoryNodeIdResponse({
    data: { repository: { id, nameWithOwner: fullName } },
  }, fullName);
}

function request(overrides: Partial<{
  apiBaseUrl: string;
  repositoryFullName: string;
  repositoryId: string;
  targetRef: string;
  expectedHeadSha: string;
  newHeadSha: string;
}> = {}) {
  return buildGitHubUpdateRefsCasRequest({
    apiBaseUrl: overrides.apiBaseUrl ?? apiBaseUrl,
    repository: repositoryIdentity(
      overrides.repositoryFullName ?? repositoryFullName,
      overrides.repositoryId ?? repositoryId,
    ),
    targetRef: overrides.targetRef ?? targetRef,
    expectedHeadSha: overrides.expectedHeadSha ?? expectedHeadSha,
    newHeadSha: overrides.newHeadSha ?? newHeadSha,
  });
}

describe("GitHub updateRefs CAS mutation identity", () => {
  test("changes when any exact CAS identity changes", () => {
    const original = request().clientMutationId;
    const variants = [
      { repositoryFullName: "teamleaderleo/other" },
      { repositoryId: "R_kgDOOther" },
      { targetRef: "topic/other" },
      { expectedHeadSha: "3".repeat(40) },
      { newHeadSha: "abcdef0123456789" + "4".repeat(24) },
    ];

    for (const variant of variants) {
      expect(request(variant).clientMutationId).not.toBe(original);
    }
  });

  test("does not collapse distinct full new object IDs behind one public prefix", () => {
    const first = request().clientMutationId;
    const second = request({
      newHeadSha: "abcdef0123456789" + "5".repeat(24),
    }).clientMutationId;

    expect(second).not.toBe(first);
  });
});
