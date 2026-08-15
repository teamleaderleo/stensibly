import { describe, expect, test } from "bun:test";
import { buildGitHubIssueContext } from "../src/github-issue-context.ts";
import {
  classifyGitHubMailReply,
  type GitHubConversationCommentEffect,
  type GitHubMailThreadBinding,
} from "../src/github-mail-bridge.ts";
import {
  executeGovernedGitHubMailCommentProjection,
  GitHubMailOutboundTextRejectedError,
  GitHubMailStaleHeadError,
  type GitHubMailPullRequestProvider,
} from "../src/github-mail-comment-projection.ts";
import type {
  GitHubProviderReceipt,
  GitHubProviderRequestContext,
} from "../src/github-provider-contracts.ts";
import { canonicalBody, sha256, stableJson } from "../src/github-provider-validation.ts";

const repository = "teamleaderleo/stensibly";
const head = "e".repeat(40);
const base = "f".repeat(40);
const thread: GitHubMailThreadBinding = {
  version: 1,
  threadId: "attn_1491_projection",
  handle: "STN-REVIEW:1491PROJECTION",
  project: "stensibly",
  repository,
  pullRequestNumber: 1491,
  currentHeadRevision: head,
  continuesFromThreadId: null,
};
const context: GitHubProviderRequestContext = {
  project: "stensibly",
  repository,
  actorId: "operator",
  clientId: "github-mail-bridge",
  capabilityGrantId: "grant_comment",
};
const policy = {
  version: 1 as const,
  controlledOwners: ["teamleaderleo"],
  controlledRepositories: [repository],
};

function effectFor(body: string): GitHubConversationCommentEffect {
  const admission = classifyGitHubMailReply({
    thread,
    provider: "gmail",
    mailboxBindingId: "mailbox_primary",
    providerThreadId: "gmail-thread-1491",
    providerMessageId: `gmail-message-${sha256(body).slice(-12)}`,
    inReplyToMessageId: "gmail-message-root",
    replyClass: "mail.github_comment_proposal",
    body,
    expectedTargetSourceRevision: "issue-rev-1",
    expectedHeadRevision: head,
    causal: {
      rootId: "github:pull_request:projection-root",
      predecessorId: "mail:gmail-message-root",
      depth: 1,
      fanOut: 0,
    },
  });
  return admission.effect as GitHubConversationCommentEffect;
}

function providerForBody(
  expectedBody: string,
  currentHeadRevision = head,
): GitHubMailPullRequestProvider {
  return {
    async getPullRequest() {
      return {
        kind: "pull_request" as const,
        number: 1491,
        providerNodeId: "PR_1491",
        title: "Bridge GitHub attention and mail replies",
        head: "lark/1491-mail-bridge",
        headSha: currentHeadRevision,
        base: "main",
        baseSha: base,
        draft: false,
        state: "open" as const,
        canonicalUrl: "https://github.com/teamleaderleo/stensibly/pull/1491",
        createdAt: "2026-08-15T05:53:07.000Z",
        updatedAt: "2026-08-15T06:45:00.000Z",
        bodyRevision: {
          byteLength: 10,
          sha256: sha256("Issue body"),
        },
        sourceRevision: `pr-rev-${currentHeadRevision.slice(0, 12)}`,
        containsBody: false as const,
      };
    },
    async getIssue() {
      return buildGitHubIssueContext({
        owner: "teamleaderleo",
        repository: "stensibly",
        number: 1491,
        title: "Bridge GitHub attention and mail replies",
        body: "Issue body",
        state: "open",
        labels: [],
        assignees: [],
        createdAt: "2026-08-15T05:53:07.000Z",
        updatedAt: "2026-08-15T06:45:00.000Z",
        sourceRevision: "issue-rev-1",
      });
    },
    async addIssueComment(input) {
      const body = canonicalBody(input.body);
      expect(body).toBe(expectedBody);
      const result = {
        id: "9201",
        issueNumber: 1491,
        canonicalUrl:
          "https://github.com/teamleaderleo/stensibly/issues/1491#issuecomment-9201",
        createdAt: "2026-08-15T06:46:00.000Z",
        updatedAt: "2026-08-15T06:46:00.000Z",
        sourceRevision: "comment-rev-9201",
        bodyRevision: {
          byteLength: Buffer.byteLength(body, "utf8"),
          sha256: sha256(body),
        },
        containsBody: false as const,
      };
      const receipt: GitHubProviderReceipt = {
        version: 1,
        id: "ghop_1491_governed_comment",
        project: "stensibly",
        provider: "github",
        repositoryFullName: repository,
        operation: "github_add_issue_comment",
        target: `${repository}#1491:comment:new`,
        actorId: input.actorId,
        clientId: input.clientId,
        connectionId: "gh_connection",
        installationId: "42",
        bindingId: "gh_binding",
        attachmentId: "attachment_1",
        attachmentSnapshotSha256: "sha256:attachment",
        capabilityGrantId: "grant_comment",
        approvalId: null,
        idempotencyKey: input.idempotencyKey,
        parametersSha256: sha256(stableJson({ body })),
        state: "succeeded",
        attemptCount: 1,
        createdAt: "2026-08-15T06:46:00.000Z",
        updatedAt: "2026-08-15T06:46:00.000Z",
        providerRequestId: "github-request-governed-1",
        result,
        verification: {
          state: "passed",
          checkedAt: "2026-08-15T06:46:00.000Z",
          sourceRevision: result.sourceRevision,
        },
        error: null,
        recovery: { nextAction: "none" },
      };
      return receipt;
    },
  };
}

