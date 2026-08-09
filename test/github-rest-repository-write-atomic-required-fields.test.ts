import { expect, test } from "bun:test";
import { publishGitHubRepositoryWriteAtomically } from "../src/github-rest-repository-write-atomic-publication.ts";

const apiBaseUrl = "https://api.github.test";
const repositoryFullName = "teamleaderleo/stensibly";
const targetRef = "topic/required-tree-fields";
const targetPath = "docs/required-tree-fields.md";
const parentSha = "1".repeat(40);
const parentTreeSha = "2".repeat(40);
const unrelatedBlobSha = "3".repeat(40);

const repositoryRoot = `${apiBaseUrl}/repos/${repositoryFullName}`;
const commitUrl = `${repositoryRoot}/git/commits/${parentSha}`;
const treeUrl = `${repositoryRoot}/git/trees/${parentTreeSha}`;
const recursiveTreeUrl = `${treeUrl}?recursive=1`;
const unrelatedBlobUrl = `${repositoryRoot}/git/blobs/${unrelatedBlobSha}`;

test("rejects a recursive-tree entry missing required path before later provider activity", async () => {
  const requests: Array<{ method: string; url: string; access: "read" | "write" }> = [];

  await expect(publishGitHubRepositoryWriteAtomically({
    apiBaseUrl,
    repositoryFullName,
    path: targetPath,
    targetRef,
    expectedParentSha: parentSha,
    payload: {
      operation: "create_file",
      content: "required field control\n",
      message: "Create required field control",
    },
    async request(input) {
      requests.push({
        method: input.method,
        url: input.url.href,
        access: input.access,
      });

      if (requests.length === 1) {
        expect(input.url.href).toBe(commitUrl);
        return Response.json({
          sha: parentSha,
          url: commitUrl,
          tree: {
            sha: parentTreeSha,
            url: treeUrl,
          },
        });
      }

      if (requests.length === 2) {
        expect(input.url.href).toBe(recursiveTreeUrl);
        return Response.json({
          sha: parentTreeSha,
          url: treeUrl,
          truncated: false,
          tree: [{
            mode: "100644",
            type: "blob",
            sha: unrelatedBlobSha,
            url: unrelatedBlobUrl,
          }],
        });
      }

      throw new Error("provider activity continued after malformed recursive-tree evidence");
    },
    async readJson(response) {
      return await response.json() as unknown;
    },
    discardResponse() {},
    admitRequestId() {
      return null;
    },
  })).rejects.toThrow("GitHub expected parent tree entry was malformed");

  expect(requests).toEqual([
    { method: "GET", url: commitUrl, access: "read" },
    { method: "GET", url: recursiveTreeUrl, access: "read" },
  ]);
});
