import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  digestGitHubWebhookPayload,
  mapGitHubRepositoryWebhook,
  type GitHubRepositoryObservation,
} from "../src/github-repository-observation";
import { canonicalJsonString } from "../src/idempotency-request-fingerprint";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "github-repository-observation-service-secret";
const repository = "teamleaderleo/stensibly";
const before = "1".repeat(40);
const after = "2".repeat(40);
const baseRevision = "3".repeat(40);
const mergeRevision = "4".repeat(40);
const reviewRevision = "a".repeat(40);
const ingestRef = makeFunctionReference<"mutation">(
  "githubRepositoryObservations:ingest",
);
const listRecentRef = makeFunctionReference<"query">(
  "githubRepositoryObservations:listRecent",
);

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("hosted GitHub repository observation families", () => {
  test("persists every event family emitted by the signed mapper", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const observations = supportedObservations();

    for (const observation of observations) {
      const result = await t.mutation(ingestRef, mutationArgs(observation)) as any;
      expect(result).toMatchObject({
        duplicate: false,
        record: {
          observationId: observation.observationId,
          eventType: observation.eventType,
          subjectKind: observation.subject.kind,
          subjectExternalId: observation.subject.externalId,
        },
      });
    }

    const recent = await t.query(listRecentRef, {
      serviceSecret,
      workspace: "test",
      repository,
      limit: 20,
    }) as any[];
    expect(recent).toHaveLength(8);
    expect(new Set(recent.map((row) => row.eventType))).toEqual(new Set([
      "push",
      "create",
      "delete",
      "pull_request",
      "pull_request_review",
      "pull_request_review_comment",
      "issues",
      "issue_comment",
    ]));
  });
});

function supportedObservations(): GitHubRepositoryObservation[] {
  return [
    map("push", "delivery-push", {
      ...common(),
      ref: "refs/heads/main",
      before,
      after,
      created: false,
      deleted: false,
      forced: false,
      size: 2,
      head_commit: { timestamp: "2026-07-31T15:50:00.000Z" },
    }),
    map("create", "delivery-create", {
      ...common(),
      ref: "feature/sync-loop",
      ref_type: "branch",
    }),
    map("delete", "delivery-delete", {
      ...common(),
      ref: "feature/sync-loop",
      ref_type: "branch",
    }),
    map("pull_request", "delivery-pull-request", {
      ...common(),
      action: "synchronize",
      number: 744,
      pull_request: {
        number: 744,
        state: "open",
        draft: false,
        locked: false,
        merged: false,
        updated_at: "2026-07-31T15:51:00.000Z",
        title: "Private pull request title",
        body: "Private pull request body",
        head: { sha: after },
        base: { sha: baseRevision },
        merge_commit_sha: mergeRevision,
      },
    }),
    map("pull_request_review", "delivery-review", {
      ...common(),
      action: "submitted",
      pull_request: {
        number: 744,
        updated_at: "2026-07-31T15:52:00.000Z",
      },
      review: {
        id: "9007199254740993",
        commit_id: reviewRevision,
        state: "approved",
        body: "Private review body",
        submitted_at: "2026-07-31T15:52:30.000Z",
      },
    }),
    map("pull_request_review_comment", "delivery-review-comment", {
      ...common(),
      action: "created",
      pull_request: { number: 744 },
      comment: {
        id: "9007199254740994",
        pull_request_review_id: "9007199254740993",
        in_reply_to_id: 77,
        commit_id: reviewRevision,
        original_commit_id: before,
        body: "Private review comment body",
        path: "src/private.ts",
        diff_hunk: "@@ private context @@",
        created_at: "2026-07-31T15:53:00.000Z",
        updated_at: "2026-07-31T15:53:30.000Z",
      },
    }),
    map("issues", "delivery-issue", {
      ...common(),
      action: "edited",
      issue: {
        number: 744,
        state: "open",
        state_reason: null,
        locked: false,
        updated_at: "2026-07-31T15:54:00.000Z",
        title: "Private issue title",
        body: "Private issue body",
      },
    }),
    map("issue_comment", "delivery-issue-comment", {
      ...common(),
      action: "created",
      issue: {
        number: 744,
        pull_request: {},
      },
      comment: {
        id: "9007199254740995",
        body: "Private issue comment body",
        created_at: "2026-07-31T15:55:00.000Z",
        updated_at: "2026-07-31T15:55:30.000Z",
      },
    }),
  ];
}

function map(
  eventType: string,
  deliveryId: string,
  payload: Record<string, unknown>,
): GitHubRepositoryObservation {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const observation = mapGitHubRepositoryWebhook({
    eventType,
    deliveryId,
    payloadDigest: digestGitHubWebhookPayload(bytes),
    payload,
    signatureVerified: true,
    receivedAt: "2026-07-31T16:00:00.000Z",
    expectedRepository: repository,
  });
  if (!observation) throw new Error(`Expected ${eventType} observation`);
  return observation;
}

function mutationArgs(observation: GitHubRepositoryObservation) {
  return {
    serviceSecret,
    workspace: "test",
    deliveryId: observation.deliveryId,
    eventType: observation.eventType,
    payloadDigest: observation.payloadDigest,
    receivedAt: Date.parse(observation.receivedAt),
    observationJson: canonicalJsonString(observation),
  };
}

function common(): Record<string, unknown> {
  return {
    repository: { full_name: repository },
    sender: { login: "github-actions[bot]" },
  };
}

async function seedWorkspace(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx: any) => {
    await ctx.db.insert("workspaces", {
      externalId: "ws_test",
      slug: "test",
      name: "Test",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}
