import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { compileGitHubMailAttention, type GitHubMailThreadBinding } from "../src/github-mail-bridge.ts";
import { mapGitHubMailTerminalWebhook } from "../src/github-mail-terminal-webhook.ts";
import { createGitHubWebhookIngress } from "../src/github-webhook-ingress.ts";

const repository = "teamleaderleo/stensibly";
const secret = "terminal-webhook-secret-1491-proof";
const revision = "d".repeat(40);
const thread: GitHubMailThreadBinding = {
  version: 1,
  threadId: "attn_1491_ci",
  handle: "STN-INCIDENT:1491",
  project: "stensibly",
  repository,
  pullRequestNumber: 1491,
  currentHeadRevision: revision,
  continuesFromThreadId: null,
};

async function prepare(
  eventType: string,
  deliveryId: string,
  payload: Record<string, unknown>,
) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const ingress = createGitHubWebhookIngress({ secret, expectedRepository: repository });
  return await ingress(new Request("https://stensibly.example/github/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Delivery": deliveryId,
      "X-GitHub-Event": eventType,
      "X-Hub-Signature-256": signature,
    },
    body,
  }));
}

function common() {
  return {
    repository: { full_name: repository },
    sender: { login: "github-actions[bot]" },
  };
}

describe("GitHub mail terminal webhook projection", () => {
  test("projects a signature-verified completed check_run into incident attention", async () => {
    const payload = {
      ...common(),
      action: "completed",
      check_run: {
        id: 8801,
        status: "completed",
        conclusion: "failure",
        head_sha: revision,
        completed_at: "2026-08-15T06:40:00Z",
        pull_requests: [{ number: 1491 }],
      },
    };
    const delivery = await prepare("check_run", "delivery-check-run-1", payload);
    expect(delivery.observation).toBeNull();
    const terminal = mapGitHubMailTerminalWebhook(delivery);
    expect(terminal).toMatchObject({
      sourceSchema: "check_run",
      repository,
      pullRequestNumber: 1491,
      revision,
      providerObjectId: "8801",
      conclusion: "failure",
      containsRawContent: false,
    });

    const decision = compileGitHubMailAttention({
      thread,
      signal: { kind: "terminal_status", observation: terminal! },
    });
    expect(decision).toMatchObject({
      threadId: thread.threadId,
      attentionClass: "incident",
      reason: "ci_failed",
      mailAction: "update",
    });
  });

  test("dedupes semantically identical redelivery independently from GitHub delivery identity", async () => {
    const payload = {
      ...common(),
      action: "completed",
      check_run: {
        id: 8802,
        status: "completed",
        conclusion: "failure",
        head_sha: revision,
        completed_at: "2026-08-15T06:41:00Z",
        pull_requests: [{ number: 1491 }],
      },
    };
    const first = mapGitHubMailTerminalWebhook(
      await prepare("check_run", "delivery-check-run-a", payload),
    )!;
    const second = mapGitHubMailTerminalWebhook(
      await prepare("check_run", "delivery-check-run-b", payload),
    )!;
    expect(first.deliveryId).not.toBe(second.deliveryId);
    expect(first.observationId).not.toBe(second.observationId);
    expect(first.semanticFingerprint).toBe(second.semanticFingerprint);

    const material = compileGitHubMailAttention({
      thread,
      signal: { kind: "terminal_status", observation: first },
    });
    const duplicate = compileGitHubMailAttention({
      thread,
      signal: { kind: "terminal_status", observation: second },
      priorMaterialFingerprint: material.materialFingerprint,
    });
    expect(duplicate).toMatchObject({ deduped: true, mailAction: "quiet" });
  });

  test("keeps nonterminal execution status quiet at the webhook mapper boundary", async () => {
    const delivery = await prepare("workflow_run", "delivery-workflow-running", {
      ...common(),
      action: "in_progress",
      workflow_run: {
        id: 9901,
        status: "in_progress",
        conclusion: null,
        head_sha: revision,
        updated_at: "2026-08-15T06:42:00Z",
        pull_requests: [{ number: 1491 }],
      },
    });
    expect(mapGitHubMailTerminalWebhook(delivery)).toBeNull();
  });

  test("maps terminal deployment status by exact revision when GitHub supplies no PR number", async () => {
    const delivery = await prepare("deployment_status", "delivery-deployment-failure", {
      ...common(),
      deployment: {
        id: 7001,
        sha: revision,
      },
      deployment_status: {
        id: 7002,
        state: "failure",
        updated_at: "2026-08-15T06:43:00Z",
      },
    });
    const terminal = mapGitHubMailTerminalWebhook(delivery)!;
    expect(terminal).toMatchObject({
      sourceSchema: "deployment_status",
      pullRequestNumber: null,
      revision,
      providerObjectId: "7002",
      conclusion: "failure",
    });
    expect(compileGitHubMailAttention({
      thread,
      signal: { kind: "terminal_status", observation: terminal },
    }).mailAction).toBe("update");
  });
});
