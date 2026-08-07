import { describe, expect, test } from "bun:test";
import {
  publishGitHubRepositoryWriteAtomically,
} from "../src/github-rest-repository-write-atomic-publication.ts";

const apiBaseUrl = "https://api.github.test";
const repositoryFullName = "teamleaderleo/stensibly";
const targetRef = "topic/tree-prelimit";
const path = "docs/tree-prelimit.md";
const expectedParentSha = "1".repeat(40);
const parentTreeSha = "2".repeat(40);
const repositoryRoot = `${apiBaseUrl}/repos/teamleaderleo/stensibly`;

describe("atomic repository tree admission prelimit", () => {
  test("rejects an oversized tree from length before caller key enumeration", async () => {
    let ownKeysCalls = 0;
    const oversized = new Proxy(new Array(100_001), {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("provider tree keys must not be enumerated before length admission");
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
        message: "Bound tree admission",
      },
      async request(input) {
        operations.push(input.operation);
        return Response.json({}, { status: 200 });
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
            tree: oversized,
          };
        }
        throw new Error(`unexpected operation: ${operation}`);
      },
      discardResponse() {},
      admitRequestId() {
        return null;
      },
    })).rejects.toThrow("GitHub expected parent tree entries were malformed");

    expect(ownKeysCalls).toBe(0);
    expect(operations).toEqual([
      "read expected parent commit",
      "read expected parent tree",
    ]);
  });
});
