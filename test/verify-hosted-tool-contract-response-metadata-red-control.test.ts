import { describe, expect, test } from "bun:test";
import { verifyHostedToolContract } from "../src/verify-hosted-tool-contract.ts";
import type { FetchLike } from "../src/verify-hosted.ts";

const token = `stn.tok_${"a".repeat(32)}.${"B".repeat(43)}`;
const privateProse = "provider-private response metadata must stay opaque";
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

describe("hosted MCP tool-contract outer response metadata", () => {
  for (const kind of ["status", "headers"] as const) {
    test(`normalizes hostile ${kind} metadata before verifier output`, async () => {
      const fetchImpl: FetchLike = async () => hostileResponse(kind);
      const result = await verifyHostedToolContract(options, fetchImpl);

      expect(result).toEqual({
        name: "remote MCP tool contract",
        ok: false,
        detail: "MCP tools/list response metadata was unavailable",
      });
      expect(result.detail).not.toContain(privateProse);
    });
  }
});
