import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { createApiToken } from "../src/auth.ts";
import {
  ProviderCapacityConflictError,
  SqliteProviderCapacityStore,
  parseCodeRabbitCapacityComment,
} from "../src/provider-capacity.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const secret = "github-webhook-test-secret";
const observedAt = "2026-07-28T13:00:00.000Z";
const fixedNow = Date.parse(observedAt);
const liveAvailableReply = `<!-- This is an auto-generated reply by CodeRabbit -->
Your [plan](https://docs.coderabbit.ai/management/plans#fair-usage-limits-policy) includes PR reviews subject to [rate limits](https://docs.coderabbit.ai/management/plans#rate-limits). Reviews are available now.`;

describe("CodeRabbit capacity parser", () => {
  test("extracts counted quota and refill facts", () => {
    expect(parseCodeRabbitCapacityComment(
      "2/5 reviews remaining, refill in 42 minutes.",
      observedAt,
    )).toEqual({
      state: "available",
      remaining: 2,
      limit: 5,
      refillAt: "2026-07-28T13:42:00.000Z",
    });

    expect(parseCodeRabbitCapacityComment(
      "**0/1 review remaining, refills in 1 hour and 2 minutes.**",
      observedAt,
    )).toEqual({
      state: "unavailable",
      remaining: 0,
      limit: 1,
      refillAt: "2026-07-28T14:02:00.000Z",
    });
  });

  test("preserves status-only live replies without inventing counts", () => {
    expect(parseCodeRabbitCapacityComment(liveAvailableReply, observedAt)).toEqual({
      state: "available",
      remaining: null,
      limit: null,
      refillAt: null,
    });
    expect(parseCodeRabbitCapacityComment(
      "Rate limit exceeded. More reviews will be available in 7 minutes and 58 seconds.",
      observedAt,
    )).toEqual({
      state: "unavailable",
      remaining: null,
      limit: null,
      refillAt: "2026-07-28T13:07:58.000Z",
    });
    expect(parseCodeRabbitCapacityComment(
      "Please wait 54 minutes and 15 seconds before requesting another review.",
      observedAt,
    )).toEqual({
      state: "unavailable",
      remaining: null,
      limit: null,
      refillAt: "2026-07-28T13:54:15.000Z",
    });
  });

  test("rejects missing, contradictory, or unbounded quota prose", () => {
    expect(parseCodeRabbitCapacityComment("Reviews are available.", observedAt)).toBeNull();
    expect(parseCodeRabbitCapacityComment(
      "2/1 reviews remaining, refill in 42 minutes.",
      observedAt,
    )).toBeNull();
    expect(parseCodeRabbitCapacityComment(
      "0/1 reviews remaining, refill in 2 days.",
      observedAt,
    )).toBeNull();
    expect(parseCodeRabbitCapacityComment(
      "0/1 reviews remaining, refill in 42 minutes.",
      "not-a-time",
    )).toBeNull();
  });
});

