import { describe, expect, test } from "bun:test";
import {
  evaluateSessionRequestSecurity,
  requiresSessionOriginCheck,
  resolveCredentialedCorsOrigin,
} from "../src/session-request-security.ts";

const allowedOrigins = [
  "https://www.stensibly.com",
  "https://stensibly.app/",
  "http://localhost:3000",
];

describe("browser-session request security", () => {
  test("checks only state-changing browser-session requests", () => {
    expect(requiresSessionOriginCheck("GET", "session")).toBe(false);
    expect(requiresSessionOriginCheck("head", "session")).toBe(false);
    expect(requiresSessionOriginCheck("OPTIONS", "session")).toBe(false);
    expect(requiresSessionOriginCheck("POST", "session")).toBe(true);
    expect(requiresSessionOriginCheck("DELETE", "session")).toBe(true);
    expect(requiresSessionOriginCheck("POST", "bearer")).toBe(false);
    expect(requiresSessionOriginCheck("POST", "anonymous")).toBe(false);
  });

  test("allows safe session requests and preserves bearer client behavior", () => {
    expect(evaluateSessionRequestSecurity({
      method: "GET",
      authenticationMode: "session",
      allowedOrigins,
    })).toBeNull();

    expect(evaluateSessionRequestSecurity({
      method: "POST",
      authenticationMode: "bearer",
      origin: "https://untrusted.example",
      allowedOrigins,
    })).toBeNull();
  });

  test("allows session writes only from an approved canonical origin", () => {
    expect(evaluateSessionRequestSecurity({
      method: "POST",
      authenticationMode: "session",
      origin: "https://www.stensibly.com",
      allowedOrigins,
    })).toBeNull();

    expect(evaluateSessionRequestSecurity({
      method: "PATCH",
      authenticationMode: "session",
      origin: "https://stensibly.app",
      allowedOrigins,
    })).toBeNull();

    expect(evaluateSessionRequestSecurity({
      method: "DELETE",
      authenticationMode: "session",
      origin: "http://localhost:3000",
      allowedOrigins,
    })).toBeNull();
  });

  test("rejects missing, opaque, malformed, and unapproved origins", () => {
    for (const origin of [
      undefined,
      null,
      "",
      "null",
      "not-a-url",
      "https://stensibly.app/path",
      "https://stensibly.app?query=yes",
      "https://stensibly.app#fragment",
      "https://user:password@stensibly.app",
    ]) {
      expect(evaluateSessionRequestSecurity({
        method: "POST",
        authenticationMode: "session",
        origin,
        allowedOrigins,
      })).toMatchObject({
        status: 403,
        code: "forbidden_origin",
      });
    }

    expect(evaluateSessionRequestSecurity({
      method: "POST",
      authenticationMode: "session",
      origin: "https://www.stensibly.com.evil.example",
      allowedOrigins,
    })).toEqual({
      status: 403,
      code: "forbidden_origin",
      error: "Origin is not allowed for browser-session writes: https://www.stensibly.com.evil.example",
    });

    expect(evaluateSessionRequestSecurity({
      method: "POST",
      authenticationMode: "session",
      origin: "file:///tmp/stensibly",
      allowedOrigins,
    })).toMatchObject({ code: "forbidden_origin" });
  });

  test("resolves exact credentialed CORS origins without wildcard behavior", () => {
    expect(resolveCredentialedCorsOrigin(
      "https://stensibly.app",
      allowedOrigins,
    )).toBe("https://stensibly.app");
    expect(resolveCredentialedCorsOrigin(
      "https://stensibly.app.evil.example",
      allowedOrigins,
    )).toBeNull();
    expect(resolveCredentialedCorsOrigin(
      "https://stensibly.app/path",
      allowedOrigins,
    )).toBeNull();
    expect(resolveCredentialedCorsOrigin("null", allowedOrigins)).toBeNull();
    expect(resolveCredentialedCorsOrigin(undefined, allowedOrigins)).toBeNull();
  });
});
