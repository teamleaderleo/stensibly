import { describe, expect, test } from "bun:test";
import {
  createGithubSignInUrl,
  createHostedLogoutUrl,
  describeHostedSessionRecovery,
  hostedSessionSentinel,
  installHostedSessionFetchBridge,
  isDefaultHostedEndpoint,
  isHostedSessionSentinel,
  prepareHostedSessionRequest,
  revokeHostedSession,
  type HostedSessionResponseObservation,
} from "../site/hosted-session.js";

const endpoint = "https://api.stensibly.com";

describe("hosted dashboard session marker", () => {
  test("generates one plausible, non-secret marker without accepting lookalikes", () => {
    const marker = hostedSessionSentinel();
    expect(marker).toMatch(/^stn\.tok_[a-f0-9]{32}\.[A-Za-z0-9_-]{40,}$/);
    expect(isHostedSessionSentinel(marker)).toBe(true);
    expect(isHostedSessionSentinel(`${marker}x`)).toBe(false);
  });

  test("keeps persisted custom endpoints outside hosted-session mode", () => {
    expect(isDefaultHostedEndpoint(`${endpoint}/`, endpoint)).toBe(true);
    expect(isDefaultHostedEndpoint("https://self-hosted.example", endpoint)).toBe(false);
  });
});