describe("CodeRabbit capacity observations", () => {
  test("is conservative across freshness, exhaustion, refill, replay, and event order", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const capacities = new SqliteProviderCapacityStore(store, {
        availableFreshnessMs: 60_000,
      });
      const first = capacityInput({
        deliveryId: "delivery-first",
        payloadDigest: "a".repeat(64),
        state: "available",
        remaining: 1,
        limit: 1,
        refillAt: "2026-07-28T13:42:00.000Z",
        observedAt,
        receivedAt: observedAt,
      });

      const inserted = capacities.ingestCodeRabbit(first);
      expect(inserted.duplicate).toBe(false);
      expect(capacities.ingestCodeRabbit(first)).toMatchObject({
        duplicate: true,
        observation: { id: inserted.observation.id },
      });
      expect(() => capacities.ingestCodeRabbit({
        ...first,
        payloadDigest: "b".repeat(64),
      })).toThrow(ProviderCapacityConflictError);

      expect(capacities.snapshot(
        "teamleaderleo/stensibly",
        "teamleaderleo",
        fixedNow + 30_000,
      )).toMatchObject({
        subjectBasis: "pull_request_author_proxy",
        state: "available",
        reason: null,
        remaining: 1,
        limit: 1,
      });
      expect(capacities.snapshot(
        "teamleaderleo/stensibly",
        "teamleaderleo",
        fixedNow + 60_000,
      )).toMatchObject({
        state: "unknown",
        reason: "observation_stale",
      });

      capacities.ingestCodeRabbit(capacityInput({
        deliveryId: "delivery-exhausted",
        payloadDigest: "c".repeat(64),
        sourceCommentId: "1002",
        state: "unavailable",
        remaining: 0,
        limit: 1,
        observedAt: "2026-07-28T13:02:00.000Z",
        receivedAt: "2026-07-28T13:02:00.000Z",
        refillAt: "2026-07-28T13:42:00.000Z",
      }));
      capacities.ingestCodeRabbit(capacityInput({
        deliveryId: "delivery-late-old",
        payloadDigest: "d".repeat(64),
        sourceCommentId: "1003",
        state: "available",
        remaining: 1,
        limit: 1,
        observedAt: "2026-07-28T13:01:00.000Z",
        receivedAt: "2026-07-28T13:03:00.000Z",
        refillAt: "2026-07-28T13:42:00.000Z",
      }));

      expect(capacities.snapshot(
        "teamleaderleo/stensibly",
        "teamleaderleo",
        Date.parse("2026-07-28T13:10:00.000Z"),
      )).toMatchObject({
        state: "unavailable",
        reason: "quota_exhausted",
        remaining: 0,
        nextAvailableAt: "2026-07-28T13:42:00.000Z",
        source: { commentId: "1002" },
      });
      expect(capacities.snapshot(
        "teamleaderleo/stensibly",
        "teamleaderleo",
        Date.parse("2026-07-28T13:42:00.000Z"),
      )).toMatchObject({
        state: "unknown",
        reason: "refill_window_elapsed",
        nextAvailableAt: null,
      });
    } finally {
      store.close();
    }
  });

  test("keeps uncounted provider status explicit", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const capacities = new SqliteProviderCapacityStore(store, {
        availableFreshnessMs: 60_000,
      });
      capacities.ingestCodeRabbit(capacityInput({
        deliveryId: "delivery-status-only",
        payloadDigest: "e".repeat(64),
        state: "available",
        remaining: null,
        limit: null,
        refillAt: null,
      }));
      expect(capacities.snapshot(
        "teamleaderleo/stensibly",
        "teamleaderleo",
        fixedNow + 30_000,
      )).toMatchObject({
        state: "available",
        reason: null,
        remaining: null,
        limit: null,
        refillAt: null,
        staleAt: "2026-07-28T13:01:00.000Z",
      });

      capacities.ingestCodeRabbit(capacityInput({
        deliveryId: "delivery-status-wait",
        payloadDigest: "f".repeat(64),
        sourceCommentId: "1004",
        state: "unavailable",
        remaining: null,
        limit: null,
        refillAt: "2026-07-28T13:07:58.000Z",
        observedAt: "2026-07-28T13:02:00.000Z",
        receivedAt: "2026-07-28T13:02:00.000Z",
      }));
      expect(capacities.snapshot(
        "teamleaderleo/stensibly",
        "teamleaderleo",
        Date.parse("2026-07-28T13:03:00.000Z"),
      )).toMatchObject({
        state: "unavailable",
        reason: "provider_reported_unavailable",
        remaining: null,
        limit: null,
        nextAvailableAt: "2026-07-28T13:07:58.000Z",
      });
    } finally {
      store.close();
    }
  });
});

