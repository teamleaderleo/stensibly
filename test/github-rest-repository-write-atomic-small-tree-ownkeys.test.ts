import { describe, expect, test } from "bun:test";
import {
  publishGitHubRepositoryWriteAtomically,
} from "../src/github-rest-repository-write-atomic-publication.ts";

const apiBaseUrl = "https://api.github.test";
const repositoryFullName = "teamleaderleo/stensibly";
const targetRef = "topic/small-tree-ownkeys";
const path = "docs/small-tree-ownkeys.md";
const expectedParentSha = "1".repeat(40);
const parentTreeSha = "2".repeat(40);
const unrelatedBlobSha = "3".repeat(40);
const repositoryRoot = `${apiBaseUrl}/repos/teamleaderleo/stensibly`;

describe("atomic repository tree small-array admission", () => {
  test("admits dense indices without caller key enumeration", async () => {
    let ownKeysCalls = 0;
    const tree = new Proxy([
      {
        path: "README.md",
        mode: "100644",
        type: "blob",
        sha: unrelatedBlobSha,
        url: `${repositoryRoot}/git/blobs/${unrelatedBlobSha}`,
        size: 10,
      },
    ], {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("provider tree keys must not be enumerated");
      },
    });
    const operations: string[] = [];

    await expect(publishGitHubRepositoryWriteAtomically({
      apiBaseUrl,
      repositoryFullName,
      path,
      targetRef,
      expectedParentSha,
      payload: {
        operation: "create_file",
        content: "bounded tree\n",
        message: "Bound small tree admission",
      },
      async request(input) {
        operations.push(input.operation);
        if (
          input.operation === "read expected parent commit"
          || input.operation === "read expected parent tree"
        ) {
          return Response.json({}, { status: 200 });
        }
        throw new Error("tree admission completed");
      },
      async readJson(_response, operation) {
        if (operation === "read expected parent commit") {
          return {
            sha: expectedParentSha,
            url: `${repositoryRoot}/git/commits/${expectedParentSha}`,
            tree: {
              sha: parentTreeSha,
              url: `${repositoryRoot}/git/trees/${parentTreeSha}`,
            },
          };
        }
        if (operation === "read expected parent tree") {
          return {
            sha: parentTreeSha,
            url: `${repositoryRoot}/git/trees/${parentTreeSha}`,
            truncated: false,
            tree,
          };
        }
        throw new Error(`unexpected read: ${operation}`);
      },
      discardResponse() {},
      admitRequestId() {
        return null;
      },
    })).rejects.toThrow("tree admission completed");

    expect(ownKeysCalls).toBe(0);
    expect(operations.slice(0, 2)).toEqual([
      "read expected parent commit",
      "read expected parent tree",
    ]);
    expect(operations).toHaveLength(3);
  });
});
