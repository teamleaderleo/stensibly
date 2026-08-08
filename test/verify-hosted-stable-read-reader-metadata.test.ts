import { describe, expect, test } from "bun:test";
import {
  PROCESSING_STAGE_HEADER,
  WORKER_VERSION_ID_HEADER,
} from "../src/worker-observability.ts";
import { verifyHostedStableRead } from "../src/verify-hosted-stable-read.ts";
import type { FetchLike } from "../src/verify-hosted.ts";

const token = `stn.tok_${"a".repeat(32)}.${"B".repeat(43)}`;
const options = {
  endpoint: "https://api.stensibly.com",
  token,
  origin: "https://www.stensibly.com",
};

function hostileSuccessfulResponse(
  variant: "body" | "getReader",
): Response {
  const response = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(response, "status", {
    value: 200,
    enumerable: true,
  });
  Object.defineProperty(response, "ok", {
    value: true,
    enumerable: true,
  });
  Object.defineProperty(response, "headers", {
    value: new Headers({
      "x-request-id": `stable-read-reader-${variant}`,
      [PROCESSING_STAGE_HEADER]: "response_produced",
      [WORKER_VERSION_ID_HEADER]: "worker-version-reader-control",
    }),
    enumerable: true,
  });

  if (variant === "body") {
    Object.defineProperty(response, "body", {
      enumerable: true,
      get() {
        throw new Error("provider body getter prose must not escape");
      },
    });
  } else {
    const body = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(body, "getReader", {
      enumerable: true,
      get() {
        throw new Error("provider getReader getter prose must not escape");
      },
    });
    Object.defineProperty(response, "body", {
      value: body,
      enumerable: true,
    });
  }

  return response as unknown as Response;
}

describe("hosted stable-read response reader metadata", () => {
  for (const variant of ["body", "getReader"] as const) {
    test(`contains hostile ${variant} metadata before reader acquisition`, async () => {
      const fetchImpl: FetchLike = async () => hostileSuccessfulResponse(variant);

      const result = await verifyHostedStableRead(options, fetchImpl);

      expect(result).toEqual({
        name: "remote MCP stable read",
        ok: false,
        detail: "MCP survey_workspace response stream was unavailable",
      });
      expect(result.detail).not.toContain("provider");
    });
  }
});
