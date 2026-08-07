import { expect, test } from "bun:test";
import { verifyHostedToolContract } from "../src/verify-hosted-tool-contract.ts";
import type { FetchLike } from "../src/verify-hosted.ts";

const token = `stn.tok_${"a".repeat(32)}.${"B".repeat(43)}`;
const options = {
  endpoint: "https://api.stensibly.com",
  token,
  origin: "https://www.stensibly.com",
};

function responseWithHostileCleanup(
  variant: "body" | "locked",
  requestId: string,
): Response {
  const response = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(response, "status", {
    value: 401,
    enumerable: true,
  });
  Object.defineProperty(response, "headers", {
    value: new Headers({ "x-request-id": requestId }),
    enumerable: true,
  });

  if (variant === "body") {
    Object.defineProperty(response, "body", {
      enumerable: true,
      get() {
        throw new Error("cleanup body getter must not escape");
      },
    });
  } else {
    const body = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(body, "locked", {
      enumerable: true,
      get() {
        throw new Error("cleanup locked getter must not escape");
      },
    });
    Object.defineProperty(body, "cancel", {
      value: () => Promise.resolve(),
      enumerable: true,
    });
    Object.defineProperty(response, "body", {
      value: body,
      enumerable: true,
    });
  }

  return response as unknown as Response;
}

for (const variant of ["body", "locked"] as const) {
  test(`contains hostile ${variant} cleanup metadata after fixed HTTP rejection`, async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const requestId = `tool-contract-cleanup-${variant}`;
      const fetchImpl: FetchLike = async () =>
        responseWithHostileCleanup(variant, requestId);

      const result = await verifyHostedToolContract(options, fetchImpl);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(result).toEqual({
        name: "remote MCP tool contract",
        ok: false,
        detail: `Expected HTTP 200; received HTTP 401; requestId=${requestId}`,
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
}
