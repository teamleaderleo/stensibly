import { describe, expect, test } from "bun:test";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts.ts";
import type { GitHubIssueProviderWriteService } from "../src/github-issue-provider-mcp.ts";
import {
  GitHubOutboundTextPreflightWriteService,
} from "../src/github-issue-provider-outbound-text.ts";
import {
  GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
  type GitHubOutboundTextPolicyV1,
} from "../src/github-outbound-text-preflight.ts";

const repository = "teamleaderleo/stensibly";
const receipt = Object.freeze({ id: "inspection-receipt" }) as unknown as GitHubProviderReceipt;

describe("GitHub issue-create outbound snapshot inspection", () => {
  test("normalizes a revoked create envelope without delegation", async () => {
    const { service, calls } = recordingService();
    const guarded = new GitHubOutboundTextPreflightWriteService(
      service,
      policy(),
    );
    const { proxy, revoke } = Proxy.revocable({
      project: "github-dogfood",
      repository,
      actorId: "api-token:writer",
      clientId: "mcp:api-token:writer",
      title: "Prepare the internal release note",
      idempotencyKey: "outbound-revoked-create-input-1",
    }, {});
    revoke();

    await expect(guarded.createIssue(
      proxy as Parameters<GitHubIssueProviderWriteService["createIssue"]>[0],
    )).rejects.toThrow("GitHub issue create input could not be inspected");
    expect(calls).toEqual([]);
  });

  test("normalizes hostile create-list prototype inspection", async () => {
    const { service, calls } = recordingService();
    const guarded = new GitHubOutboundTextPreflightWriteService(
      service,
      policy(),
    );
    const labels = new Proxy(["area:github"], {
      getPrototypeOf() {
        throw new Error("github_pat_must_not_escape");
      },
    });

    await expect(guarded.createIssue({
      project: "github-dogfood",
      repository,
      actorId: "api-token:writer",
      clientId: "mcp:api-token:writer",
      title: "Prepare the internal release note",
      labels,
      idempotencyKey: "outbound-hostile-create-list-1",
    })).rejects.toThrow("GitHub issue create labels could not be inspected");
    expect(calls).toEqual([]);
  });

  test("normalizes a revoked policy envelope at construction", () => {
    const { service, calls } = recordingService();
    const { proxy, revoke } = Proxy.revocable(policy(), {});
    revoke();

    expect(() => new GitHubOutboundTextPreflightWriteService(
      service,
      proxy as GitHubOutboundTextPolicyV1,
    )).toThrow("GitHub outbound text policy could not be inspected");
    expect(calls).toEqual([]);
  });

  test("normalizes hostile controlled-repository prototype inspection", () => {
    const { service, calls } = recordingService();
    const controlledRepositories = new Proxy([repository], {
      getPrototypeOf() {
        throw new Error("authorization: must not escape");
      },
    });

    expect(() => new GitHubOutboundTextPreflightWriteService(
      service,
      {
        version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
        policyId: "github-dogfood-outbound-inspection-v1",
        controlledRepositories,
        externalReferenceDisposition: "reject",
      },
    )).toThrow("GitHub outbound controlled repositories could not be inspected");
    expect(calls).toEqual([]);
  });
});

function policy(): GitHubOutboundTextPolicyV1 {
  return Object.freeze({
    version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policyId: "github-dogfood-outbound-inspection-v1",
    controlledRepositories: Object.freeze([repository]),
    externalReferenceDisposition: "reject",
  });
}

function recordingService(): {
  service: GitHubIssueProviderWriteService;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    service: {
      async createIssue() {
        calls.push("create");
        return receipt;
      },
      async updateIssue() {
        calls.push("update");
        return receipt;
      },
      async addIssueComment() {
        calls.push("comment");
        return receipt;
      },
    },
  };
}
