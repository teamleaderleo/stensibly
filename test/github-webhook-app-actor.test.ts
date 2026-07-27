import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const secret = "github-app-actor-webhook-secret";
const now = Date.parse("2026-07-27T21:00:00.000Z");

describe("GitHub App provider-event actors", () => {
  test("accepts a signed bot review and preserves the bounded actor", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const app = createServerApp(store, {
        githubWebhook: { secret, now: () => now },
      });
      const body = JSON.stringify(reviewPayload("coderabbitai[bot]"));
      const response = await app.request("/webhooks/github", {
        method: "POST",
        headers: signedHeaders(body, "delivery-app-review"),
        body,
      });

      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        accepted: true,
        duplicate: false,
        event: {
          actor: "coderabbitai[bot]",
          eventType: "pull_request_review",
          routingLevel: "record",
          status: "pending",
        },
      });
    } finally {
      store.close();
    }
  });

  test("rejects malformed, control-bearing, and oversized bot actor forms", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const app = createServerApp(store, {
        githubWebhook: { secret, now: () => now },
      });
      const actors = [
        "coderabbitai[bot]x",
        "coderabbitai_[bot]",
        `bot\u0000[bot]`,
        `${"a".repeat(96)}[bot]`,
      ];

      for (const [index, actor] of actors.entries()) {
        const body = JSON.stringify(reviewPayload(actor));
        const response = await app.request("/webhooks/github", {
          method: "POST",
          headers: signedHeaders(body, `delivery-invalid-app-${index}`),
          body,
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ code: "invalid_request" });
      }
    } finally {
      store.close();
    }
  });
});

function reviewPayload(actor: string) {
  return {
    action: "submitted",
    repository: { full_name: "teamleaderleo/stensibly" },
    pull_request: { number: 388 },
    review: {
      id: 9988776655,
      commit_id: "0123456789abcdef0123456789abcdef01234567",
      state: "approved",
    },
    sender: { login: actor },
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
