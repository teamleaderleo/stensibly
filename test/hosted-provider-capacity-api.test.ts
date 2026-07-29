import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerHostedProviderCapacityRoutes } from "../src/hosted-provider-capacity-api.ts";
import type { StensiblyEnv } from "../src/http-auth.ts";
import { ProviderCapacityConflictError } from "../src/provider-capacity.ts";
import type { ProviderCapacityService } from "../src/provider-capacity-convex.ts";

const secret = "hosted-provider-capacity-secret";
const now = Date.parse("2026-07-28T13:00:01.000Z");

describe("hosted CodeRabbit capacity API", () => {
  test("accepts a signed bounded bot observation and exposes read preflight", async () => {
    let ingested: any = null;
    const service: ProviderCapacityService = {
      async ingestCodeRabbit(input) {
        ingested = input;
        return {
          duplicate: false,
          observation: observationFromInput(input),
        };
      },
      async snapshot(repository, subjectLogin) {
        return {
          provider: "coderabbit",
          repository,
          subjectLogin,
          subjectBasis: "pull_request_author_proxy",
          state: "available",
          reason: null,
          remaining: null,
          limit: null,
          observedAt: "2026-07-28T13:00:00.000Z",
          receivedAt: "2026-07-28T13:00:01.000Z",
          staleAt: "2026-07-28T13:05:00.000Z",
          refillAt: null,
          nextAvailableAt: null,
          source: { pullRequestNumber: 421, commentId: "5104466293" },
        };
      },
    };
    const app = appWith(service);
    const body = JSON.stringify(payload("Reviews are available now."));
    const accepted = await app.request("/webhooks/github", {
      method: "POST",
      headers: signedHeaders(body, "delivery-capacity"),
      body,
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      accepted: true,
      duplicate: false,
      capacityObservation: { state: "available", remaining: null },
    });
    expect(ingested).toMatchObject({
      repository: "teamleaderleo/stensibly",
      subjectLogin: "teamleaderleo",
      sourceCommentId: "5104466293",
    });

    const anonymous = await app.request(capacityPath());
    expect(anonymous.status).toBe(401);
    const preflight = await app.request(capacityPath(), {
      headers: { authorization: "Bearer read-token" },
    });
    expect(preflight.status).toBe(200);
    expect(await preflight.json()).toMatchObject({
      capacity: { state: "available", subjectBasis: "pull_request_author_proxy" },
    });
  });

  test("rejects invalid signatures before storage and maps altered delivery conflicts", async () => {
    let calls = 0;
    const service: ProviderCapacityService = {
      async ingestCodeRabbit(input) {
        calls += 1;
        if (calls > 1) {
          throw new ProviderCapacityConflictError(
            "GitHub delivery identity was reused with different provider capacity content",
          );
        }
        return {
          duplicate: false,
          observation: observationFromInput(input),
        };
      },
      async snapshot() {
        throw new Error("not expected");
      },
    };
    const app = appWith(service);
    const firstBody = JSON.stringify(payload("Reviews are available now."));

    const invalid = await app.request("/webhooks/github", {
      method: "POST",
      headers: {
        ...signedHeaders(firstBody, "delivery-replay"),
        "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
      },
      body: firstBody,
    });
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toMatchObject({ code: "unauthorized" });
    expect(calls).toBe(0);

    const accepted = await app.request("/webhooks/github", {
      method: "POST",
      headers: signedHeaders(firstBody, "delivery-replay"),
      body: firstBody,
    });
    expect(accepted.status).toBe(202);
    expect(calls).toBe(1);

    const alteredBody = JSON.stringify(payload("0/1 reviews remaining, refill in 1 hour."));
    const conflict = await app.request("/webhooks/github", {
      method: "POST",
      headers: signedHeaders(alteredBody, "delivery-replay"),
      body: alteredBody,
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "conflict" });
    expect(calls).toBe(2);
  });

  test("ignores human and unrecognised bot prose without mutating capacity", async () => {
    let calls = 0;
    const service: ProviderCapacityService = {
      async ingestCodeRabbit() {
        calls += 1;
        throw new Error("not expected");
      },
      async snapshot() {
        throw new Error("not expected");
      },
    };
    const app = appWith(service);
    for (const [delivery, value] of [
      ["human", payload("0/1 reviews remaining, refill in 1 hour.", "teamleaderleo")],
      ["bot-prose", payload("The code review completed successfully.")],
    ] as const) {
      const body = JSON.stringify(value);
      const response = await app.request("/webhooks/github", {
        method: "POST",
        headers: signedHeaders(body, delivery),
        body,
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ ignored: true });
    }
    expect(calls).toBe(0);
  });
});

function appWith(service: ProviderCapacityService) {
  const app = new Hono<StensiblyEnv>();
  registerHostedProviderCapacityRoutes(
    app,
    {
      async authenticate(token) {
        return token === "read-token"
          ? {
              tokenId: "tok_read",
              name: "Reader",
              scopes: ["read"],
              projects: null,
            }
          : null;
      },
    },
    { required: true },
    { service, githubWebhookSecret: secret, now: () => now },
  );
  return app;
}

function observationFromInput(
  input: Parameters<ProviderCapacityService["ingestCodeRabbit"]>[0],
) {
  return {
    id: "capacity_1",
    provider: "coderabbit" as const,
    deliveryId: input.deliveryId,
    sourceCommentId: input.sourceCommentId,
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    subjectLogin: input.subjectLogin,
    subjectBasis: "pull_request_author_proxy" as const,
    state: input.state,
    remaining: input.remaining,
    limit: input.limit,
    refillAt: input.refillAt,
    observedAt: input.observedAt,
    receivedAt: input.receivedAt,
  };
}

function payload(body: string, actor = "coderabbitai[bot]") {
  return {
    action: "created",
    repository: { full_name: "teamleaderleo/stensibly" },
    issue: {
      number: 421,
      pull_request: { url: "https://api.github.com/repos/teamleaderleo/stensibly/pulls/421" },
      user: { login: "teamleaderleo" },
    },
    comment: {
      id: 5_104_466_293,
      body,
      created_at: "2026-07-28T13:00:00.000Z",
      updated_at: "2026-07-28T13:00:00.000Z",
      user: { login: actor },
    },
    sender: { login: actor },
  };
}

function signedHeaders(body: string, delivery: string) {
  return {
    "content-type": "application/json",
    "x-github-delivery": delivery,
    "x-github-event": "issue_comment",
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  };
}

function capacityPath() {
  return "/api/v1/provider-capacities/coderabbit"
    + "?repository=teamleaderleo%2Fstensibly&subject=teamleaderleo";
}
