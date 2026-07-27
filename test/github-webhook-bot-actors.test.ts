import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const secret = "github-webhook-bot-actor-secret";
const fixedNow = Date.parse("2026-07-27T20:55:00.000Z");

describe("GitHub provider bot actors", () => {
  test("accepts signed bounded App and enterprise actor logins", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const app = createServerApp(store, {
        githubWebhook: { secret, now: () => fixedNow },
      });
      const validLogins = [
        "github-actions[bot]",
        "coderabbitai[bot]",
        "team.bot_actor",
        "ordinary-reviewer",
      ];

      for (const [index, login] of validLogins.entries()) {
        const body = JSON.stringify(reviewPayload(login, 987654396 + index));
        const response = await app.request("/webhooks/github", {
          method: "POST",
          headers: signedHeaders(body, `delivery-valid-actor-${index}`),
          body,
        });

        expect(response.status, login).toBe(202);
        expect(await response.json()).toMatchObject({
          accepted: true,
          duplicate: false,
          event: {
            actor: login,
            routingLevel: "record",
            status: "pending",
          },
        });
      }
    } finally {
      store.close();
    }
  });

  test("rejects unbounded or free-form sender logins after signature verification", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const app = createServerApp(store, {
        githubWebhook: { secret, now: () => fixedNow },
      });
      const invalidLogins = [
        "",
        "x".repeat(121),
        "bad actor",
        "bad\nactor",
        "reviewer[admin]",
        "-actor",
        "actor-",
        ".actor",
        "actor.",
        "_actor",
        "actor_",
      ];

      for (const [index, login] of invalidLogins.entries()) {
        const body = JSON.stringify(reviewPayload(login, 987654500 + index));
        const response = await app.request("/webhooks/github", {
          method: "POST",
          headers: signedHeaders(body, `delivery-invalid-actor-${index}`),
          body,
        });
        expect(response.status, login).toBe(400);
        expect(await response.json()).toMatchObject({
          code: "invalid_request",
        });
      }
    } finally {
      store.close();
    }
  });

  test("rejects an invalid signature before parsing an invalid actor", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const app = createServerApp(store, {
        githubWebhook: { secret, now: () => fixedNow },
      });
      const body = JSON.stringify(reviewPayload("reviewer[admin]", 987654999));
      const response = await app.request("/webhooks/github", {
        method: "POST",
        headers: {
          ...signedHeaders(body, "delivery-invalid-signature"),
          "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
        },
        body,
      });

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        code: "unauthorized",
      });
    } finally {
      store.close();
    }
  });
});

function reviewPayload(senderLogin: string, reviewId: number) {
  return {
    action: "submitted",
    repository: { full_name: "teamleaderleo/stensibly" },
    pull_request: { number: 396 },
    review: {
      id: reviewId,
      commit_id: "0123456789abcdef0123456789abcdef01234567",
      state: "approved",
    },
    sender: { login: senderLogin },
  };
}

function signedHeaders(body: string, deliveryId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-github-delivery": deliveryId,
    "x-github-event": "pull_request_review",
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  };
}
