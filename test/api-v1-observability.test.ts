import { describe, expect, test } from "bun:test";
import { createApiV1 } from "../src/api-v1.ts";
import type { WorkLedger } from "../src/ledger.ts";
import type { TokenPrincipal } from "../src/token-contracts.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";
import { FAILURE_CATEGORY_HEADER } from "../src/worker-observability.ts";

class ReaderAuthenticator implements ApiTokenAuthenticator {
  async authenticate(): Promise<TokenPrincipal> {
    return {
      tokenId: "tok_reader",
      name: "Reader",
      scopes: ["read"],
      projects: null,
    };
  }
}

function failingLedger(error: Error): WorkLedger {
  return {
    listWork: async () => {
      throw error;
    },
  } as unknown as WorkLedger;
}

async function requestWith(error: Error): Promise<Response> {
  const app = createApiV1(
    new ReaderAuthenticator(),
    failingLedger(error),
    { required: true },
  );
  return await app.request("/items", {
    headers: { authorization: "Bearer test-token" },
  });
}

describe("REST failure categories", () => {
  test("marks transport-style exceptions as Convex failures", async () => {
    const response = await requestWith(new TypeError("fetch failed"));
    expect(response.status).toBe(400);
    expect(response.headers.get(FAILURE_CATEGORY_HEADER)).toBe("convex_failure");
    expect(await response.json()).toMatchObject({ code: "invalid_operation" });
  });

  test("marks ordinary invalid operations as request failures", async () => {
    const response = await requestWith(new Error("Title must be between 1 and 240 characters"));
    expect(response.status).toBe(400);
    expect(response.headers.get(FAILURE_CATEGORY_HEADER)).toBe("request_failure");
  });

  test("marks service-secret failures as Convex failures", async () => {
    const response = await requestWith(new Error("STENSIBLY_SERVICE_SECRET is not configured"));
    expect(response.status).toBe(401);
    expect(response.headers.get(FAILURE_CATEGORY_HEADER)).toBe("convex_failure");
    expect(await response.json()).toEqual({
      error: "Unauthorized",
      code: "unauthorized",
    });
  });
});
