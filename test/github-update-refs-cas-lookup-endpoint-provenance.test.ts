import { expect, test } from "bun:test";
import {
  admitGitHubRepositoryNodeIdResponse,
  buildGitHubRepositoryNodeIdRequest,
} from "../src/github-update-refs-cas.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const repositoryId = "R_kgDOAtomicRepository";
const response = {
  data: {
    repository: { id: repositoryId, nameWithOwner: repositoryFullName },
  },
};

test("response admission requires the exact compiler-built lookup object", () => {
  const lookupA = buildGitHubRepositoryNodeIdRequest(
    "https://api.github.com",
    repositoryFullName,
  );
  expect(admitGitHubRepositoryNodeIdResponse(response, lookupA).graphqlUrl)
    .toBe("https://api.github.com/graphql");

  const lookupB = buildGitHubRepositoryNodeIdRequest(
    "https://github.example.com/api/v3",
    repositoryFullName,
  );
  expect(admitGitHubRepositoryNodeIdResponse(response, lookupB).graphqlUrl)
    .toBe("https://github.example.com/api/graphql");

  expect(() => admitGitHubRepositoryNodeIdResponse(response, {
    url: lookupB.url,
    body: lookupA.body,
  })).toThrow("GitHub updateRefs GraphQL response is invalid");
});

test("wrapping a valid lookup does not execute caller traps or preserve provenance", () => {
  const lookup = buildGitHubRepositoryNodeIdRequest(
    "https://api.github.com",
    repositoryFullName,
  );
  let getCalls = 0;
  let ownKeysCalls = 0;
  const wrapped = new Proxy(lookup, {
    get() {
      getCalls += 1;
      throw new Error("lookup get must not run");
    },
    ownKeys() {
      ownKeysCalls += 1;
      throw new Error("lookup ownKeys must not run");
    },
  });

  expect(() => admitGitHubRepositoryNodeIdResponse(response, wrapped))
    .toThrow("GitHub updateRefs GraphQL response is invalid");
  expect(getCalls).toBe(0);
  expect(ownKeysCalls).toBe(0);
});
