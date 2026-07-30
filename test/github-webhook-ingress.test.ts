import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  createGitHubWebhookIngress,
  GitHubWebhookIngressError,
} from "../src/github-webhook-ingress.ts";

const secret = "stensibly-webhook-secret";
const repository = "teamleaderleo/stensibly";
const receivedAt = "2026-07-31T02:40:00.000Z";
const before = "1".repeat(40);
const after = "2".repeat(40);

function signedRequest(
  eventType: string,
  body: string,
  input: {
    signature?: string;
    contentType?: string;
    deliveryId?: string;
    contentLength?: string;
  } = {},
): Request {
  const signature = input.signature
    ?? `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return new Request("https://stensibly.example/webhooks/github", {
    method: "POST",
    headers: {
      "Content-Type": input.contentType ?? "application/json",
      "X-GitHub-Delivery": input.deliveryId ?? "delivery-123",
      "X-GitHub-Event": eventType,
      "X-Hub-Signature-256": signature,
      ...(input.contentLength === undefined
        ? {}
        : { "Content-Length": input.contentLength }),
    },
    body,
  });
}

function pushPayload(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    repository: { full_name: repository },
    sender: { login: "github-actions[bot]" },
    ref: "refs/heads/main",
    before,
    after,
    size: 1,
    head_commit: { timestamp: "2026-07-31T02:39:00.000Z" },
    ...extra,
  });
}

async function ingressError(
  promise: Promise<unknown>,
): Promise<GitHubWebhookIngressError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubWebhookIngressError);
    return error as GitHubWebhookIngressError;
  }
  throw new Error("expected GitHub webhook ingress failure");
}

describe("GitHub webhook ingress", () => {
  test("verifies, parses, maps, freezes, and minimizes one signed delivery", async () => {
    const ingress = createGitHubWebhookIngress({
      secret,
      expectedRepository: repository,
      now: () => Date.parse(receivedAt),
    });
    const body = pushPayload({ private_note: "provider prose must stay memory-only" });
    const request = signedRequest("push", body);

    const delivery = await ingress(request);

    expect(delivery).toMatchObject({
      deliveryId: "delivery-123",
      eventType: "push",
      bodyByteLength: Buffer.byteLength(body, "utf8"),
      receivedAt,
      signatureAlgorithm: "hmac-sha256",
      payloadAvailability: "memory_only",
      containsRawBody: false,
      observation: {
        eventType: "push",
        repository,
        relationships: {
          revision: after,
          previousRevision: before,
          ref: "refs/heads/main",
        },
      },
    });
    expect(delivery.payloadDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(request.bodyUsed).toBe(true);
    expect(Object.isFrozen(delivery)).toBe(true);
    expect(Object.isFrozen(delivery.payload as object)).toBe(true);
    expect(Object.isFrozen(delivery.observation!)).toBe(true);
    expect(Object.keys(delivery)).not.toContain("payload");
    expect(JSON.stringify(delivery)).not.toContain("provider prose must stay memory-only");
  });

  test("returns repository-bound unsupported events for secondary consumers", async () => {
    const ingress = createGitHubWebhookIngress({
      secret,
      expectedRepository: repository,
      now: () => Date.parse(receivedAt),
    });
    const delivery = await ingress(signedRequest("ping", JSON.stringify({
      repository: { full_name: repository },
      zen: "ok",
    })));

    expect(delivery.eventType).toBe("ping");
    expect(delivery.observation).toBeNull();
    expect(delivery.payload).toEqual({
      repository: { full_name: repository },
      zen: "ok",
    });
  });

  test("checks the signature before decoding or parsing provider content", async () => {
    const ingress = createGitHubWebhookIngress({ secret });
    const error = await ingressError(ingress(signedRequest(
      "push",
      '{"token=secret":"one","token=secret":"two"}',
      { signature: `sha256=${"0".repeat(64)}` },
    )));

    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
    expect(error.detailCode).toBe("GITHUB_WEBHOOK_INVALID_SIGNATURE");
    expect(error.authenticate).toBe(true);
    expect(error.message).not.toContain("token=secret");
  });

  test("keeps duplicate-key diagnostics bounded and content-free", async () => {
    const ingress = createGitHubWebhookIngress({ secret });
    const key = "token=secret\n\u202eright";
    const body = `{${JSON.stringify(key)}:1,${JSON.stringify(key)}:2}`;
    const error = await ingressError(ingress(signedRequest("ping", body)));

    expect(error.status).toBe(400);
    expect(error.detailCode).toBe("GITHUB_WEBHOOK_JSON_DUPLICATE_KEY");
    expect(error.path).toBe("$.object[1]");
    expect(error.message).not.toContain(key);
    expect(error.path).not.toContain(key);
  });

  test("binds unsupported event families before secondary dispatch", async () => {
    const ingress = createGitHubWebhookIngress({
      secret,
      expectedRepository: repository,
    });
    const body = JSON.stringify({
      repository: { full_name: "external/private-repository" },
      sender: { login: "octocat" },
      pull_request: { number: 7 },
      review: { id: 42 },
    });
    const error = await ingressError(ingress(signedRequest(
      "pull_request_review",
      body,
    )));

    expect(error.status).toBe(400);
    expect(error.detailCode).toBe("GITHUB_WEBHOOK_INVALID_PAYLOAD");
    expect(error.message).toBe("GitHub webhook payload is invalid");
    expect(error.message).not.toContain("external/private-repository");
  });

  test("rejects wrong media types and oversized streamed bodies", async () => {
    const ingress = createGitHubWebhookIngress({
      secret,
      maxBodyBytes: 1_024,
    });
    const mediaError = await ingressError(ingress(signedRequest(
      "ping",
      "{}",
      { contentType: "text/plain" },
    )));
    expect(mediaError.status).toBe(415);
    expect(mediaError.code).toBe("unsupported_media_type");

    const oversizedBody = JSON.stringify({ value: "x".repeat(1_024) });
    const sizeError = await ingressError(ingress(signedRequest("ping", oversizedBody)));
    expect(sizeError.status).toBe(413);
    expect(sizeError.code).toBe("payload_too_large");
  });

  test("rejects non-decimal Content-Length syntax", async () => {
    const ingress = createGitHubWebhookIngress({ secret });
    for (const contentLength of ["1e3", "+2", " 2", "2 "]) {
      const error = await ingressError(ingress(signedRequest("ping", "{}", {
        contentLength,
      })));
      expect(error.status).toBe(400);
      expect(error.detailCode).toBe("GITHUB_WEBHOOK_INVALID_CONTENT_LENGTH");
    }
  });

  test("reports a consumed request through the typed body-read failure", async () => {
    const ingress = createGitHubWebhookIngress({ secret });
    const request = signedRequest("ping", "{}");
    await ingress(request);

    const error = await ingressError(ingress(request));
    expect(error.status).toBe(400);
    expect(error.detailCode).toBe("GITHUB_WEBHOOK_BODY_READ_FAILED");
  });

  test("validates reusable ingress configuration before accepting requests", () => {
    expect(() => createGitHubWebhookIngress({ secret: "short" }))
      .toThrow("between 16 and 1024");
    expect(() => createGitHubWebhookIngress({
      secret,
      expectedRepository: "invalid",
    })).toThrow("canonical GitHub owner/repository");
    expect(() => createGitHubWebhookIngress({
      secret,
      maxBodyBytes: 512,
    })).toThrow("between 1024 and 1048576");
  });
});
