import { describe, expect, test } from "bun:test";
import { enforceHostedAuthStartAdmission } from "../src/hosted-auth-start-admission.js";

describe("hosted auth start admission", () => {
  test("admits a bounded OAuth start request", async () => {
    const keys: string[] = [];
    const response = await enforceHostedAuthStartAdmission(
      new Request("https://api.stensibly.com/auth/github/start"),
      {
        enabled: true,
        rateLimiter: {
          async limit(input) {
            keys.push(input.key);
            return { success: true };
          },
        },
      },
    );

    expect(response).toBeNull();
    expect(keys).toEqual(["github-auth-start"]);
  });

  test("rejects an exhausted limiter before durable state creation", async () => {
    const response = await enforceHostedAuthStartAdmission(
      new Request("https://api.stensibly.com/auth/github/start"),
      {
        enabled: true,
        rateLimiter: { async limit() { return { success: false }; } },
      },
    );

    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("60");
    expect(response?.headers.get("x-stensibly-failure-category")).toBe("auth_failure");
  });

  test("fails closed when the configured limiter is missing or unavailable", async () => {
    const request = new Request("https://api.stensibly.com/auth/github/start");
    expect((await enforceHostedAuthStartAdmission(request, { enabled: true }))?.status).toBe(503);
    expect((await enforceHostedAuthStartAdmission(request, {
      enabled: true,
      rateLimiter: { async limit() { throw new Error("unavailable"); } },
    }))?.status).toBe(503);
  });

  test("does not affect other routes or disabled hosted auth", async () => {
    const limiter = { async limit() { throw new Error("must not run"); } };
    expect(await enforceHostedAuthStartAdmission(
      new Request("https://api.stensibly.com/auth/github/callback"),
      { enabled: true, rateLimiter: limiter },
    )).toBeNull();
    expect(await enforceHostedAuthStartAdmission(
      new Request("https://api.stensibly.com/auth/github/start"),
      { enabled: false, rateLimiter: limiter },
    )).toBeNull();
  });
});