describe("hosted dashboard request bridge", () => {
  test("uses cookies only for hosted REST and never sends the session marker", () => {
    const marker = hostedSessionSentinel();
    const hosted = prepareHostedSessionRequest(`${endpoint}/api/v1/items`, {
      headers: { authorization: `Bearer ${marker}` },
    }, endpoint);
    expect(hosted.request.headers.get("authorization")).toBeNull();
    expect(hosted.credentials).toBe("include");

    const manualToken = `stn.tok_${"a".repeat(32)}.${"B".repeat(43)}`;
    const bearer = prepareHostedSessionRequest(`${endpoint}/api/v1/items`, {
      headers: { authorization: `Bearer ${manualToken}` },
    }, endpoint);
    expect(bearer.request.headers.get("authorization")).toBe(`Bearer ${manualToken}`);
    expect(bearer.credentials).toBe("omit");

    const mcp = prepareHostedSessionRequest(`${endpoint}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${marker}` },
    }, endpoint);
    expect(mcp.request.headers.get("authorization")).toBeNull();
    expect(mcp.credentials).toBe("omit");

    const foreign = prepareHostedSessionRequest("https://other.example/api/v1/items", {
      headers: { authorization: `Bearer ${marker}` },
    }, endpoint);
    expect(foreign.request.headers.get("authorization")).toBeNull();
    expect(foreign.credentials).toBe("omit");
  });

  test("installs a bridge that forwards the explicit credential mode", async () => {
    const observed: Array<{ request: Request; credentials: RequestCredentials | undefined }> = [];
    const fetchImpl = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      observed.push({
        request: input instanceof Request ? input : new Request(input),
        credentials: init?.credentials,
      });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const bridgedFetch = installHostedSessionFetchBridge({
      fetchImpl,
      sessionOrigin: endpoint,
    });
    const marker = hostedSessionSentinel();
    const response = await bridgedFetch(`${endpoint}/api/v1/principal`, {
      headers: { authorization: `Bearer ${marker}` },
    });
    expect(response.status).toBe(204);
    const observedRequest = observed[0];
    expect(observedRequest).toBeDefined();
    if (!observedRequest) throw new Error("The bridge did not forward a request.");
    expect(observedRequest.credentials).toBe("include");
    expect(observedRequest.request.headers.get("authorization")).toBeNull();
  });

  test("observes hosted responses without observing bearer requests or changing results", async () => {
    const observations: HostedSessionResponseObservation[] = [];
    const fetchImpl = (async () => new Response(
      JSON.stringify({ error: "Account requires read scope" }),
      { status: 403, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
    const bridgedFetch = installHostedSessionFetchBridge({
      fetchImpl,
      sessionOrigin: endpoint,
      onHostedSessionResponse: (observation) => observations.push(observation),
    });
    const marker = hostedSessionSentinel();
    const response = await bridgedFetch(`${endpoint}/api/v1/items`, {
      headers: { authorization: `Bearer ${marker}` },
    });
    expect(response.status).toBe(403);
    expect(observations).toEqual([{
      status: 403,
      method: "GET",
      url: `${endpoint}/api/v1/items`,
    }]);

    const manualToken = `stn.tok_${"a".repeat(32)}.${"B".repeat(43)}`;
    await bridgedFetch(`${endpoint}/api/v1/items`, {
      headers: { authorization: `Bearer ${manualToken}` },
    });
    expect(observations).toHaveLength(1);

    const callbackFailure = installHostedSessionFetchBridge({
      fetchImpl: (async () => new Response(null, { status: 204 })) as typeof fetch,
      sessionOrigin: endpoint,
      onHostedSessionResponse: () => {
        throw new Error("UI callback failed");
      },
    });
    await expect(callbackFailure(`${endpoint}/api/v1/items`, {
      headers: { authorization: `Bearer ${marker}` },
    })).resolves.toHaveProperty("status", 204);
  });
});

describe("hosted dashboard recovery view", () => {
  test("reveals sign-out only for terminal hosted item-list authentication responses", () => {
    expect(describeHostedSessionRecovery({
      status: 403,
      method: "GET",
      url: `${endpoint}/api/v1/items`,
    }, endpoint)).toEqual({
      title: "Hosted session needs attention",
      state: "access unavailable",
      summary: "The hosted account cannot open this ledger. Sign out to clear the session.",
      disconnectedTitle: "Hosted session is still active.",
      disconnectedMessage: "Use sign out to clear the hosted cookie before trying another account or connection.",
    });
    expect(describeHostedSessionRecovery({
      status: 401,
      method: "GET",
      url: `${endpoint}/api/v1/items?project=oauth-dogfood`,
    }, endpoint)?.state).toBe("session expired");

    expect(describeHostedSessionRecovery({
      status: 403,
      method: "GET",
      url: `${endpoint}/api/v1/principal`,
    }, endpoint)).toBeNull();
    expect(describeHostedSessionRecovery({
      status: 403,
      method: "POST",
      url: `${endpoint}/api/v1/items`,
    }, endpoint)).toBeNull();
    expect(describeHostedSessionRecovery({
      status: 500,
      method: "GET",
      url: `${endpoint}/api/v1/items`,
    }, endpoint)).toBeNull();
    expect(describeHostedSessionRecovery({
      status: 403,
      method: "GET",
      url: "https://other.example/api/v1/items",
    }, endpoint)).toBeNull();
  });
});

describe("hosted dashboard auth URLs and logout", () => {
  test("builds exact GitHub start and logout URLs", () => {
    expect(createGithubSignInUrl(endpoint, "https://www.stensibly.com/board?project=scrapbook"))
      .toBe("https://api.stensibly.com/auth/github/start?returnTo=https%3A%2F%2Fwww.stensibly.com%2Fboard%3Fproject%3Dscrapbook");
    expect(createHostedLogoutUrl(endpoint)).toBe("https://api.stensibly.com/auth/logout");
  });

  test("accepts successful logout and preserves a failed session for retry", async () => {
    const observed: Request[] = [];
    const success = (async (input: RequestInfo | URL, init?: RequestInit) => {
      observed.push(new Request(input, init));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    await expect(revokeHostedSession(success, endpoint)).resolves.toBeUndefined();
    const request = observed[0];
    expect(request?.url).toBe(`${endpoint}/auth/logout`);
    expect(request?.method).toBe("POST");
    expect(request?.credentials).toBe("include");

    const failure = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    await expect(revokeHostedSession(failure, endpoint)).rejects.toThrow("Sign out returned HTTP 503");
  });

  test("rejects credential-bearing and non-origin endpoints", () => {
    expect(() => createGithubSignInUrl("https://user@example.com", "https://www.stensibly.com/"))
      .toThrow("HTTP or HTTPS origin");
    expect(() => createGithubSignInUrl(`${endpoint}/api`, "https://www.stensibly.com/"))
      .toThrow("HTTP or HTTPS origin");
    expect(() => createGithubSignInUrl(endpoint, "javascript:alert(1)"))
      .toThrow("Return destination");
  });
});
