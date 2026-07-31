import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  digestGitHubWebhookPayload,
  mapGitHubRepositoryWebhook,
} from "../src/github-repository-observation.ts";
import type {
  HostedGitHubRepositoryObservationReader,
} from "../src/github-repository-observation-convex.ts";
import {
  registerHostedProviderCapacityRoutes,
} from "../src/hosted-provider-capacity-api.ts";
import type { StensiblyEnv } from "../src/http-auth.ts";
import type { ProviderCapacityService } from "../src/provider-capacity-convex.ts";

const repository = "teamleaderleo/stensibly";
const revision = "a".repeat(40);
const webhookSecret = "observation-read-route-secret";

const capacityService: ProviderCapacityService = {
  async ingestCodeRabbit() {
    throw new Error("capacity ingest is outside this read proof");
  },
  async snapshot() {
    throw new Error("capacity snapshot is outside this read proof");
  },
};

function observation() {
  const payload = {
    repository: { full_name: repository },
    sender: { login: "github-actions[bot]" },
    ref: "refs/heads/main",
    before: "1".repeat(40),
    after: revision,
    size: 1,
    head_commit: { timestamp: "2026-08-01T00:00:00.000Z" },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const mapped = mapGitHubRepositoryWebhook({
    eventType: "push",
    deliveryId: "delivery-observation-read",
    payloadDigest: digestGitHubWebhookPayload(bytes),
    signatureVerified: true,
    receivedAt: "2026-08-01T00:00:01.000Z",
    expectedRepository: repository,
    payload,
  });
  if (!mapped) throw new Error("Expected a push observation");
  return mapped;
}

function appWith(reader?: HostedGitHubRepositoryObservationReader) {
  const app = new Hono<StensiblyEnv>();
  registerHostedProviderCapacityRoutes(
    app,
    {
      async authenticate(token) {
        if (token === "read-token") {
          return {
            tokenId: "tok_observation_reader",
            name: "Observation reader",
            scopes: ["read"],
            projects: null,
          };
        }
        if (token === "project-token") {
          return {
            tokenId: "tok_project_reader",
            name: "Project reader",
            scopes: ["read"],
            projects: ["scrapbook"],
          };
        }
        return null;
      },
    },
    { required: true },
    {
      service: capacityService,
      githubWebhookSecret: webhookSecret,
      ...(reader ? { repositoryObservationReader: reader } : {}),
    },
  );
  return app;
}

function path(limit = "10") {
  return "/api/v1/github/repository-observations"
    + `?repository=${encodeURIComponent(repository)}&limit=${limit}`;
}

describe("hosted GitHub repository observation read route", () => {
  test("requires workspace-wide read authentication and returns bounded admitted rows", async () => {
    const calls: Array<{ repository: string; limit: number }> = [];
    const reader: HostedGitHubRepositoryObservationReader = {
      async listRecentRepositoryObservations(requestedRepository, limit) {
        calls.push({ repository: requestedRepository, limit: limit ?? 50 });
        return Object.freeze([Object.freeze({
          id: "observation-row-read-route",
          observation: observation(),
          createdAt: "2026-08-01T00:00:02.000Z",
        })]);
      },
    };
    const app = appWith(reader);

    const anonymous = await app.request(path());
    expect(anonymous.status).toBe(401);
    expect(calls).toEqual([]);

    const projectScoped = await app.request(path(), {
      headers: { authorization: "Bearer project-token" },
    });
    expect(projectScoped.status).toBe(403);
    expect(await projectScoped.json()).toEqual({
      error: "Repository observation history requires workspace-wide read access",
      code: "forbidden",
    });
    expect(calls).toEqual([]);

    const response = await app.request(path(), {
      headers: { authorization: "Bearer read-token" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(calls).toEqual([{ repository, limit: 10 }]);
    expect(await response.json()).toMatchObject({
      observations: [{
        id: "observation-row-read-route",
        createdAt: "2026-08-01T00:00:02.000Z",
        observation: {
          provider: "github",
          eventType: "push",
          repository,
          containsRawContent: false,
          relationships: { revision },
        },
      }],
    });
  });

  test("rejects missing or unbounded query input before backend access", async () => {
    let calls = 0;
    const app = appWith({
      async listRecentRepositoryObservations() {
        calls += 1;
        return [];
      },
    });
    for (const invalidPath of [
      "/api/v1/github/repository-observations?limit=10",
      path("0"),
      path("101"),
      path("1.5"),
    ]) {
      const response = await app.request(invalidPath, {
        headers: { authorization: "Bearer read-token" },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "GitHub repository observations require a repository and limit from 1 to 100",
        code: "invalid_request",
      });
    }
    expect(calls).toBe(0);
  });

  test("sanitizes invalid and failed backend reads", async () => {
    const invalid = appWith({
      async listRecentRepositoryObservations() {
        throw new RangeError("credential-shaped provider text");
      },
    });
    const invalidResponse = await invalid.request(path(), {
      headers: { authorization: "Bearer read-token" },
    });
    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toEqual({
      error: "GitHub repository observation read is invalid",
      code: "invalid_request",
    });

    const failed = appWith({
      async listRecentRepositoryObservations() {
        throw new Error("private backend text");
      },
    });
    const failedResponse = await failed.request(path(), {
      headers: { authorization: "Bearer read-token" },
    });
    expect(failedResponse.status).toBe(500);
    expect(await failedResponse.json()).toEqual({
      error: "GitHub repository observation read failed",
      code: "backend_failure",
    });
  });

  test("does not advertise the route when no reader is mounted", async () => {
    const response = await appWith().request(path(), {
      headers: { authorization: "Bearer read-token" },
    });
    expect(response.status).toBe(404);
  });
});
