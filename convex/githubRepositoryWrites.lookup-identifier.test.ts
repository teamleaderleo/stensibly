import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "repository-write-lookup-identifier-secret";
const getRef = makeFunctionReference<"query">("githubRepositoryWrites:get");

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("hosted repository-write lookup identifier admission", () => {
  test.each([
    "bad?key",
    `ghp_${"a".repeat(40)}`,
    " key-with-leading-space",
  ])("rejects hostile idempotency key %s before project lookup", async (idempotencyKey) => {
    const t = convexTest(schema, modules);

    await expect(t.query(getRef, {
      serviceSecret,
      workspace: "missing-workspace",
      project: "missing-project",
      idempotencyKey,
    })).rejects.toThrow("GitHub repository write receipt is invalid");
  });

  test("admits a canonical key before a missing project resolves to null", async () => {
    const t = convexTest(schema, modules);

    await expect(t.query(getRef, {
      serviceSecret,
      workspace: "missing-workspace",
      project: "missing-project",
      idempotencyKey: "repository-write_lookup:canonical-1",
    })).resolves.toBeNull();
  });

  test("does not echo a hostile idempotency key", async () => {
    const t = convexTest(schema, modules);
    const hostile = `ghp_${"z".repeat(40)}`;

    try {
      await t.query(getRef, {
        serviceSecret,
        workspace: "missing-workspace",
        project: "missing-project",
        idempotencyKey: hostile,
      });
      throw new Error("expected lookup identifier rejection");
    } catch (error) {
      expect(String(error)).toContain("GitHub repository write receipt is invalid");
      expect(String(error)).not.toContain(hostile);
    }
  });
});
