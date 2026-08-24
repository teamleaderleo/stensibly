import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  createHostedDeployGovernorConsumerFromEnv,
} from "../src/hosted-deploy-governor-worker.ts";
import {
  digestGitHubWebhookPayload,
  mapGitHubRepositoryWebhook,
} from "../src/github-repository-observation.ts";
import type { PreparedGitHubWebhookDelivery } from "../src/github-webhook-ingress.ts";

const sourceRepository = "teamleaderleo/scrapbook";
const targetRepository = "teamleaderleo/deploy-governor";
const before = "1".repeat(40);
const after = "2".repeat(40);
const receivedAt = "2026-08-24T08:00:00.000Z";
const privateKeyPem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;

function environment(enabled = "true"): Record<string, string | undefined> {
  return {
    STENSIBLY_DEPLOY_GOVERNOR_ENABLED: enabled,
    STENSIBLY_DEPLOY_GOVERNOR_REPOSITORY: targetRepository,
    STENSIBLY_GITHUB_APP_ID: "12345",
    STENSIBLY_GITHUB_INSTALLATION_ID: "98765",
    STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN: "teamleaderleo",
    STENSIBLY_GITHUB_APP_PRIVATE_KEY: privateKeyPem,
    STENSIBLY_GITHUB_API_BASE_URL: "https://api.github.test",
  };
}

function delivery(input: {
  eventType?: string;
  ref?: string;
  afterRevision?: string;
  deleted?: boolean;
} = {}): PreparedGitHubWebhookDelivery {
  const eventType = input.eventType ?? "push";
  const payload = eventType === "push"
    ? {
        repository: { full_name: sourceRepository },
        sender: { login: "teamleaderleo" },
        ref: input.ref ?? "refs/heads/main",
        before,
        after: input.afterRevision ?? after,
        created: false,
        deleted: input.deleted ?? false,
        forced: false,
        size: 1,
        head_commit: { timestamp: "2026-08-24T07:59:00.000Z" },
      }
    : { repository: { full_name: sourceRepository }, sender: { login: "teamleaderleo" } };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const payloadDigest = digestGitHubWebhookPayload(body);
  const observation = mapGitHubRepositoryWebhook({
    eventType,
    deliveryId: "delivery-governor-1",
    payloadDigest,
    payload,
    signatureVerified: true,
    receivedAt,
  });
  return Object.freeze({
    deliveryId: "delivery-governor-1",
    eventType,
    payloadDigest,
    bodyByteLength: body.byteLength,
    receivedAt,
    payload,
    observation,
    signatureAlgorithm: "hmac-sha256",
    payloadAvailability: "memory_only",
    containsRawBody: false,
  });
}

function githubFetch(onDispatch: (body: Record<string, unknown>) => Response | void = () => undefined) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/app/installations/98765/access_tokens")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        repositories: ["deploy-governor"],
        permissions: { contents: "write" },
      });
      return Response.json({
        token: "governor-installation-token",
        expires_at: "2026-08-24T09:00:00.000Z",
        permissions: { contents: "write" },
        repository_selection: "selected",
        repositories: [{ full_name: targetRepository }],
      }, { status: 201 });
    }
    if (url === "https://api.github.test/repos/teamleaderleo/deploy-governor/dispatches") {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization"))
        .toBe("Bearer governor-installation-token");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return onDispatch(body) ?? new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected GitHub request: ${url}`);
  }) as unknown as typeof fetch;
}

describe("hosted deploy governor dispatch", () => {
  test("is disabled unless explicitly enabled", () => {
    expect(createHostedDeployGovernorConsumerFromEnv(environment("false"))).toBeUndefined();
  });

  test("ignores webhook families that are not push candidates without provider access", async () => {
    let calls = 0;
    const consumer = createHostedDeployGovernorConsumerFromEnv(environment(), {
      fetch: (async () => {
        calls += 1;
        throw new Error("must not call GitHub");
      }) as unknown as typeof fetch,
    })!;
    expect(await consumer.consume(delivery({ eventType: "ping" }))).toEqual({ status: "ignored" });
    expect(calls).toBe(0);
  });

  test("ignores deleted push revisions without minting authority", async () => {
    let calls = 0;
    const consumer = createHostedDeployGovernorConsumerFromEnv(environment(), {
      fetch: (async () => {
        calls += 1;
        throw new Error("must not call GitHub");
      }) as unknown as typeof fetch,
    })!;
    expect(await consumer.consume(delivery({
      afterRevision: "0".repeat(40),
      deleted: true,
    }))).toEqual({ status: "ignored" });
    expect(calls).toBe(0);
  });

  test("dispatches exact repository, branch, revision, and delivery identity", async () => {
    let dispatchBody: Record<string, unknown> | null = null;
    const consumer = createHostedDeployGovernorConsumerFromEnv(environment(), {
      fetch: githubFetch((body) => {
        dispatchBody = body;
      }),
      now: () => Date.parse("2026-08-24T08:00:00.000Z"),
    })!;

    expect(await consumer.consume(delivery())).toEqual({ status: "dispatched" });
    expect(dispatchBody).toEqual({
      event_type: "vercel-deploy-candidate",
      client_payload: {
        repository: sourceRepository,
        branch: "main",
        sha: after,
        delivery_id: "delivery-governor-1",
      },
    });
  });

  test("preserves a non-main branch for central allowlist admission", async () => {
    let dispatchBody: Record<string, unknown> | null = null;
    const consumer = createHostedDeployGovernorConsumerFromEnv(environment(), {
      fetch: githubFetch((body) => {
        dispatchBody = body;
      }),
      now: () => Date.parse("2026-08-24T08:00:00.000Z"),
    })!;

    await consumer.consume(delivery({ ref: "refs/heads/release/v2" }));
    expect(dispatchBody).toEqual({
      event_type: "vercel-deploy-candidate",
      client_payload: {
        repository: sourceRepository,
        branch: "release/v2",
        sha: after,
        delivery_id: "delivery-governor-1",
      },
    });
  });

  test("fails the webhook path when GitHub does not accept the dispatch", async () => {
    const consumer = createHostedDeployGovernorConsumerFromEnv(environment(), {
      fetch: githubFetch(() => new Response("forbidden", { status: 403 })),
      now: () => Date.parse("2026-08-24T08:00:00.000Z"),
    })!;
    await expect(consumer.consume(delivery())).rejects.toThrow(
      "Deploy governor dispatch failed with GitHub status 403",
    );
  });
});