describe("governed GitHub comment projection from mail", () => {
  test("requires an allow receipt over the exact final bytes before provider dispatch", async () => {
    const body = "Repair is complete; details stay inside teamleaderleo/stensibly#1491.";
    const effect = effectFor(body);
    const result = await executeGovernedGitHubMailCommentProjection({
      provider: providerForBody(body),
      context,
      effect,
      body,
      workspace: "internal",
      authorityGeneration: 7,
      outboundPolicy: policy,
      externalContactAuthority: null,
    });
    expect(result.outboundTextReceipt).toMatchObject({
      decision: "allow",
      surface: "comment",
      operationRef: effect.effectId,
      providerDispatchAuthorized: false,
    });
    expect(result.providerEffectReceipt).toMatchObject({
      effectId: effect.effectId,
      providerCommentId: "9201",
      state: "succeeded",
    });
  });

  test("rejects a stale emailed PR head before any GitHub comment write", async () => {
    const body = "Apply this comment only to the exact emailed candidate.";
    const effect = effectFor(body);
    const advancedHead = "a".repeat(40);
    const baseProvider = providerForBody(body, advancedHead);
    let commentWriteCalled = false;
    const provider: GitHubMailPullRequestProvider = {
      ...baseProvider,
      async addIssueComment(input) {
        commentWriteCalled = true;
        return baseProvider.addIssueComment(input);
      },
    };

    try {
      await executeGovernedGitHubMailCommentProjection({
        provider,
        context,
        effect,
        body,
        workspace: "internal",
        authorityGeneration: 7,
        outboundPolicy: policy,
        externalContactAuthority: null,
      });
      throw new Error("expected stale-head rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubMailStaleHeadError);
      expect(error).toMatchObject({
        expectedHeadRevision: head,
        currentHeadRevision: advancedHead,
        recoveryAction: "refresh_mail_handoff_before_retry",
      });
    }
    expect(commentWriteCalled).toBe(false);
  });

  test("rejects an uncontrolled repository reference before any GitHub provider call", async () => {
    const body = "Please also inspect outsider/foreign-repo#42.";
    const effect = effectFor(body);
    let providerCalled = false;
    const provider: GitHubMailPullRequestProvider = {
      async getPullRequest() {
        providerCalled = true;
        throw new Error("provider should stay untouched");
      },
      async getIssue() {
        providerCalled = true;
        throw new Error("provider should stay untouched");
      },
      async addIssueComment() {
        providerCalled = true;
        throw new Error("provider should stay untouched");
      },
    };
    try {
      await executeGovernedGitHubMailCommentProjection({
        provider,
        context,
        effect,
        body,
        workspace: "internal",
        authorityGeneration: 7,
        outboundPolicy: policy,
        externalContactAuthority: null,
      });
      throw new Error("expected outbound text rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubMailOutboundTextRejectedError);
      expect((error as GitHubMailOutboundTextRejectedError).receipt).toMatchObject({
        decision: "reject",
        providerDispatchAuthorized: false,
        referenceCounts: { rejected: 1 },
      });
    }
    expect(providerCalled).toBe(false);
  });
});
