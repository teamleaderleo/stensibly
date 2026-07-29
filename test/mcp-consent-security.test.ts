import { describe, expect, test } from "bun:test";
import { isAllowedMcpConsentRequest } from "../src/mcp-consent-security.ts";

const issuer = "https://api.stensibly.com";

describe("MCP consent request security", () => {
  test("accepts the canonical Origin header", () => {
    expect(isAllowedMcpConsentRequest({ origin: issuer }, issuer)).toBe(true);
  });

  test("accepts an omitted or null Origin only for same-origin navigation", () => {
    expect(isAllowedMcpConsentRequest({
      origin: undefined,
      secFetchSite: "same-origin",
      secFetchMode: "navigate",
    }, issuer)).toBe(true);

    expect(isAllowedMcpConsentRequest({
      origin: "null",
      secFetchSite: "same-origin",
      secFetchMode: "navigate",
    }, issuer)).toBe(true);
  });

  test("rejects incomplete Fetch Metadata fallback", () => {
    expect(isAllowedMcpConsentRequest({
      origin: undefined,
      secFetchSite: "same-origin",
    }, issuer)).toBe(false);

    expect(isAllowedMcpConsentRequest({
      origin: undefined,
      secFetchMode: "navigate",
    }, issuer)).toBe(false);
  });

  test("rejects cross-site and conflicting-origin submissions", () => {
    expect(isAllowedMcpConsentRequest({
      origin: undefined,
      secFetchSite: "cross-site",
      secFetchMode: "navigate",
    }, issuer)).toBe(false);

    expect(isAllowedMcpConsentRequest({
      origin: "https://example.com",
      secFetchSite: "same-origin",
      secFetchMode: "navigate",
    }, issuer)).toBe(false);
  });
});
