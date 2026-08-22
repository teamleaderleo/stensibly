import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  registerHostedProviderCapacityRoutes,
  type HostedGitHubMailWebhookConsumer,
  type HostedGitHubRepositoryObservationSink,
} from "../src/hosted-provider-capacity-api.ts";
import type { StensiblyEnv } from "../src/http-auth.ts";
import type { ProviderCapacityService } from "../src/provider-capacity-convex.ts";

const secret = "hosted-github-mail-route-secret";
const head = "a".repeat(40);
const base = "b".repeat(40);

function service(): ProviderCapacityService {
  return {
    async ingestCodeRabbit() {
      throw new Error("capacity should not run");
    },
    async snapshot() {
      throw new Error("capacity should not run");
    },
  };
}

function appWith(input: {
  sink?: HostedGitHubRepositoryObservationSink;
  mail?: HostedGitHubMailWebhookConsumer;
}) {
  const app = new Hono<StensiblyEnv>();
  registerHostedProviderCapacityRoutes(
    app,
    { async authenticate() { return null; } },
    { required: true },
    {
      service: service(),
      githubWebhookSecret: secret,
      now: () => Date.parse("2026-08-23T04:10:00.000Z"),
      ...(input.sink ? { repositoryObservationSink: input.sink } : {}),
      ...(input.mail ? { githubMailConsumer: input.mail } : {}),
    },
  );
  return app;
}

function pullRequestPayload() {
  return {
    action: "opened",
    repository: { full_name: "Coreys-Quarry/quarry" },
    sender: { login: "teamleaderleo" },
    number: 721,
    pull_request: {
      number: 721,
      state: "open",
      draft: false,
      locked: false,
      merged: false,
      updated_at: "2026-08-23T04:09:00.000Z",
      title: "Quarry candidate",
      body: "Bounded fixture body",
      head: { sha: head },
      base: { sha: base },
      merge_commit_sha: null,
    },
  };
}

function checkRunPayload() {
  return {
    action: "completed",
    repository: { full_name: "Coreys-Quarry/quarry" },
    sender: { login: "github-actions[bot]" },
    check_run: {
      id: 8801,
      status: "completed",
      conclusion: "failure",
      head_sha: head,
      completed_at: "2026-08-23T04:09:30.000Z",
      pull_requests: [{ number: 721, head: { sha: head } }],
    },
  };
}

async function post(app: Hono<StensiblyEnv>, payload: object, delivery: string, eventType: string) {
  const body = JSON.stringify(payload);
  return await app.request("/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": delivery,
      "x-github-event": eventType,
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
  });
}

describe("hosted GitHub webhook automatic mail mount", () => {
  test("durably ingests repository observation before invoking automatic mail", async () => {
    const calls: string[] = [];
    const response = await post(appWith({
      sink: {
        async ingestRepositoryObservation() {
          calls.push("repository");
          return { duplicate: false };
        },
      },
      mail: {
        async consume() {
          calls.push("mail");
          return { status: "published" } as const;
        },
      },
    }), pullRequestPayload(), "delivery-mail-route-pr", "pull_request");

    expect(calls).toEqual(["repository", "mail"]);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: true,
      duplicate: false,
      repositoryObservation: { accepted: true, duplicate: false },
      automaticMail: { status: "published" },
    });
  });

  test("repository persistence failure stops before automatic mail", async () => {
    let mailCalls = 0;
    const response = await post(appWith({
      sink: {
        async ingestRepositoryObservation() {
          throw new Error("durable sink unavailable");
        },
      },
      mail: {
        async consume() {
          mailCalls += 1;
          return { status: "published" } as const;
        },
      },
    }), pullRequestPayload(), "delivery-mail-route-store-fail", "pull_request");

    expect(response.status).toBe(500);
    expect(mailCalls).toBe(0);
  });

  test("automatic mail failure asks GitHub to retry after durable observation acceptance", async () => {
    let repositoryCalls = 0;
    const response = await post(appWith({
      sink: {
        async ingestRepositoryObservation() {
          repositoryCalls += 1;
          return { duplicate: false };
        },
      },
      mail: {
        async consume() {
          throw new Error("mail temporarily unavailable");
        },
      },
    }), pullRequestPayload(), "delivery-mail-route-mail-fail", "pull_request");

    expect(repositoryCalls).toBe(1);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toEqual({
      error: "GitHub automatic mail projection failed",
      code: "temporarily_unavailable",
    });
  });

  test("terminal GitHub delivery can be handled by mail without a repository observation row", async () => {
    let mailCalls = 0;
    const response = await post(appWith({
      mail: {
        async consume(delivery) {
          mailCalls += 1;
          expect(delivery.observation).toBeNull();
          return { status: "quiet" } as const;
        },
      },
    }), checkRunPayload(), "delivery-mail-route-check", "check_run");

    expect(mailCalls).toBe(1);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: true,
      duplicate: false,
      automaticMail: { status: "quiet" },
    });
  });
});
