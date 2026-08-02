import { describe, expect, test } from "bun:test";
import {
  buildGitHubReviewThreadReceipt,
  truncateReviewThreadBody,
  type GitHubReviewThreadSourceResult,
} from "../src/github-review-thread-receipt.ts";

const baseComment = {
  id: "comment-1",
  authorLogin: "cedar",
  authorAssociation: "MEMBER",
  body: "review body",
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:01.000Z",
  url: "https://github.com/teamleaderleo/stensibly/pull/944#discussion_r1",
};

const baseThread = {
  id: "thread-1",
  isResolved: false,
  isOutdated: false,
  path: "src/github-review-thread-receipt.ts",
  line: 1,
  startLine: null,
  originalLine: 1,
  diffSide: "RIGHT" as const,
  comments: [baseComment],
};

describe("GitHub review-thread Unicode and identity admission", () => {
  test("truncates only at Unicode scalar boundaries", () => {
    expect(truncateReviewThreadBody("A😀B", 1)).toEqual({
      excerpt: "A",
      bodyTruncated: true,
    });
    expect(truncateReviewThreadBody("A😀B", 2)).toEqual({
      excerpt: "A",
      bodyTruncated: true,
    });
    expect(truncateReviewThreadBody("A😀B", 3)).toEqual({
      excerpt: "A😀",
      bodyTruncated: true,
    });
    expect(truncateReviewThreadBody("A😀B", 4)).toEqual({
      excerpt: "A😀B",
      bodyTruncated: false,
    });
  });

  test("rejects source bodies containing unpaired surrogates", () => {
    for (const body of ["before\ud83dafter", "before\ude00after"]) {
      expect(() => buildGitHubReviewThreadReceipt(source({
        threads: [{
          ...baseThread,
          comments: [{ ...baseComment, body }],
        }],
      }), config())).toThrow("safe body contract");
    }
  });

  test("rejects duplicate thread identities", () => {
    expect(() => buildGitHubReviewThreadReceipt(source({
      threads: [
        baseThread,
        {
          ...baseThread,
          path: "test/other.ts",
          comments: [{ ...baseComment, id: "comment-2" }],
        },
      ],
      totalThreadCount: 2,
      totalCommentCount: 2,
    }), config())).toThrow("thread IDs must be unique");
  });

  test("rejects duplicate comment identities within one thread", () => {
    expect(() => buildGitHubReviewThreadReceipt(source({
      threads: [{
        ...baseThread,
        comments: [baseComment, { ...baseComment, body: "different" }],
      }],
      totalCommentCount: 2,
    }), config())).toThrow("comment IDs must be unique");
  });

  test("rejects duplicate comment identities across threads", () => {
    expect(() => buildGitHubReviewThreadReceipt(source({
      threads: [
        baseThread,
        {
          ...baseThread,
          id: "thread-2",
          path: "test/other.ts",
        },
      ],
      totalThreadCount: 2,
      totalCommentCount: 2,
    }), config())).toThrow("comment IDs must be unique");
  });

  test("preserves distinct provider order and omission arithmetic", () => {
    const receipt = buildGitHubReviewThreadReceipt(source({
      threads: [
        baseThread,
        {
          ...baseThread,
          id: "thread-2",
          path: "test/other.ts",
          comments: [{ ...baseComment, id: "comment-2" }],
        },
      ],
      totalThreadCount: 3,
      totalCommentCount: 4,
      nextCursor: "cursor-2",
    }), {
      maxThreads: 2,
      maxCommentsPerThread: 1,
      maxThreadBodyChars: 32,
    });

    expect(receipt.threads.map((thread) => thread.id)).toEqual([
      "thread-1",
      "thread-2",
    ]);
    expect(receipt.threads.flatMap((thread) =>
      thread.comments.map((comment) => comment.id)
    )).toEqual(["comment-1", "comment-2"]);
    expect(receipt.threadOmissionCount).toBe(1);
    expect(receipt.commentOmissionCount).toBe(2);
  });
});

function config() {
  return {
    maxThreads: 10,
    maxCommentsPerThread: 10,
    maxThreadBodyChars: 256,
  };
}

function source(
  overrides: Partial<GitHubReviewThreadSourceResult> = {},
): GitHubReviewThreadSourceResult {
  return {
    repositoryFullName: "teamleaderleo/stensibly",
    pullRequestNumber: 944,
    pullRequestState: "OPEN",
    providerUrl: "https://github.com",
    sourceRevision: "github-graphql:pr-944:review-threads-1",
    fetchedAt: "2026-08-03T00:00:02.000Z",
    threads: [baseThread],
    totalThreadCount: 1,
    totalCommentCount: 1,
    nextCursor: null,
    ...overrides,
  };
}
