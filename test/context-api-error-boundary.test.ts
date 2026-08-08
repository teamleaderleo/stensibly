import { describe, expect, test } from "bun:test";
import { createContextPacketApi } from "../src/context-api.ts";
import type { WorkLedger } from "../src/ledger.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";

const authenticator: ApiTokenAuthenticator = {
  async authenticate() {
    return {
      tokenId: "tok_context_error_boundary",
      name: "context-error-boundary",
      scopes: ["read"],
      projects: null,
    };
  },
};

function appWithFailure(thrown: unknown) {
  const ledger = {
    async getItem() {
      throw thrown;
    },
  } as unknown as WorkLedger;
  return createContextPacketApi(authenticator, ledger, { required: true });
}

async function request(thrown: unknown): Promise<Response> {
  return await appWithFailure(thrown).request(
    "http://localhost/items/item-context-error/context",
    { headers: { Authorization: "Bearer test-token" } },
  );
}

describe("context API error boundary", () => {
  test("preserves not-found classification without echoing the local message", async () => {
    const response = await request(new Error("Item item-context-error does not exist"));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Resource not found",
      code: "not_found",
    });
  });

  test("does not echo ordinary backend error prose", async () => {
    const response = await request(new Error("private backend detail should stay private"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid operation",
      code: "invalid_operation",
    });
  });

  test("contains hostile thrown-object metadata without prototype or coercion reads", async () => {
    let prototypeReads = 0;
    let stringReads = 0;
    const thrown = new Proxy(Object.create(null), {
      getOwnPropertyDescriptor(_target, key) {
        if (key === "message") {
          throw new Error("foreign message descriptor prose must not escape");
        }
        return undefined;
      },
      getPrototypeOf() {
        prototypeReads += 1;
        throw new Error("foreign prototype prose must not escape");
      },
      get(_target, key) {
        if (key === "toString" || key === Symbol.toPrimitive) {
          stringReads += 1;
          throw new Error("foreign coercion prose must not escape");
        }
        return undefined;
      },
    });

    const response = await request(thrown);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid operation",
      code: "invalid_operation",
    });
    expect(prototypeReads).toBe(0);
    expect(stringReads).toBe(0);
  });

  test("does not classify oversized not-found prose from an unbounded message", async () => {
    const response = await request(new Error(`${"x".repeat(2_100)} not found`));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid operation",
      code: "invalid_operation",
    });
  });
});
