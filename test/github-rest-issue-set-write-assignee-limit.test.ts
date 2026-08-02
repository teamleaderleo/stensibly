import { describe, expect, test } from "bun:test";
import {
  withGitHubIssueProviderSetWriteService,
} from "../src/github-issue-provider-set-write-service.ts";
import {
  GitHubRestIssueSetWriteAdapter,
} from "../src/github-rest-issue-set-write-adapter.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const assignees = Array.from(
  { length: 11 },
  (_, index) => `reviewer-${index + 1}`,
);

describe("GitHub issue set-write assignee limit", () => {
  test("rejects mounted add and remove requests before service or receipt access", async () => {
    let serviceCalls = 0;
    const mounted = withGitHubIssueProviderSetWriteService({}, {
      async addIssueLabels() {
        throw new Error("outside this control");
      },
      async removeIssueLabel() {
        throw new Error("outside this control");
      },
      async addIssueAssignees() {
        serviceCalls += 1;
        throw new Error("must not reach the provider service");
      },
      async removeIssueAssignees() {
        serviceCalls += 1;
        throw new Error("must not reach the provider service");
      },
    });
    const context = {
      project: "stensibly",
      repository: repositoryFullName,
      actorId: "limit-test",
      clientId: "github-only-test",
      issueNumber: 525,
      assignees,
    };

    await expect(mounted.addIssueAssignees({
      ...context,
      idempotencyKey: "mounted-assignee-limit-add",
    })).rejects.toThrow("requires 1 to 10 unique assignees");
    await expect(mounted.removeIssueAssignees({
      ...context,
      idempotencyKey: "mounted-assignee-limit-remove",
    })).rejects.toThrow("requires 1 to 10 unique assignees");
    expect(serviceCalls).toBe(0);
  });

  test("rejects adapter add and remove requests above ten before token or provider access", async () => {
    let tokenCalls = 0;
    let fetchCalls = 0;
    const adapter = new GitHubRestIssueSetWriteAdapter({
      tokenProvider: {
        async getInstallationToken() {
          tokenCalls += 1;
          return {
            token: "must-not-be-requested",
            expiresAt: "2026-08-03T01:00:00.000Z",
          };
        },
      },
      fetch: (async () => {
        fetchCalls += 1;
        return Response.json({ message: "must not dispatch" }, { status: 500 });
      }) as typeof fetch,
    });

    await expect(adapter.addIssueAssignees({
      repositoryFullName,
      issueNumber: 525,
      assignees,
      idempotencyKey: "assignee-limit-add",
    })).rejects.toThrow("requires 1 to 10 unique assignees");
    await expect(adapter.removeIssueAssignees({
      repositoryFullName,
      issueNumber: 525,
      assignees,
      idempotencyKey: "assignee-limit-remove",
    })).rejects.toThrow("requires 1 to 10 unique assignees");

    expect(tokenCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });
});
