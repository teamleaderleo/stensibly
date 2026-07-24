import { describe, expect, test } from "bun:test";
// @ts-ignore The static dashboard helper is intentionally plain browser JavaScript.
import {
  describeHttpFailure,
  isPlausibleToken,
  normalizeEndpoint,
  readItems,
} from "../site/connection.js";

const validToken = `stn.tok_${"a".repeat(32)}.${"B".repeat(43)}`;

describe("dashboard token validation", () => {
  test("accepts the generated token form", () => {
    expect(isPlausibleToken(validToken)).toBe(true);
    expect(isPlausibleToken(`  ${validToken}  `)).toBe(true);
  });

  test("rejects partial and malformed tokens", () => {
    expect(isPlausibleToken("stn.tok_…")).toBe(false);
    expect(isPlausibleToken(`stn.tok_${"g".repeat(32)}.${"B".repeat(43)}`)).toBe(false);
    expect(isPlausibleToken(`stn.tok_${"a".repeat(32)}.short`)).toBe(false);
  });
});

describe("dashboard endpoint validation", () => {
  test("normalizes an HTTP or HTTPS origin", () => {
    expect(normalizeEndpoint("https://api.stensibly.com/")).toBe("https://api.stensibly.com");
    expect(normalizeEndpoint("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
  });

  test("rejects paths, queries, fragments, and other protocols", () => {
    expect(() => normalizeEndpoint("https://api.stensibly.com/api")).toThrow("without a path");
    expect(() => normalizeEndpoint("https://api.stensibly.com?x=1")).toThrow("without a path");
    expect(() => normalizeEndpoint("file:///tmp/api")).toThrow("HTTP or HTTPS");
    expect(() => normalizeEndpoint("not a url")).toThrow("valid API URL");
  });
});

describe("dashboard HTTP failure messages", () => {
  test("distinguishes authentication and authorization failures", () => {
    expect(describeHttpFailure(401, { error: "A valid Bearer token is required" })).toEqual({
      kind: "invalid_token",
      message: "The read token is invalid or revoked. Enter a current token and try again.",
    });
    expect(describeHttpFailure(403, { error: "Origin is not allowed: https://example.com" }).kind)
      .toBe("forbidden_origin");
    expect(describeHttpFailure(403, { error: "Token requires read scope" })).toEqual({
      kind: "forbidden",
      message: "Token requires read scope",
    });
  });

  test("distinguishes incompatible, invalid, conflict, and server responses", () => {
    expect(describeHttpFailure(404, { code: "not_found" }).kind).toBe("incompatible_api");
    expect(describeHttpFailure(400, { error: "Unknown status" })).toEqual({
      kind: "invalid_request",
      message: "The API rejected the request: Unknown status",
    });
    expect(describeHttpFailure(409, { error: "Held by another actor" })).toEqual({
      kind: "conflict",
      message: "The API reported a conflict: Held by another actor",
    });
    expect(describeHttpFailure(503, null)).toEqual({
      kind: "api_failure",
      message: "The API is reachable but failed: HTTP 503",
    });
  });
});

describe("dashboard items response", () => {
  test("returns the items array", () => {
    const items = [{ id: "item_1" }];
    expect(readItems({ items })).toBe(items);
  });

  test("rejects an incompatible successful response", () => {
    expect(() => readItems({ data: [] })).toThrow("incompatible items response");
    expect(() => readItems(null)).toThrow("incompatible items response");
  });
});
