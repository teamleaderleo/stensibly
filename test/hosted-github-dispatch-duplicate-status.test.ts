import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  registerHostedProviderCapacityRoutes,
  type HostedGitHubRepositoryObservationSink,
} from "../src/hosted-provider-capacity-api.ts";
import type { StensiblyEnv } from "../src/http-auth.ts";
import type { ProviderCapacityService } from "../src/provider-capacity-convex.ts";

const secret = "hosted-provider-capacity-secret";
const receivedAt = "2026-07-28T13:00:01.000Z";

const cases = [
  {
    repositoryDuplicate: false,
    capacityDuplicate: true,
    expectedStatus: 202,
    expectedDuplicate: false,
  },
  {
    repositoryDuplicate: true,
    capacityDuplicate: false,
    expectedStatus: 202,
    expectedDuplicate: false,
  },
  {
    repositoryDuplicate: true,
    capacityDuplicate: true,
    expectedStatus: 200,
    expectedDuplicate: true,
  },
] as const;

describe("hosted GitHub dispatch duplicate status", () => {
  test("reports a duplicate delivery only when every invoked consumer reports replay", async () => {
    for (const [index, entry] of cases.entries()) {
      const service: ProviderCapacityService = {
        async ingestCodeRabbit(input) {
          return {
            duplicate: entry.capacityDuplicate,
            observation: {
              id: `capacity_${index}`,
              provider: "coderabbit",
              deliveryId: input.deliveryId,
              sourceCommentId: input.sourceCommentId,
              repository: input.repository,
              pullRequestNumber: input.pullRequestNumber,
              subjectLogin: input.subjectLogin,
              subjectBasis: "pull_request_author_proxy",
              state: input.state,
              remaining: input.remaining,
              limit: input.limit,
              refillAt: input.refillAt,
              observedAt: input.observedAt,
              receivedAt: input.receivedAt,
            },
          };
        },
        async snapshot() {
          throw new Error("not expected");
        },
      };
      const sink: HostedGitHubRepositoryObservationSink = {
        async ingestRepositoryObservation() {
          return { duplicate: entry.repositoryDuplicate };
        },
      };
      const app = appWith(service, sink);
      const body = JSON.stringify(payload());
      const response = await app.request("/webhooks/github", {
        method: "POST",
        headers: signedHeaders(body, `delivery-${index}`),
        body,
      });

      expect(response.status).toBe(entry.expectedStatus);
      expect(await response.json()).toMatchObject({
        accepted: true,
        duplicate: entry.expectedDuplicate,
        repositoryObservation: {
          accepted: true,
          duplicate: entry.repositoryDuplicate,
        },
        capacityObservation: {
          deliveryId: `delivery-${index}`,
        },
      });
    }
  });
});

function appWith(
  service: ProviderCapacityService,
  repositoryObservationSink: HostedGitHubRepositoryObservationSink,
) {
  const app = new Hono<StensiblyEnv>();
  registerHostedProviderCapacityRoutes(
    app,
    {
      async authenticate() {
        return null;
      },
    },
    { required: true },
    {
      service,
      repositoryObservationSink,
      githubWebhookSecret: secret,
      now: () => Date.parse(receivedAt),
    },
  );
  return app;
}

function payload() {
  return {
    action: "created",
    repository: { full_name: "teamleaderleo/stensibly" },
    issue: {
      number: 421,
      pull_request: {
        url: "https://api.github.com/repos/teamleaderleo/stensibly/pulls/421",
      },
      user: { login: "teamleaderleo" },
    },
    comment: {
      id: 5_104_466_293,
      body: "Reviews are available now.",
      created_at: "2026-07-28T13:00:00.000Z",
      updated_at: "2026-07-28T13:00:00.000Z",
      user: { login: "coderabbitai[bot]" },
    },
    sender: { login: "coderabbitai[bot]" },
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