describe("signed CodeRabbit capacity intake", () => {
  test("records the live status-only bot reply and exposes it only to an administrator", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const adminToken = createApiToken(store, {
        name: "Administrator",
        scopes: ["admin"],
        projects: null,
      }).token;
      const readToken = createApiToken(store, {
        name: "Reader",
        scopes: ["read"],
        projects: null,
      }).token;
      const app = createServerApp(store, {
        githubWebhook: { secret, now: () => fixedNow },
      });
      const body = JSON.stringify(issueCommentPayload({
        body: liveAvailableReply,
      }));

      const accepted = await app.request("/webhooks/github", {
        method: "POST",
        headers: signedHeaders(body, "capacity-delivery"),
        body,
      });
      expect(accepted.status).toBe(202);
      expect(await accepted.json()).toMatchObject({
        accepted: true,
        duplicate: false,
        capacityObservation: {
          provider: "coderabbit",
          repository: "teamleaderleo/stensibly",
          pullRequestNumber: 418,
          subjectLogin: "teamleaderleo",
          subjectBasis: "pull_request_author_proxy",
          state: "available",
          remaining: null,
          limit: null,
          refillAt: null,
        },
      });

      const anonymous = await app.request(capacityPath());
      expect(anonymous.status).toBe(401);
      const reader = await app.request(capacityPath(), {
        headers: bearer(readToken),
      });
      expect(reader.status).toBe(403);

      const administrator = await app.request(capacityPath(), {
        headers: bearer(adminToken),
      });
      expect(administrator.status).toBe(200);
      expect(await administrator.json()).toEqual({
        capacity: {
          provider: "coderabbit",
          repository: "teamleaderleo/stensibly",
          subjectLogin: "teamleaderleo",
          subjectBasis: "pull_request_author_proxy",
          state: "available",
          reason: null,
          remaining: null,
          limit: null,
          observedAt,
          receivedAt: observedAt,
          staleAt: "2026-07-28T13:05:00.000Z",
          refillAt: null,
          nextAvailableAt: null,
          source: {
            pullRequestNumber: 418,
            commentId: "5104000000",
          },
        },
      });
    } finally {
      store.close();
    }
  });

  test("ignores unrelated comments without inventing capacity", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const adminToken = createApiToken(store, {
        name: "Administrator",
        scopes: ["admin"],
        projects: null,
      }).token;
      const app = createServerApp(store, {
        githubWebhook: { secret, now: () => fixedNow },
      });

      const humanBody = JSON.stringify(issueCommentPayload({
        body: "0/1 reviews remaining, refill in 42 minutes.",
        actor: "teamleaderleo",
      }));
      const human = await app.request("/webhooks/github", {
        method: "POST",
        headers: signedHeaders(humanBody, "capacity-human"),
        body: humanBody,
      });
      expect(human.status).toBe(202);
      expect(await human.json()).toMatchObject({
        accepted: false,
        ignored: true,
        reason: "not_coderabbit_capacity_observation",
      });

      const botBody = JSON.stringify(issueCommentPayload({
        body: "The review completed successfully.",
      }));
      const bot = await app.request("/webhooks/github", {
        method: "POST",
        headers: signedHeaders(botBody, "capacity-unrecognised"),
        body: botBody,
      });
      expect(bot.status).toBe(202);
      expect(await bot.json()).toMatchObject({
        accepted: false,
        ignored: true,
        reason: "unrecognised_coderabbit_capacity_observation",
      });

      const result = await app.request(capacityPath(), {
        headers: bearer(adminToken),
      });
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({
        capacity: {
          subjectBasis: "pull_request_author_proxy",
          state: "unknown",
          reason: "not_observed",
          remaining: null,
          nextAvailableAt: null,
        },
      });
    } finally {
      store.close();
    }
  });
});

function capacityInput(
  overrides: Partial<Parameters<SqliteProviderCapacityStore["ingestCodeRabbit"]>[0]> = {},
): Parameters<SqliteProviderCapacityStore["ingestCodeRabbit"]>[0] {
  return {
    deliveryId: "delivery-default",
    payloadDigest: createHash("sha256").update("default").digest("hex"),
    sourceCommentId: "1001",
    repository: "teamleaderleo/stensibly",
    pullRequestNumber: 418,
    subjectLogin: "teamleaderleo",
    state: "available",
    remaining: 1,
    limit: 1,
    refillAt: "2026-07-28T13:42:00.000Z",
    observedAt,
    receivedAt: observedAt,
    ...overrides,
  };
}

function issueCommentPayload(options: {
  body: string;
  actor?: string;
}) {
  const actor = options.actor ?? "coderabbitai[bot]";
  return {
    action: "created",
    repository: { full_name: "teamleaderleo/stensibly" },
    issue: {
      number: 418,
      pull_request: { url: "https://api.github.com/repos/teamleaderleo/stensibly/pulls/418" },
      user: { login: "teamleaderleo" },
    },
    comment: {
      id: 5_104_000_000,
      body: options.body,
      created_at: observedAt,
      updated_at: observedAt,
      user: { login: actor },
    },
    sender: { login: actor },
  };
}

function signedHeaders(
  body: string,
  deliveryId: string,
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-github-delivery": deliveryId,
    "x-github-event": "issue_comment",
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function capacityPath(): string {
  return "/api/v1/provider-capacities/coderabbit"
    + "?repository=teamleaderleo%2Fstensibly&subject=teamleaderleo";
}
