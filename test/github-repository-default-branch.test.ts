import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  observedRepositoryDefaultBranch,
  withObservedRepositoryDefaultBranch,
} from "../src/github-repository-default-branch.ts";
import {
  digestGitHubWebhookPayload,
  mapGitHubRepositoryWebhook,
} from "../src/github-repository-observation.ts";
import {
  createGitHubWebhookIngress,
  GitHubWebhookIngressError,
} from "../src/github-webhook-ingress.ts";
import { normalizeGitHubBranchName } from "../src/github-branch-name.ts";

const repository = "teamleaderleo/stensibly";
const secret = "default-branch-observation-secret";
const before = "1".repeat(40);
const after = "2".repeat(40);
const receivedAt = "2026-08-10T00:20:00.000Z";

function pushPayload(defaultBranch?: unknown) {
  return {
    repository: {
      full_name: repository,
      ...(defaultBranch === undefined ? {} : { default_branch: defaultBranch }),
    },
    sender: { login: "github-actions[bot]" },
    ref: "refs/heads/main",
    before,
    after,
    created: false,
    deleted: false,
    forced: false,
    size: 1,
    head_commit: { timestamp: "2026-08-10T00:19:00.000Z" },
  };
}

function mapped(payload: Record<string, unknown>) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  return mapGitHubRepositoryWebhook({
    eventType: "push",
    deliveryId: "delivery-default-branch",
    payloadDigest: digestGitHubWebhookPayload(body),
    payload,
    signatureVerified: true,
    receivedAt,
    expectedRepository: repository,
  })!;
}

async function ingress(payload: Record<string, unknown>, deliveryId: string) {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const compile = createGitHubWebhookIngress({
    secret,
    expectedRepository: repository,
    now: () => Date.parse(receivedAt),
  });
  return compile(new Request("https://api.stensibly.com/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": "push",
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body,
  }));
}

describe("GitHub repository default branch observation", () => {
  test("retains a verified default branch and recomputes semantic identity", async () => {
    const main = await ingress(pushPayload("main"), "delivery-main");
    const develop = await ingress(pushPayload("develop"), "delivery-develop");

    expect(main.observation?.facts).toMatchObject({ defaultBranch: "main" });
    expect(observedRepositoryDefaultBranch(main.observation!)).toBe("main");
    expect(develop.observation?.facts).toMatchObject({ defaultBranch: "develop" });
    expect(main.observation?.semanticFingerprint)
      .not.toBe(develop.observation?.semanticFingerprint);
    expect(Object.isFrozen(main.observation)).toBe(true);
    expect(Object.isFrozen(main.observation?.facts)).toBe(true);
  });

  test("keeps older or branch-less observations readable as unknown", async () => {
    const payload = pushPayload();
    const legacy = mapped(payload);
    expect(observedRepositoryDefaultBranch(legacy)).toBeNull();

    const prepared = await ingress(payload, "delivery-without-default-branch");
    expect(prepared.observation).toBeTruthy();
    expect(prepared.observation?.facts).not.toHaveProperty("defaultBranch");
    expect(observedRepositoryDefaultBranch(prepared.observation!)).toBeNull();
    expect(withObservedRepositoryDefaultBranch(legacy, payload)).toBe(legacy);
  });

  test("rejects malformed present default branches through the fixed ingress error", async () => {
    for (const defaultBranch of ["HEAD", "refs/heads/main", "bad branch", ".hidden"]) {
      await expect(ingress(
        pushPayload(defaultBranch),
        `delivery-invalid-${String(defaultBranch).replaceAll("/", "-")}`,
      )).rejects.toMatchObject({
        name: "GitHubWebhookIngressError",
        status: 400,
        code: "invalid_request",
        detailCode: "GITHUB_WEBHOOK_INVALID_PAYLOAD",
      } satisfies Partial<GitHubWebhookIngressError>);
    }
  });

  test("uses the same branch admission rules as project attachment setup", () => {
    expect(normalizeGitHubBranchName("release/2026-08-10")).toBe("release/2026-08-10");
    expect(() => normalizeGitHubBranchName("refs/heads/main")).toThrow("invalid");
    expect(() => normalizeGitHubBranchName("branch with spaces")).toThrow("invalid");
  });
});
