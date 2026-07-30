import { describe, expect, test } from "bun:test";
import {
  digestGitHubWebhookPayload,
  mapGitHubRepositoryWebhook,
  type GitHubRepositoryObservation,
} from "../src/github-repository-observation.ts";

const repository = "teamleaderleo/stensibly";
const before = "1".repeat(40);
const after = "2".repeat(40);
const baseRevision = "3".repeat(40);
const mergeRevision = "4".repeat(40);

function map(
  eventType: string,
  payload: Record<string, unknown>,
  deliveryId = `delivery-${eventType}`,
  receivedAt = "2026-07-30T18:00:00.000Z",
): GitHubRepositoryObservation | null {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  return mapGitHubRepositoryWebhook({
    eventType,
    deliveryId,
    payloadDigest: digestGitHubWebhookPayload(body),
    payload,
    signatureVerified: true,
    receivedAt,
    expectedRepository: repository,
  });
}

function common(): Record<string, unknown> {
  return {
    repository: { full_name: repository },
    sender: { login: "github-actions[bot]" },
  };
}

describe("GitHub repository observations", () => {
  test("maps pushes without retaining commit prose, paths, or raw payloads", () => {
    const observation = map("push", {
      ...common(),
      ref: "refs/heads/main",
      before,
      after,
      created: false,
      deleted: false,
      forced: false,
      size: 2,
      head_commit: {
        timestamp: "2026-07-30T17:59:00.000Z",
        message: "secret commit prose",
      },
      commits: [{
        id: after,
        message: "another secret",
        added: ["private/path.ts"],
      }],
    })!;

    expect(observation).toMatchObject({
      version: 1,
      provider: "github",
      eventType: "push",
      action: "pushed",
      repository,
      actor: "github-actions[bot]",
      subject: {
        kind: "revision",
        externalId: `github:${repository}@${after}`,
      },
      relationships: {
        revision: after,
        previousRevision: before,
        ref: "refs/heads/main",
        refType: "branch",
      },
      facts: {
        commitCount: 2,
        created: false,
        deleted: false,
        forced: false,
      },
      sourceTime: "2026-07-30T17:59:00.000Z",
      sourceTimeSource: "provider",
      containsRawContent: false,
    });
    const serialized = JSON.stringify(observation);
    expect(serialized).not.toContain("secret commit prose");
    expect(serialized).not.toContain("private/path.ts");
    expect(serialized).not.toContain("commits");
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.relationships)).toBe(true);
    expect(Object.isFrozen(observation.facts)).toBe(true);
  });

  test("uses delivery identity separately from semantic identity", () => {
    const payload = {
      ...common(),
      ref: "refs/heads/main",
      before,
      after,
      size: 1,
      head_commit: { timestamp: "2026-07-30T17:59:00.000Z" },
    };
    const first = map("push", payload, "delivery-one")!;
    const second = map(
      "push",
      payload,
      "delivery-two",
      "2026-07-30T18:05:00.000Z",
    )!;

    expect(first.observationId).not.toBe(second.observationId);
    expect(first.deliveryId).not.toBe(second.deliveryId);
    expect(first.semanticFingerprint).toBe(second.semanticFingerprint);
    expect(first.payloadDigest).toBe(second.payloadDigest);
  });

  test("maps branch creation and deletion as ref observations", () => {
    const created = map("create", {
      ...common(),
      ref: "feature/github-observations",
      ref_type: "branch",
      description: "excluded repository prose",
    })!;
    const deleted = map("delete", {
      ...common(),
      ref: "feature/github-observations",
      ref_type: "branch",
    })!;

    expect(created).toMatchObject({
      action: "created",
      subject: {
        kind: "ref",
        externalId:
          `github:${repository}@refs/heads/feature/github-observations`,
      },
      relationships: {
        ref: "refs/heads/feature/github-observations",
        refType: "branch",
      },
      sourceTimeSource: "received",
    });
    expect(deleted.action).toBe("deleted");
    expect(JSON.stringify(created)).not.toContain("excluded repository prose");
  });

  test("maps pull request lifecycle state with content revisions only", () => {
    const observation = map("pull_request", {
      ...common(),
      action: "synchronize",
      number: 591,
      pull_request: {
        number: 591,
        state: "open",
        draft: true,
        locked: false,
        merged: false,
        updated_at: "2026-07-30T18:01:00.000Z",
        title: "Private draft title",
        body: "Private draft body\r\nwith detail",
        head: { sha: after },
        base: { sha: baseRevision },
        merge_commit_sha: mergeRevision,
      },
    })!;

    expect(observation).toMatchObject({
      eventType: "pull_request",
      action: "synchronize",
      subject: {
        kind: "pull_request",
        externalId: `github:${repository}#pull/591`,
      },
      relationships: {
        revision: after,
        baseRevision,
        mergeRevision,
        pullRequestNumber: 591,
        issueNumber: 591,
      },
      facts: {
        draft: true,
        locked: false,
        merged: false,
        state: "open",
      },
    });
    expect(observation.contentRevisions.map((entry) => entry.name)).toEqual([
      "body",
      "title",
    ]);
    expect(observation.contentRevisions.every((entry) => entry.present)).toBe(true);
    expect(JSON.stringify(observation)).not.toContain("Private draft title");
    expect(JSON.stringify(observation)).not.toContain("Private draft body");
  });

  test("maps issue and comment updates with deletion tombstones", () => {
    const issue = map("issues", {
      ...common(),
      action: "edited",
      issue: {
        number: 591,
        state: "open",
        state_reason: null,
        locked: false,
        updated_at: "2026-07-30T18:02:00.000Z",
        title: "Investigate GitHub listening",
        body: "Design notes",
      },
    })!;
    const comment = map("issue_comment", {
      ...common(),
      action: "deleted",
      issue: {
        number: 591,
        pull_request: {},
      },
      comment: {
        id: 9007199254740993n.toString(),
        body: "Deleted comment content",
        created_at: "2026-07-30T18:03:00.000Z",
        updated_at: "2026-07-30T18:04:00.000Z",
      },
    })!;

    expect(issue).toMatchObject({
      action: "edited",
      subject: {
        kind: "issue",
        externalId: `github:${repository}#issue/591`,
      },
      relationships: { issueNumber: 591 },
    });
    expect(comment).toMatchObject({
      action: "deleted",
      subject: {
        kind: "issue_comment",
        externalId:
          `github:${repository}#issue/591/comment/9007199254740993`,
      },
      relationships: {
        issueNumber: 591,
        pullRequestNumber: 591,
        commentId: "9007199254740993",
      },
      facts: { onPullRequest: true },
    });
    expect(comment.contentRevisions).toHaveLength(1);
    expect(comment.contentRevisions[0]?.name).toBe("comment_body");
    expect(JSON.stringify(comment)).not.toContain("Deleted comment content");
  });

  test("canonicalizes line endings before content fingerprinting", () => {
    const withCrLf = map("issues", {
      ...common(),
      action: "edited",
      issue: {
        number: 1,
        state: "open",
        updated_at: "2026-07-30T18:02:00.000Z",
        title: "Title",
        body: "one\r\ntwo",
      },
    }, "delivery-crlf")!;
    const withLf = map("issues", {
      ...common(),
      action: "edited",
      issue: {
        number: 1,
        state: "open",
        updated_at: "2026-07-30T18:02:00.000Z",
        title: "Title",
        body: "one\ntwo",
      },
    }, "delivery-lf")!;

    expect(withCrLf.semanticFingerprint).toBe(withLf.semanticFingerprint);
  });

  test("rejects unverified and cross-repository payloads", () => {
    const payload = {
      ...common(),
      ref: "refs/heads/main",
      before,
      after,
    };
    expect(() => mapGitHubRepositoryWebhook({
      eventType: "push",
      deliveryId: "delivery-unverified",
      payloadDigest: digestGitHubWebhookPayload(
        new TextEncoder().encode(JSON.stringify(payload)),
      ),
      payload,
      signatureVerified: false,
      receivedAt: "2026-07-30T18:00:00.000Z",
    })).toThrow("verified webhook signature");

    expect(() => mapGitHubRepositoryWebhook({
      eventType: "push",
      deliveryId: "delivery-cross-repository",
      payloadDigest: digestGitHubWebhookPayload(
        new TextEncoder().encode(JSON.stringify(payload)),
      ),
      payload,
      signatureVerified: true,
      receivedAt: "2026-07-30T18:00:00.000Z",
      expectedRepository: "teamleaderleo/proofwake",
    })).toThrow("does not match teamleaderleo/proofwake");
  });

  test("ignores unsupported event families after signature verification", () => {
    expect(map("ping", common())).toBeNull();
  });
});
