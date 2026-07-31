import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  classifyHostedSessionDisconnect,
  createGithubSignInUrl,
  createHostedLogoutUrl,
  hostedSessionSentinel,
  installHostedSessionFetchBridge,
  isDefaultHostedEndpoint,
  isHostedSessionSentinel,
  prepareHostedSessionRequest,
  revokeHostedSession,
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

  test("yields hosted denial recovery after a bearer token takes over", () => {
    const marker = hostedSessionSentinel();
    const manualToken = `stn.tok_${"a".repeat(32)}.${"B".repeat(43)}`;
    expect(classifyHostedSessionDisconnect(marker, false)).toBe("hosted");
    expect(classifyHostedSessionDisconnect("", true)).toBe("hosted");
    expect(classifyHostedSessionDisconnect(manualToken, true)).toBe("bearer");
    expect(classifyHostedSessionDisconnect("", false)).toBe("ordinary");
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
    expect(hosted.hostedSession).toBe(true);

    const manualToken = `stn.tok_${"a".repeat(32)}.${"B".repeat(43)}`;
    const bearer = prepareHostedSessionRequest(`${endpoint}/api/v1/items`, {
      headers: { authorization: `Bearer ${manualToken}` },
    }, endpoint);
    expect(bearer.request.headers.get("authorization")).toBe(`Bearer ${manualToken}`);
    expect(bearer.credentials).toBe("omit");
    expect(bearer.hostedSession).toBe(false);

    const mcp = prepareHostedSessionRequest(`${endpoint}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${marker}` },
    }, endpoint);
    expect(mcp.request.headers.get("authorization")).toBeNull();
    expect(mcp.credentials).toBe("omit");
    expect(mcp.hostedSession).toBe(false);

    const foreign = prepareHostedSessionRequest("https://other.example/api/v1/items", {
      headers: { authorization: `Bearer ${marker}` },
    }, endpoint);
    expect(foreign.request.headers.get("authorization")).toBeNull();
    expect(foreign.credentials).toBe("omit");
    expect(foreign.hostedSession).toBe(false);
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

  test("reports hosted 401 and 403 while preserving the legacy 403 callback", async () => {
    const rejections: number[] = [];
    let denials = 0;
    let status = 401;
    const rejectedFetch = (async () => new Response(null, { status })) as unknown as typeof fetch;
    const bridgedFetch = installHostedSessionFetchBridge({
      fetchImpl: rejectedFetch,
      sessionOrigin: endpoint,
      onHostedSessionRejected: (rejectedStatus) => {
        rejections.push(rejectedStatus);
      },
      onHostedAccessDenied: () => {
        denials += 1;
      },
    });
    const marker = hostedSessionSentinel();
    const manualToken = `stn.tok_${"a".repeat(32)}.${"B".repeat(43)}`;

    await bridgedFetch(`${endpoint}/api/v1/items`, {
      headers: { authorization: `Bearer ${marker}` },
    });
    expect(rejections).toEqual([401]);
    expect(denials).toBe(0);

    status = 403;
    await bridgedFetch(`${endpoint}/api/v1/items`, {
      headers: { authorization: `Bearer ${marker}` },
    });
    expect(rejections).toEqual([401, 403]);
    expect(denials).toBe(1);

    await bridgedFetch(`${endpoint}/api/v1/items`, {
      headers: { authorization: `Bearer ${manualToken}` },
    });
    await bridgedFetch(`${endpoint}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${marker}` },
    });
    await bridgedFetch("https://other.example/api/v1/items", {
      headers: { authorization: `Bearer ${marker}` },
    });
    expect(rejections).toEqual([401, 403]);
    expect(denials).toBe(1);
  });

  test("does not replace a hosted rejection when notification fails", async () => {
    const rejectedFetch = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
    const bridgedFetch = installHostedSessionFetchBridge({
      fetchImpl: rejectedFetch,
      sessionOrigin: endpoint,
      onHostedSessionRejected: () => {
        throw new Error("private UI failure");
      },
    });
    const response = await bridgedFetch(`${endpoint}/api/v1/items`, {
      headers: { authorization: `Bearer ${hostedSessionSentinel()}` },
    });
    expect(response.status).toBe(401);
  });

  test("rejects invalid hosted notification callbacks", () => {
    const fetchImpl = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    expect(() => installHostedSessionFetchBridge({
      fetchImpl,
      sessionOrigin: endpoint,
      onHostedAccessDenied: "not-a-function",
    } as unknown as Parameters<typeof installHostedSessionFetchBridge>[0]))
      .toThrow("Hosted access-denied callback must be a function");
    expect(() => installHostedSessionFetchBridge({
      fetchImpl,
      sessionOrigin: endpoint,
      onHostedSessionRejected: "not-a-function",
    } as unknown as Parameters<typeof installHostedSessionFetchBridge>[0]))
      .toThrow("Hosted session-rejected callback must be a function");
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

  test("wires expired-session reset and forbidden-session sign-out", async () => {
    const [html, bridge] = await Promise.all([
      readFile(new URL("../site/index.html", import.meta.url), "utf8"),
      readFile(new URL("../site/hosted-session-bridge.js", import.meta.url), "utf8"),
    ]);
    expect(html).toContain('id="hosted-sign-out"');
    expect(bridge).toContain("onHostedSessionRejected: preserveHostedSessionRecovery");
    expect(bridge).toContain("status === 401 ? 'Reset sign-in' : 'Sign out'");
    expect(bridge).toContain("This browser session expired. Reset sign-in to continue.");
    expect(bridge).toContain("classifyHostedSessionDisconnect(stored, hostedAuthorizationDenied)");
    expect(bridge).toContain("if (mode === 'bearer')");
    expect(bridge).toContain("const restartGithubSignIn = hostedSessionRejectedStatus === 401");
    expect(bridge).toContain("if (restartGithubSignIn)");
    expect(bridge).toContain("beginGithubSignIn();");
    expect(bridge).toContain("hostedSignOutButton.textContent = 'Sign out'");
    expect(bridge).toContain("clearHostedMarker()");
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
