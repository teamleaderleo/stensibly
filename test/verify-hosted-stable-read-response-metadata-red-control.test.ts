import { describe, expect, test } from "bun:test";
import { verifyHostedStableRead } from "../src/verify-hosted-stable-read.ts";
import type { FetchLike } from "../src/verify-hosted.ts";

const token = `stn.tok_${"a".repeat(32)}.${"B".repeat(43)}`;
const privateProse = "provider-private survey response metadata must stay opaque";
const options = {
  endpoint: "https://api.stensibly.com",
  token,
  origin: "https://www.stensibly.com",
};

function hostileResponse(kind: "status" | "headers"): Response {
  const response = Object.create(null) as Record<string, unknown>;
  if (kind === "status") {
    Object.defineProperty(response, "status", {
      enumerable: true,
      get() {
        throw new Error(privateProse);
      },
    });
    response.headers = new Headers();
  } else {
    response.status = 200;
    Object.defineProperty(response, "headers", {
      enumerable: true,
      get() {
        throw new Error(privateProse);
      },
    });
  }
  response.body = null;
  return response as unknown as Response;
}

describe("hosted MCP stable-read outer response metadata", () => {
  for (const kind of ["status", "headers"] as const) {
    test(`normalizes hostile ${kind} metadata before verifier output`, async () => {
      const fetchImpl: FetchLike = async () => hostileResponse(kind);
      const result = await verifyHostedStableRead(options, fetchImpl);

      expect(result).toEqual({
        name: "remote MCP stable read",
        ok: false,
        detail: "MCP survey_workspace response metadata was unavailable",
      });
      expect(result.detail).not.toContain(privateProse);
    });
  }
});
