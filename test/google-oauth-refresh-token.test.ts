import { expect, test } from "bun:test";
import {
  GoogleOAuthRefreshError,
  GoogleOAuthRefreshTokenProvider,
} from "../src/google-oauth-refresh-token.ts";

test("refreshes once, caches the access token, and never echoes credential failures", async () => {
  let calls = 0;
  let now = 1_000_000;
  const provider = new GoogleOAuthRefreshTokenProvider({
    clientId: "client-id",
    clientSecret: "super-secret-client-value",
    refreshToken: "super-secret-refresh-value",
    now: () => now,
    fetch: async (_input, init) => {
      calls += 1;
      expect(init?.method).toBe("POST");
      const body = String(init?.body);
      expect(body).toContain("grant_type=refresh_token");
      expect(body).toContain("client_id=client-id");
      return new Response(JSON.stringify({
        access_token: "access-token-value-1234567890",
        expires_in: 3600,
        token_type: "Bearer",
      }), { status: 200 });
    },
  });

  expect(await provider.getAccessToken()).toBe("access-token-value-1234567890");
  expect(await provider.getAccessToken()).toBe("access-token-value-1234567890");
  expect(calls).toBe(1);

  now += 3_550_000;
  expect(await provider.getAccessToken()).toBe("access-token-value-1234567890");
  expect(calls).toBe(2);
});

test("normalizes provider failure without credential text", async () => {
  const provider = new GoogleOAuthRefreshTokenProvider({
    clientId: "client-id",
    clientSecret: "do-not-echo-client-secret",
    refreshToken: "do-not-echo-refresh-token",
    fetch: async () => new Response("do-not-echo-provider-body", { status: 401 }),
  });
  try {
    await provider.getAccessToken();
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(GoogleOAuthRefreshError);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toContain("do-not-echo");
    expect(message).toBe("Google OAuth credential refresh failed");
  }
});
