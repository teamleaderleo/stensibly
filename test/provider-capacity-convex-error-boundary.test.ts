import { expect, test } from "bun:test";
import type { FunctionReference } from "convex/server";
import type { ConvexCaller } from "../src/convex-ledger.ts";
import {
  ConvexProviderCapacityService,
} from "../src/provider-capacity-convex.ts";
import {
  ProviderCapacityConflictError,
} from "../src/provider-capacity.ts";

class ThrowingClient implements ConvexCaller {
  constructor(readonly thrown: unknown) {}

  async mutation(
    _reference: FunctionReference<"mutation">,
    _args: Record<string, unknown>,
  ): Promise<unknown> {
    throw this.thrown;
  }

  async query(
    _reference: FunctionReference<"query">,
    _args: Record<string, unknown>,
  ): Promise<unknown> {
    throw this.thrown;
  }
}

function service(thrown: unknown): ConvexProviderCapacityService {
  return new ConvexProviderCapacityService({
    client: new ThrowingClient(thrown),
    serviceSecret: "service-secret",
    workspace: "default",
  });
}

function ingestInput() {
  return {
    deliveryId: "delivery-capacity-boundary",
    payloadDigest: "a".repeat(64),
    sourceCommentId: "5104466293",
    repository: "teamleaderleo/stensibly",
    pullRequestNumber: 421,
    subjectLogin: "coderabbitai[bot]",
    state: "available" as const,
    remaining: 7,
    limit: 10,
    refillAt: null,
    observedAt: "2026-08-08T00:00:00.000Z",
    receivedAt: "2026-08-08T00:00:01.000Z",
  };
}

test("preserves explicit delivery-conflict semantics without rethrowing backend error", async () => {
  const backend = new Error("PROVIDER_CAPACITY_DELIVERY_CONFLICT private backend detail");
  let captured: unknown;
  try {
    await service(backend).ingestCodeRabbit(ingestInput());
  } catch (error) {
    captured = error;
  }

  expect(captured).toBeInstanceOf(ProviderCapacityConflictError);
  expect(captured).not.toBe(backend);
  expect(String(captured)).not.toContain("private backend detail");
});

for (const operation of ["ingest", "snapshot"] as const) {
  test(`${operation} keeps hostile backend error metadata contained`, async () => {
    let descriptorCalls = 0;
    const backend = new Proxy(Object.create(null), {
      getOwnPropertyDescriptor(_target, key) {
        if (key === "message") {
          descriptorCalls += 1;
          throw new Error("private backend descriptor prose must not escape");
        }
        return undefined;
      },
      getPrototypeOf() {
        throw new Error("private backend prototype prose must not escape");
      },
    });
    const instance = service(backend);

    let captured: unknown;
    try {
      if (operation === "ingest") {
        await instance.ingestCodeRabbit(ingestInput());
      } else {
        await instance.snapshot(
          "teamleaderleo/stensibly",
          "coderabbitai[bot]",
          Date.parse("2026-08-08T00:00:30.000Z"),
        );
      }
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(Error);
    expect(captured).toMatchObject({ message: "Provider capacity backend failed" });
    expect(descriptorCalls).toBe(1);
    expect(String(captured)).not.toContain("private backend");
  });
}

test("does not rethrow ordinary backend Error prose on snapshot", async () => {
  const backend = new Error("provider secret should remain private");
  let captured: unknown;
  try {
    await service(backend).snapshot(
      "teamleaderleo/stensibly",
      "coderabbitai[bot]",
      Date.parse("2026-08-08T00:00:30.000Z"),
    );
  } catch (error) {
    captured = error;
  }

  expect(captured).toBeInstanceOf(Error);
  expect(captured).not.toBe(backend);
  expect(captured).toMatchObject({ message: "Provider capacity backend failed" });
  expect(String(captured)).not.toContain("provider secret");
});
