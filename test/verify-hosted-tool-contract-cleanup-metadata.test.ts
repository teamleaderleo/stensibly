import { describe, expect, test } from "bun:test";
import { verifyHostedToolContract } from "../src/verify-hosted-tool-contract.ts";
import type { FetchLike } from "../src/verify-hosted.ts";

const token = `stn.tok_${"a".repeat(32)}.${"B".repeat(43)}`;
const options = {
  endpoint: "https://api.stensibly.com",
  token,
  origin: "https://www.stensibly.com",
};

function responseWithHostileCleanup(kind: "body" | "locked"): Response {
  const response = {
    status: 401,
    ok: false,
    headers: new Headers({ "x-request-id": "cleanup-metadata-control" }),
  } as Record<string, unknown>;

  if (kind === "body") {
    Object.defineProperty(response, "body", {
      enumerable: true,
      get() {
        throw new Error("provider body getter must not escape cleanup");
      },
    });
  } else {
    const body = {} as Record<string, unknown>;
    Object.defineProperty(body, "locked", {
      enumerable: true,
      get() {
        throw new Error("provider locked getter must not escape cleanup");
      },
    });
    response.body = body;
  }

  return response as unknown as Response;
}

describe("hosted MCP tool-contract cleanup metadata", () => {
  for (const kind of ["body", "locked"] as const) {
    test(`keeps ${kind} metadata failures inside best-effort cleanup`, async () => {
      const unhandled: unknown[] = [];
      const listener = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", listener);
      try {
        const fetchImpl: FetchLike = async () => responseWithHostileCleanup(kind);
        const result = await verifyHostedToolContract(options, fetchImpl);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(result).toEqual({
          name: "remote MCP tool contract",
          ok: false,
          detail: "Expected HTTP 200; received HTTP 401; requestId=cleanup-metadata-control",
        });
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", listener);
      }
    });
  }
});
