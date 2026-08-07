import { expect, test } from "bun:test";
import {
  admitGitHubRepositoryNodeIdResponse,
  buildGitHubRepositoryNodeIdRequest,
} from "../src/github-update-refs-cas.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const repositoryId = "R_kgDOAtomicRepository";

test("repository response admission cannot relabel the lookup endpoint", () => {
  const lookup = buildGitHubRepositoryNodeIdRequest(
    "https://api.github.com",
    repositoryFullName,
  );

  const repository = admitGitHubRepositoryNodeIdResponse({
    data: {
      repository: {
        id: repositoryId,
        nameWithOwner: repositoryFullName,
      },
    },
  }, "https://github.example.com/api/v3", repositoryFullName);

  expect(repository.graphqlUrl).toBe(lookup.url.href);
});
