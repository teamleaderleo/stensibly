import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { SqliteProviderEventStore } from "../src/provider-events.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";

const secret = "github-webhook-test-secret";

describe("repository GitHub shared ingress parity", () => {
  test("rejects duplicate keys before unsupported-event dispatch", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const app = createServerApp(store, {
        githubWebhook: {
          secret,
          now: () => Date.parse("2026-07-31T03:20:00.000Z"),
        },
      });
      const body = '{"repository":{"full_name":"teamleaderleo/stensibly"},"repository":{"full_name":"other/repository"}}';
      const response = await app.request("/webhooks/github", {
        method: "POST",
        headers: signedHeaders(body, "delivery-duplicate", "ping"),
        body,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "invalid_request",
        detailCode: "GITHUB_WEBHOOK_JSON_DUPLICATE_KEY",
        path: "$.object[1]",
      });
      expect(new SqliteProviderEventStore(store).list()).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("rejects the signature before exposing strict-JSON diagnostics", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const app = createServerApp(store, {
        githubWebhook: { secret },
      });
      const body = '{"token=secret":"one","token=secret":"two"}';
      const response = await app.request("/webhooks/github", {
        method: "POST",
        headers: {
          ...signedHeaders(body, "delivery-signature", "ping"),
          "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
        },
        body,
      });

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("GitHub-HMAC-SHA256");
      const result = await response.json() as Record<string, unknown>;
      expect(result).toMatchObject({
        code: "unauthorized",
        detailCode: "GITHUB_WEBHOOK_INVALID_SIGNATURE",
      });
      expect(JSON.stringify(result)).not.toContain("token=secret");
      expect(new SqliteProviderEventStore(store).list()).toEqual([]);
    } finally {
      store.close();
    }
  });
});

function signedHeaders(body: string, delivery: string, eventType: string) {
  return {
    "content-type": "application/json",
    "x-github-delivery": delivery,
    "x-github-event": eventType,
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  };
}
