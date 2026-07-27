import { describe, expect, test } from "bun:test";
import {
  createGithubSignInUrl,
  createHostedLogoutUrl,
  hostedSessionSentinel,
  installHostedSessionFetchBridge,
  isHostedSessionSentinel,
  prepareHostedSessionRequest,
} from "../site/hosted-session.js";

const endpoint = "https://api.stensibly.com";

describe("hosted dashboard session marker", () => {
  test("generates one plausible, non-secret marker without accepting lookalikes", () => {
    const marker = hostedSessionSentinel();
    expect(marker).toMatch(/^stn\.tok_[a-f0-9]{32}\.[A-Za-z0-9_-]{40,}$/);
    expect(isHostedSessionSentinel(marker)).toBe(true);
    expect(isHostedSessionSentinel(`${marker}x`)).toBe(false);
  });
});

describe("hosted dashboard request bridge", () => {
  test("replaces only the exact session marker on REST v1 requests", () => {
    const marker = hostedSessionSentinel();
    const request = prepareHostedSessionRequest(`${endpoint}/api/v1/items`, {
      headers: { authorization: `Bearer ${marker}` },
    });
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.credentials).toBe("include");

    const manualToken = `stn.tok_${"a".repeat(32)}.${"B".repeat(43)}`;
    const bearer = prepareHostedSessionRequest(`${endpoint}/api/v1/items`, {
      headers: { authorization: `Bearer ${manualToken}` },
    });
    expect(bearer.headers.get("authorization")).toBe(`Bearer ${manualToken}`);
    expect(bearer.credentials).toBe("same-origin");

    const mcp = prepareHostedSessionRequest(`${endpoint}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${marker}` },
    });
    expect(mcp.headers.get("authorization")).toBe(`Bearer ${marker}`);
    expect(mcp.credentials).toBe("same-origin");
  });

  test("installs a bridge that forwards a credentialed Request", async () => {
    const observed: Request[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      observed.push(input instanceof Request ? input : new Request(input));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const bridgedFetch = installHostedSessionFetchBridge({ fetchImpl });
    const marker = hostedSessionSentinel();
    const response = await bridgedFetch(`${endpoint}/api/v1/principal`, {
      headers: { authorization: `Bearer ${marker}` },
    });
    expect(response.status).toBe(204);
    const request = observed[0];
    expect(request).toBeDefined();
    if (!request) throw new Error("The bridge did not forward a request.");
    expect(request.credentials).toBe("include");
    expect(request.headers.get("authorization")).toBeNull();
  });
});

describe("hosted dashboard auth URLs", () => {
  test("builds exact GitHub start and logout URLs", () => {
    expect(createGithubSignInUrl(endpoint, "https://www.stensibly.com/board?project=scrapbook"))
      .toBe("https://api.stensibly.com/auth/github/start?returnTo=https%3A%2F%2Fwww.stensibly.com%2Fboard%3Fproject%3Dscrapbook");
    expect(createHostedLogoutUrl(endpoint)).toBe("https://api.stensibly.com/auth/logout");
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
