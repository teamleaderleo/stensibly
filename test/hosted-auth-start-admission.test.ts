import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import worker from "../src/cloudflare-worker.ts";
import {
  enforceHostedAuthStartAdmission,
  type EdgeRateLimiter,
  type HostedAuthStartAdmissionOptions,
} from "../src/hosted-auth-start-admission.js";
import { REQUIRED_PRODUCTION_BINDINGS } from "../scripts/worker-production-release.js";

describe("hosted auth start admission", () => {
  test("admits a bounded OAuth start request with a per-client key", async () => {
    const keys: string[] = [];
    const response = await enforceHostedAuthStartAdmission(
      authStartRequest("/auth/github/start", "203.0.113.7"),
      {
        enabled: true,
        rateLimiter: recordingLimiter(keys, true),
      },
    );

    expect(response).toBeNull();
    expect(keys).toEqual(["github-auth-start:203.0.113.7"]);
  });

  test("keeps independent clients in independent limiter buckets", async () => {
    const keys: string[] = [];
    const rateLimiter = recordingLimiter(keys, true);

    for (const clientAddress of ["203.0.113.8", "2001:db8::9"]) {
      expect(await enforceHostedAuthStartAdmission(
        authStartRequest("/auth/github/start", clientAddress),
        { enabled: true, rateLimiter },
      )).toBeNull();
    }

    expect(keys).toEqual([
      "github-auth-start:203.0.113.8",
      "github-auth-start:2001:db8::9",
    ]);
  });

  test("applies the limiter to encoded route characters before durable state creation", async () => {
    for (const path of ["/auth/github/%73tart", "/%61uth/github/start"]) {
      const keys: string[] = [];
      const result = await runWithFakeStateCreation(
        authStartRequest(path, "203.0.113.10"),
        {
          enabled: true,
          rateLimiter: recordingLimiter(keys, false),
        },
      );

      expect(result.response.status).toBe(429);
      expect(result.stateCreationCalls).toBe(0);
      expect(result.response.headers.get("retry-after")).toBe("60");
      expect(keys).toEqual(["github-auth-start:203.0.113.10"]);
    }
  });

  test("keeps encoded reserved separators outside the accepted auth-start route", async () => {
    const keys: string[] = [];
    expect(await enforceHostedAuthStartAdmission(
      authStartRequest("/auth/github%2Fstart", "203.0.113.11"),
      {
        enabled: true,
        rateLimiter: recordingLimiter(keys, false),
      },
    )).toBeNull();
    expect(keys).toEqual([]);
  });

  test("fails closed when client identity or limiter capability is unavailable", async () => {
    const missingIdentity = await enforceHostedAuthStartAdmission(
      new Request("https://api.stensibly.com/auth/github/start"),
      {
        enabled: true,
        rateLimiter: recordingLimiter([], true),
      },
    );
    expect(missingIdentity?.status).toBe(503);

    const overlongIdentity = await enforceHostedAuthStartAdmission(
      authStartRequest("/auth/github/start", "x".repeat(65)),
      {
        enabled: true,
        rateLimiter: recordingLimiter([], true),
      },
    );
    expect(overlongIdentity?.status).toBe(503);

    expect((await enforceHostedAuthStartAdmission(
      authStartRequest("/auth/github/start", "203.0.113.12"),
      { enabled: true },
    ))?.status).toBe(503);

    expect((await enforceHostedAuthStartAdmission(
      authStartRequest("/auth/github/start", "203.0.113.12"),
      {
        enabled: true,
        rateLimiter: {
          async limit() {
            throw new Error("binding unavailable");
          },
        },
      },
    ))?.status).toBe(503);
  });

  test("does not expose the Cloudflare client identity in a rejection", async () => {
    const clientAddress = "203.0.113.15";
    const response = await enforceHostedAuthStartAdmission(
      authStartRequest("/auth/github/start", clientAddress),
      {
        enabled: true,
        rateLimiter: recordingLimiter([], false),
      },
    );

    expect(response?.status).toBe(429);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("retry-after")).toBe("60");
    expect(await response?.text()).not.toContain(clientAddress);
    expect(JSON.stringify([...response?.headers.entries() ?? []])).not.toContain(clientAddress);
  });

  test("does not affect other routes, methods, or disabled hosted auth", async () => {
    const limiter: EdgeRateLimiter = {
      async limit() {
        throw new Error("must not run");
      },
    };
    expect(await enforceHostedAuthStartAdmission(
      authStartRequest("/auth/github/callback", "203.0.113.13"),
      { enabled: true, rateLimiter: limiter },
    )).toBeNull();
    expect(await enforceHostedAuthStartAdmission(
      authStartRequest("/auth/github/start", "203.0.113.13", "POST"),
      { enabled: true, rateLimiter: limiter },
    )).toBeNull();
    expect(await enforceHostedAuthStartAdmission(
      authStartRequest("/auth/github/start", "203.0.113.13"),
      { enabled: false, rateLimiter: limiter },
    )).toBeNull();
  });

  test("Worker edge rejects an encoded auth start before constructing the hosted app", async () => {
    const keys: string[] = [];
    const response = await worker.fetch(
      authStartRequest("/auth/github/%73tart", "203.0.113.14"),
      {
        CONVEX_URL: "https://example.convex.cloud",
        STENSIBLY_SERVICE_SECRET: "test-service-secret",
        GITHUB_OAUTH_CLIENT_ID: "configured",
        HOSTED_AUTH_START_RATE_LIMITER: recordingLimiter(keys, false),
      },
    );

    expect(response.status).toBe(429);
    expect(keys).toEqual(["github-auth-start:203.0.113.14"]);
  });

  test("production config requires the dedicated Cloudflare rate-limit binding", async () => {
    expect(REQUIRED_PRODUCTION_BINDINGS.HOSTED_AUTH_START_RATE_LIMITER).toEqual({
      name: "HOSTED_AUTH_START_RATE_LIMITER",
      type: "ratelimit",
    });

    const wrangler = JSON.parse(await readFile(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8",
    )) as {
      ratelimits?: Array<{
        name?: string;
        namespace_id?: string;
        simple?: { limit?: number; period?: number };
      }>;
    };
    expect(wrangler.ratelimits?.find((entry) => (
      entry.name === "HOSTED_AUTH_START_RATE_LIMITER"
    ))).toEqual({
      name: "HOSTED_AUTH_START_RATE_LIMITER",
      namespace_id: "25202",
      simple: { limit: 20, period: 60 },
    });
  });
});

function authStartRequest(
  path: string,
  clientAddress?: string,
  method = "GET",
): Request {
  return new Request(`https://api.stensibly.com${path}`, {
    method,
    ...(clientAddress
      ? { headers: { "CF-Connecting-IP": clientAddress } }
      : {}),
  });
}

function recordingLimiter(keys: string[], success: boolean): EdgeRateLimiter {
  return {
    async limit(input) {
      keys.push(input.key);
      return { success };
    },
  };
}

async function runWithFakeStateCreation(
  request: Request,
  options: HostedAuthStartAdmissionOptions,
): Promise<{ response: Response; stateCreationCalls: number }> {
  let stateCreationCalls = 0;
  const rejection = await enforceHostedAuthStartAdmission(request, options);
  if (rejection) return { response: rejection, stateCreationCalls };
  stateCreationCalls += 1;
  return {
    response: new Response(null, { status: 302 }),
    stateCreationCalls,
  };
}
