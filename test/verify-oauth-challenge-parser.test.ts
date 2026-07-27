import { describe, expect, test } from "bun:test";
import {
  formatOAuthResults,
  verifyOAuthHosted,
  type FetchLike,
} from "../src/verify-oauth-hosted.ts";

const endpoint = "https://worker.example";
const issuer = "https://api.example";
const resourceMetadata = `${issuer}/.well-known/oauth-protected-resource/mcp`;

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function verifierFetch(challenges: {
  required: string;
  invalid: string;
}, disabled = false): FetchLike {
  return async (input, init: RequestInit = {}) => {
    const requestUrl = new URL(String(input));
    if (requestUrl.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "stensibly",
        backend: "convex",
        surfaces: disabled ? ["api-v1", "mcp", "auth"] : ["api-v1", "mcp", "auth", "oauth"],
      });
    }
    if (requestUrl.pathname === "/.well-known/oauth-protected-resource/mcp") {
      if (disabled) return jsonResponse({ error: "Not found", code: "not_found" }, 404);
      return jsonResponse({
        resource: `${issuer}/mcp`,
        authorization_servers: [issuer],
        scopes_supported: ["read", "write"],
        bearer_methods_supported: ["header"],
      });
    }
    if (requestUrl.pathname === "/.well-known/oauth-authorization-server") {
      if (disabled) return jsonResponse({ error: "Not found", code: "not_found" }, 404);
      return jsonResponse({
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        scopes_supported: ["read", "write", "offline_access"],
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (requestUrl.pathname === "/mcp") {
      const invalid = new Headers(init.headers).has("authorization");
      return jsonResponse({ error: "unauthorized" }, 401, {
        "www-authenticate": invalid ? challenges.invalid : challenges.required,
        "x-request-id": invalid ? "challenge-invalid" : "challenge-required",
      });
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };
}

function resultNamed(
  results: Awaited<ReturnType<typeof verifyOAuthHosted>>,
  name: string,
) {
  const result = results.find((entry) => entry.name === name);
  if (!result) throw new Error(`Missing result ${name}`);
  return result;
}

describe("strict OAuth challenge verification", () => {
  test("accepts only the exact enabled challenge parameter sets", async () => {
    const results = await verifyOAuthHosted({
      endpoint,
      issuer,
      expectation: "enabled",
    }, verifierFetch({
      required: `Bearer resource_metadata="${resourceMetadata}", scope="read write"`,
      invalid: `Bearer resource_metadata="${resourceMetadata}", scope="read write", error="invalid_token"`,
    }));

    expect(results.every((result) => result.ok)).toBe(true);
  });

  test("rejects embedded expected substrings and never prints the raw challenge", async () => {
    const privateMarker = "private-challenge-marker";
    const results = await verifyOAuthHosted({
      endpoint,
      issuer,
      expectation: "enabled",
    }, verifierFetch({
      required: `Bearer bogus=resource_metadata="${resourceMetadata}", scope="read write", note="${privateMarker}"`,
      invalid: `Bearer bogus=error="invalid_token", resource_metadata="${resourceMetadata}", scope="read write", note="${privateMarker}"`,
    }));

    expect(resultNamed(results, "required-token MCP challenge")).toEqual({
      name: "required-token MCP challenge",
      ok: false,
      detail: "WWW-Authenticate challenge is malformed; status=401; requestId=challenge-required",
    });
    expect(resultNamed(results, "invalid-token MCP challenge")).toEqual({
      name: "invalid-token MCP challenge",
      ok: false,
      detail: "WWW-Authenticate challenge is malformed; status=401; requestId=challenge-invalid",
    });
    expect(formatOAuthResults(results)).not.toContain(privateMarker);
  });

  test("rejects duplicate and unexpected parameters", async () => {
    const duplicate = await verifyOAuthHosted({
      endpoint,
      issuer,
      expectation: "enabled",
    }, verifierFetch({
      required: `Bearer resource_metadata="${resourceMetadata}", resource_metadata="${resourceMetadata}", scope="read write"`,
      invalid: `Bearer resource_metadata="${resourceMetadata}", scope="read write", error="invalid_token", error="invalid_token"`,
    }));
    expect(resultNamed(duplicate, "required-token MCP challenge").detail).toBe(
      "WWW-Authenticate challenge has duplicate parameters; status=401; requestId=challenge-required",
    );
    expect(resultNamed(duplicate, "invalid-token MCP challenge").detail).toBe(
      "WWW-Authenticate challenge has duplicate parameters; status=401; requestId=challenge-invalid",
    );

    const unexpected = await verifyOAuthHosted({
      endpoint,
      issuer,
      expectation: "enabled",
    }, verifierFetch({
      required: `Bearer resource_metadata="${resourceMetadata}", scope="read write", extra="value"`,
      invalid: `Bearer resource_metadata="${resourceMetadata}", scope="read write", error="invalid_token", extra="value"`,
    }));
    expect(resultNamed(unexpected, "required-token MCP challenge").detail).toBe(
      "OAuth challenge parameters do not match the expected state; status=401; requestId=challenge-required",
    );
    expect(resultNamed(unexpected, "invalid-token MCP challenge").detail).toBe(
      "OAuth challenge parameters do not match the expected state; status=401; requestId=challenge-invalid",
    );
  });

  test("requires exact bare Bearer challenges in disabled mode", async () => {
    const bare = await verifyOAuthHosted({
      endpoint,
      issuer,
      expectation: "disabled",
    }, verifierFetch({ required: "Bearer", invalid: "Bearer" }, true));
    expect(bare.every((result) => result.ok)).toBe(true);

    const parameterised = await verifyOAuthHosted({
      endpoint,
      issuer,
      expectation: "disabled",
    }, verifierFetch({
      required: `Bearer scope="read write"`,
      invalid: `Bearer error="invalid_token"`,
    }, true));
    expect(resultNamed(parameterised, "required-token MCP challenge").detail).toBe(
      "OAuth challenge parameters do not match the expected state; status=401; requestId=challenge-required",
    );
    expect(resultNamed(parameterised, "invalid-token MCP challenge").detail).toBe(
      "OAuth challenge parameters do not match the expected state; status=401; requestId=challenge-invalid",
    );
  });
});
