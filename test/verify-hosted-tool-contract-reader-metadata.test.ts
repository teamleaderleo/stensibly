import { expect, test } from "bun:test";
import { verifyHostedToolContract } from "../src/verify-hosted-tool-contract.ts";
import type { FetchLike } from "../src/verify-hosted.ts";

const token = `stn.tok_${"a".repeat(32)}.${"B".repeat(43)}`;
const options = {
  endpoint: "https://api.stensibly.com",
  token,
  origin: "https://www.stensibly.com",
};

function hostileSuccessResponse(variant: "body" | "getReader"): Response {
  const response = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(response, "status", { value: 200, enumerable: true });
  Object.defineProperty(response, "headers", {
    value: new Headers(),
    enumerable: true,
  });

  if (variant === "body") {
    Object.defineProperty(response, "body", {
      enumerable: true,
      get() {
        throw new Error("provider-controlled body metadata must not escape");
      },
    });
  } else {
    const body = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(body, "getReader", {
      enumerable: true,
      get() {
        throw new Error("provider-controlled getReader metadata must not escape");
      },
    });
    Object.defineProperty(response, "body", {
      value: body,
      enumerable: true,
    });
  }

  return response as unknown as Response;
}

for (const variant of ["body", "getReader"] as const) {
  test(`contains hostile ${variant} metadata before hosted tool-contract stream intake`, async () => {
    const fetchImpl: FetchLike = async () => hostileSuccessResponse(variant);

    const result = await verifyHostedToolContract(options, fetchImpl);

    expect(result).toEqual({
      name: "remote MCP tool contract",
      ok: false,
      detail: "MCP tools/list response body could not be inspected",
    });
    expect(result.detail).not.toContain("provider-controlled");
  });
}
