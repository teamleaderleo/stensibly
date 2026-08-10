import { expect, test } from "bun:test";
import {
  createHostedAuth,
  type GitHubOAuthClient,
} from "../src/hosted-auth.ts";
import type { HostedAccountService } from "../src/hosted-account-service.ts";

const authOrigin = "https://api.stensibly.com";

test("hosted callback keeps arbitrary GitHub client failures opaque", async () => {
  const states = new Map<string, {
    secretHash: string;
    pkceVerifierHash: string;
    returnTo: string;
    expiresAt: number;
  }>();
  const accountService = {
    async createOAuthState(input: {
      id: string;
      secretHash: string;
      pkceVerifierHash: string;
      returnTo: string;
      expiresAt: number;
    }) {
      states.set(input.id, input);
      return {
        id: input.id,
        returnTo: input.returnTo,
        expiresAt: new Date(input.expiresAt).toISOString(),
        consumedAt: null,
      };
    },
    async consumeOAuthState(input: {
      id: string;
      secretHash: string;
      pkceVerifierHash: string;
    }) {
      const state = states.get(input.id);
      if (
        !state
        || state.secretHash !== input.secretHash
        || state.pkceVerifierHash !== input.pkceVerifierHash
      ) return null;
      states.delete(input.id);
      return {
        id: input.id,
        returnTo: state.returnTo,
        expiresAt: new Date(state.expiresAt).toISOString(),
        consumedAt: "2026-08-10T05:00:00.000Z",
      };
    },
  } as unknown as HostedAccountService;

  let prototypeReads = 0;
  const hostile = new Proxy(Object.create(null), {
    getPrototypeOf() {
      prototypeReads += 1;
      throw new Error("foreign provider failure prototype must remain opaque");
    },
  });
  const githubClient: GitHubOAuthClient = {
    async exchangeCode() {
      throw hostile;
    },
    async readIdentity() {
      throw new Error("identity must remain unreachable");
    },
  };
  let randomCall = 0;
  const app = createHostedAuth({
    accountService,
    githubClient,
    githubClientId: "github-client-id",
    authOrigin,
    allowedReturnOrigins: ["https://www.stensibly.com"],
    allowedGitHubSubjects: ["1001"],
    now: () => Date.parse("2026-08-10T05:00:00.000Z"),
    randomBytes: (length) => new Uint8Array(length).fill(++randomCall),
  });

  const started = await app.request("/github/start");
  const state = new URL(started.headers.get("location") ?? "")
    .searchParams.get("state") ?? "";
  const cookieHeader = started.headers.get("set-cookie") ?? "";
  const cookieMatch = /__Secure-stensibly-oauth-state=([^;]+)/u.exec(cookieHeader);
  if (!cookieMatch) throw new Error("OAuth state cookie was missing");

  const failed = await app.request(
    `/github/callback?code=valid-code&state=${encodeURIComponent(state)}`,
    { headers: { cookie: `__Secure-stensibly-oauth-state=${cookieMatch[1]}` } },
  );

  expect(failed.status).toBe(502);
  expect(await failed.json()).toEqual({
    error: "GitHub authentication failed",
    code: "provider_failure",
    stage: "token_exchange",
    operation: "exchange",
  });
  expect(prototypeReads).toBe(0);
});
