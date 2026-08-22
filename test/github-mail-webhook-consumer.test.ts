import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  GitHubMailWebhookConsumer,
  type GitHubMailWebhookConsumeResult,
} from "../src/github-mail-webhook-consumer.ts";
import type { HostedGmailOutboundMaterial } from "../src/hosted-gmail-outbound-service.ts";
import { createGitHubWebhookIngress } from "../src/github-webhook-ingress.ts";
import { SqliteMailThreadStore } from "../src/mail-thread-store.ts";

const secret = "github-webhook-secret-for-mail-consumer";
const repository = "Coreys-Quarry/quarry";
const canonicalRepository = repository.toLowerCase();
const headA = "a".repeat(40);
const headB = "b".repeat(40);
const base = "c".repeat(40);

class CapturePublisher {
  readonly materials: HostedGmailOutboundMaterial[] = [];

  async publish(material: HostedGmailOutboundMaterial) {
    this.materials.push(structuredClone(material));
    return { call: this.materials.length };
  }
}

function fixture() {
  const store = new SqliteMailThreadStore({ path: ":memory:" });
  const publisher = new CapturePublisher();
  const consumer = new GitHubMailWebhookConsumer({
    store,
    publisher,
    workspace: "default",
    project: "quarry",
    repository,
    publicProjectCode: "QRY",
    now: () => "2026-08-23T04:00:00.000Z",
    threadIdFactory: () => "mail_thread_quarry_721",
    handleFactory: () => "STN-REVIEW:Q7R4",
  });
  return { store, publisher, consumer };
}

async function delivery(
  eventType: string,
  payload: Record<string, unknown>,
  deliveryId: string,
) {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const ingress = createGitHubWebhookIngress({
    secret,
    now: () => Date.parse("2026-08-23T04:00:00.000Z"),
  });
  return await ingress(new Request("https://api.stensibly.test/webhooks/github", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Delivery": deliveryId,
      "X-GitHub-Event": eventType,
      "X-Hub-Signature-256": `sha256=${signature}`,
    },
    body,
  }));
}

function common() {
  return {
    repository: { full_name: repository },
    sender: { login: "teamleaderleo" },
  };
}

function pullRequestPayload(action: string, head: string, draft = false) {
  return {
    ...common(),
    action,
    number: 721,
    pull_request: {
      number: 721,
      state: action === "closed" ? "closed" : "open",
      draft,
      locked: false,
      merged: action === "closed",
      updated_at: "2026-08-23T03:59:00.000Z",
      title: "Quarry candidate",
      body: "Bounded fixture body",
      head: { sha: head },
      base: { sha: base },
      merge_commit_sha: null,
    },
  };
}

function reviewPayload(reviewRevision: string, currentHead: string) {
  return {
    ...common(),
    action: "submitted",
    pull_request: {
      number: 721,
      updated_at: "2026-08-23T03:59:10.000Z",
      head: { sha: currentHead },
    },
    review: {
      id: 9001,
      commit_id: reviewRevision,
      state: "approved",
      body: "Approved",
      submitted_at: "2026-08-23T03:59:10.000Z",
    },
  };
}

function checkRunPayload(revision: string, currentHead: string) {
  return {
    ...common(),
    action: "completed",
    check_run: {
      id: 8801,
      status: "completed",
      conclusion: "failure",
      head_sha: revision,
      completed_at: "2026-08-23T03:59:20.000Z",
      pull_requests: [{ number: 721, head: { sha: currentHead } }],
    },
  };
}

describe("hosted GitHub webhook automatic mail consumer", () => {
  test("creates a canonical thread only when a matching PR event is material", async () => {
    const f = fixture();
    const prepared = await delivery(
      "pull_request",
      pullRequestPayload("opened", headA),
      "delivery-open-721",
    );

    const result = await f.consumer.consume(prepared);

    expect(result).toMatchObject({
      status: "published",
      threadId: "mail_thread_quarry_721",
      handle: "STN-REVIEW:Q7R4",
      result: { call: 1 },
    });
    expect(f.publisher.materials).toHaveLength(1);
    expect(f.publisher.materials[0]).toMatchObject({
      sourceIdentity: `github:${canonicalRepository}#721`,
      sourceRevision: headA,
      publicProjectCode: "QRY",
      currentMailboxState: {
        operatorAttentionRequired: false,
      },
    });
    expect(await f.store.getThreadBySource("default", "quarry", `github:${canonicalRepository}#721`))
      .toMatchObject({
        threadId: "mail_thread_quarry_721",
        handle: "STN-REVIEW:Q7R4",
      });
    f.store.close();
  });

  test("draft and unrelated repository activity stays quiet without creating a thread", async () => {
    const f = fixture();
    const draft = await delivery(
      "pull_request",
      pullRequestPayload("opened", headA, true),
      "delivery-draft-721",
    );
    const draftResult = await f.consumer.consume(draft);
    expect(draftResult.status).toBe("quiet");
    expect(f.publisher.materials).toHaveLength(0);
    expect(await f.store.getThreadBySource("default", "quarry", `github:${canonicalRepository}#721`))
      .toBeNull();

    const foreign = await delivery(
      "pull_request",
      {
        ...pullRequestPayload("opened", headA),
        repository: { full_name: "teamleaderleo/stensibly" },
      },
      "delivery-foreign-721",
    );
    expect(await f.consumer.consume(foreign)).toEqual({
      status: "ignored",
      reason: "repository_mismatch",
    });
    f.store.close();
  });

  test("rejects a stale formal review against the verified current PR head", async () => {
    const f = fixture();
    const stale = await delivery(
      "pull_request_review",
      reviewPayload(headA, headB),
      "delivery-review-stale-721",
    );

    await expect(f.consumer.consume(stale)).rejects.toThrow(
      "GitHub formal review belongs to a stale pull request revision",
    );
    expect(f.publisher.materials).toHaveLength(0);
    f.store.close();
  });

  test("publishes terminal failure only when the verified PR reference proves the same current head", async () => {
    const f = fixture();
    await f.consumer.consume(await delivery(
      "pull_request",
      pullRequestPayload("opened", headA),
      "delivery-open-before-ci-721",
    ));

    const failed = await f.consumer.consume(await delivery(
      "check_run",
      checkRunPayload(headA, headA),
      "delivery-check-failed-721",
    ));
    expect(failed.status).toBe("published");
    expect(f.publisher.materials).toHaveLength(2);
    expect(f.publisher.materials[1]).toMatchObject({
      sourceRevision: headA,
      blocker: "Required CI is failing on the observed candidate.",
      publicProjectCode: "QRY",
    });

    await expect(f.consumer.consume(await delivery(
      "check_run",
      checkRunPayload(headA, headB),
      "delivery-check-stale-721",
    ))).rejects.toThrow(
      "GitHub terminal status belongs to a stale pull request revision",
    );
    expect(f.publisher.materials).toHaveLength(2);
    f.store.close();
  });

  test("terminal evidence without a current-head proof stays ignored", async () => {
    const f = fixture();
    const payload = checkRunPayload(headA, headA);
    (payload.check_run as { pull_requests: unknown[] }).pull_requests = [{ number: 721 }];
    const result: GitHubMailWebhookConsumeResult<{ call: number }> = await f.consumer.consume(
      await delivery("check_run", payload, "delivery-check-unbound-head-721"),
    );
    expect(result).toEqual({
      status: "ignored",
      reason: "current_head_unavailable",
    });
    expect(f.publisher.materials).toHaveLength(0);
    f.store.close();
  });
});
