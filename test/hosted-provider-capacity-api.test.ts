import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  registerHostedProviderCapacityRoutes,
  type HostedGitHubRepositoryObservationInput,
  type HostedGitHubRepositoryObservationSink,
} from "../src/hosted-provider-capacity-api.ts";
import type { StensiblyEnv } from "../src/http-auth.ts";
import { ProviderCapacityConflictError } from "../src/provider-capacity.ts";
import type { ProviderCapacityService } from "../src/provider-capacity-convex.ts";

const secret = "hosted-provider-capacity-secret";
const now = Date.parse("2026-07-28T13:00:01.000Z");
const receivedAt = new Date(now).toISOString();

const before = "1".repeat(40);
const after = "2".repeat(40);

describe("hosted CodeRabbit capacity API", () => {
  test("accepts a signed bounded bot observation and exposes read preflight", async () => {
    let ingested: Parameters<ProviderCapacityService["ingestCodeRabbit"]>[0] | null = null;
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
          receivedAt,
          staleAt: "2026-07-28T13:05:00.000Z",
          refillAt: null,
          nextAvailableAt: null,
          source: { pullRequestNumber: 421, commentId: "5104466293" },
        };
      },
    };
    const app = appWith(service);
    const body = JSON.stringify(payload(
      "Reviews are available now.",
      "coderabbitai[bot]",
      "dependabot[bot]",
    ));
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
      subjectLogin: "dependabot[bot]",
      sourceCommentId: "5104466293",
      receivedAt,
    });

    const anonymous = await app.request(capacityPath());
    expect(anonymous.status).toBe(401);
    const preflight = await app.request(capacityPath(), {
      headers: { authorization: "Bearer read-token" },
    });
    expect(preflight.status).toBe(200);
    expect(await preflight.json()).toMatchObject({
      capacity: {
        state: "available",
        subjectLogin: "dependabot[bot]",
        subjectBasis: "pull_request_author_proxy",
      },
    });
  });

  test("dispatches one supported repository observation without invoking capacity", async () => {
    let capacityCalls = 0;
    let repositoryInput: HostedGitHubRepositoryObservationInput | null = null;
    const service: ProviderCapacityService = {
      async ingestCodeRabbit() {
        capacityCalls += 1;
        throw new Error("not expected");
      },
      async snapshot() {
        throw new Error("not expected");
      },
    };
    const sink: HostedGitHubRepositoryObservationSink = {
      async ingestRepositoryObservation(input) {
        repositoryInput = input;
        return { duplicate: false };
      },
    };
    const app = appWith(service, sink);
    const body = JSON.stringify(pushPayload());
    const response = await app.request("/webhooks/github", {
      method: "POST",
      headers: signedHeaders(body, "delivery-push", "push"),
      body,
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: true,
      duplicate: false,
      repositoryObservation: {
        accepted: true,
        duplicate: false,
      },
    });
    expect(capacityCalls).toBe(0);
    expect(repositoryInput).toMatchObject({
      deliveryId: "delivery-push",
      eventType: "push",
      receivedAt,
      observation: {
        eventType: "push",
        repository: "teamleaderleo/stensibly",
        relationships: {
          revision: after,
          previousRevision: before,
          ref: "refs/heads/main",
        },
      },
    });
    expect(repositoryInput!.payloadDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(repositoryInput)).toBe(true);
    expect(Object.isFrozen(repositoryInput!.observation)).toBe(true);
  });

  test("shares delivery identity, digest, and receipt across repository and capacity consumers", async () => {
    let capacityInput: Parameters<ProviderCapacityService["ingestCodeRabbit"]>[0] | null = null;
    let repositoryInput: HostedGitHubRepositoryObservationInput | null = null;
    const service: ProviderCapacityService = {
      async ingestCodeRabbit(input) {
        capacityInput = input;
        return {
          duplicate: false,
          observation: observationFromInput(input),
        };
      },
      async snapshot() {
        throw new Error("not expected");
      },
    };
    const sink: HostedGitHubRepositoryObservationSink = {
      async ingestRepositoryObservation(input) {
        repositoryInput = input;
        return { duplicate: false };
      },
    };
    const app = appWith(service, sink);
    const body = JSON.stringify(payload("Reviews are available now."));
    const response = await app.request("/webhooks/github", {
      method: "POST",
      headers: signedHeaders(body, "delivery-shared"),
      body,
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      accepted: true,
      duplicate: false,
      repositoryObservation: { accepted: true, duplicate: false },
      capacityObservation: { state: "available" },
    });
    expect(repositoryInput).toMatchObject({
      deliveryId: "delivery-shared",
      eventType: "issue_comment",
      receivedAt,
      observation: {
        eventType: "issue_comment",
        repository: "teamleaderleo/stensibly",
      },
    });
    expect(capacityInput).toMatchObject({
      deliveryId: "delivery-shared",
      receivedAt,
    });
    expect(repositoryInput!.payloadDigest).toBe(
      `sha256:${capacityInput!.payloadDigest}`,
    );
  });

  test("rejects invalid signatures before either sink and maps altered delivery conflicts", async () => {
    let capacityCalls = 0;
    let repositoryCalls = 0;
    const service: ProviderCapacityService = {
      async ingestCodeRabbit(input) {
        capacityCalls += 1;
        if (capacityCalls > 1) {
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
    const sink: HostedGitHubRepositoryObservationSink = {
      async ingestRepositoryObservation() {
        repositoryCalls += 1;
        return { duplicate: false };
      },
    };
    const app = appWith(service, sink);
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
    expect(await invalid.json()).toMatchObject({
      code: "unauthorized",
      detailCode: "GITHUB_WEBHOOK_INVALID_SIGNATURE",
    });
    expect(capacityCalls).toBe(0);
    expect(repositoryCalls).toBe(0);

    const accepted = await app.request("/webhooks/github", {
      method: "POST",
      headers: signedHeaders(firstBody, "delivery-replay"),
      body: firstBody,
    });
    expect(accepted.status).toBe(202);
    expect(capacityCalls).toBe(1);
    expect(repositoryCalls).toBe(1);

    const alteredBody = JSON.stringify(payload("0/1 reviews remaining, refill in 1 hour."));
    const conflict = await app.request("/webhooks/github", {
      method: "POST",
      headers: signedHeaders(alteredBody, "delivery-replay"),
      body: alteredBody,
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "conflict" });
    expect(capacityCalls).toBe(2);
    expect(repositoryCalls).toBe(2);
  });

  test("rejects duplicate JSON keys before either sink", async () => {
    let capacityCalls = 0;
    let repositoryCalls = 0;
    const service: ProviderCapacityService = {
      async ingestCodeRabbit() {
        capacityCalls += 1;
        throw new Error("not expected");
      },
      async snapshot() {
        throw new Error("not expected");
      },
    };
    const sink: HostedGitHubRepositoryObservationSink = {
      async ingestRepositoryObservation() {
        repositoryCalls += 1;
        throw new Error("not expected");
      },
    };
    const app = appWith(service, sink);
    const key = "repository";
    const body = `{${JSON.stringify(key)}:{"full_name":"teamleaderleo/stensibly"},${JSON.stringify(key)}:{"full_name":"other/repository"}}`;
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
    expect(capacityCalls).toBe(0);
    expect(repositoryCalls).toBe(0);
  });

  test("stops before capacity when repository observation storage fails", async () => {
    let capacityCalls = 0;
    const service: ProviderCapacityService = {
      async ingestCodeRabbit() {
        capacityCalls += 1;
        throw new Error("not expected");
      },
      async snapshot() {
        throw new Error("not expected");
      },
    };
    const sink: HostedGitHubRepositoryObservationSink = {
      async ingestRepositoryObservation() {
        throw new Error("sink unavailable");
      },
    };
    const app = appWith(service, sink);
    const body = JSON.stringify(payload("Reviews are available now."));
    const response = await app.request("/webhooks/github", {
      method: "POST",
      headers: signedHeaders(body, "delivery-sink-failure"),
      body,
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "GitHub repository observation storage failed",
      code: "backend_failure",
    });
    expect(capacityCalls).toBe(0);
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

function appWith(
  service: ProviderCapacityService,
  repositoryObservationSink?: HostedGitHubRepositoryObservationSink,
) {
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
    {
      service,
      githubWebhookSecret: secret,
      now: () => now,
      ...(repositoryObservationSink ? { repositoryObservationSink } : {}),
    },
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

function payload(
  body: string,
  actor = "coderabbitai[bot]",
  subjectLogin = "teamleaderleo",
) {
  return {
    action: "created",
    repository: { full_name: "teamleaderleo/stensibly" },
    issue: {
      number: 421,
      pull_request: { url: "https://api.github.com/repos/teamleaderleo/stensibly/pulls/421" },
      user: { login: subjectLogin },
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

function pushPayload() {
  return {
    repository: { full_name: "teamleaderleo/stensibly" },
    sender: { login: "github-actions[bot]" },
    ref: "refs/heads/main",
    before,
    after,
    size: 1,
    head_commit: { timestamp: "2026-07-28T13:00:00.000Z" },
  };
}

function signedHeaders(
  body: string,
  delivery: string,
  eventType = "issue_comment",
) {
  return {
    "content-type": "application/json",
    "x-github-delivery": delivery,
    "x-github-event": eventType,
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  };
}

function capacityPath() {
  return "/api/v1/provider-capacities/coderabbit"
    + "?repository=teamleaderleo%2Fstensibly&subject=dependabot%5Bbot%5D";
}
