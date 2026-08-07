import { describe, expect, test } from "bun:test";
import {
  publishGitHubRepositoryWriteAtomically,
} from "../src/github-rest-repository-write-atomic-publication.ts";

const apiBaseUrl = "https://api.github.test";
const repositoryFullName = "teamleaderleo/stensibly";
const targetRef = "topic/record-ownkeys";
const path = "docs/record-ownkeys.md";
const expectedParentSha = "1".repeat(40);
const parentTreeSha = "2".repeat(40);
const repositoryRoot = `${apiBaseUrl}/repos/teamleaderleo/stensibly`;

describe("atomic repository fixed-record admission", () => {
  test("reads declared parent-commit fields without caller key enumeration", async () => {
    let ownKeysCalls = 0;
    const parentCommit = new Proxy({
      sha: expectedParentSha,
      url: `${repositoryRoot}/git/commits/${expectedParentSha}`,
      tree: {
        sha: parentTreeSha,
        url: `${repositoryRoot}/git/trees/${parentTreeSha}`,
      },
    }, {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("provider record keys must not be enumerated");
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
        content: "bounded record\n",
        message: "Bound fixed record admission",
      },
      async request(input) {
        operations.push(input.operation);
        if (input.operation === "read expected parent commit") {
          return Response.json({}, { status: 200 });
        }
        throw new Error("record admission completed");
      },
      async readJson(_response, operation) {
        if (operation === "read expected parent commit") return parentCommit;
        throw new Error(`unexpected read: ${operation}`);
      },
      discardResponse() {},
      admitRequestId() {
        return null;
      },
    })).rejects.toThrow("record admission completed");

    expect(ownKeysCalls).toBe(0);
    expect(operations).toEqual([
      "read expected parent commit",
      "read expected parent tree",
    ]);
  });
});
