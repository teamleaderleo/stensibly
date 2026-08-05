import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "repository-write-lookup-embedded-secret";
const getRef = makeFunctionReference<"query">("githubRepositoryWrites:get");

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("hosted repository-write embedded lookup credential admission", () => {
  test.each(hostileKeys())(
    "rejects embedded credential-shaped key %s before project lookup",
    async (idempotencyKey) => {
      const t = convexTest(schema, modules);
      await expect(t.query(getRef, {
        serviceSecret,
        workspace: "missing-workspace",
        project: "missing-project",
        idempotencyKey,
      })).rejects.toThrow("GitHub repository write receipt is invalid");
    },
  );

  test("preserves benign short embedded token-like aliases", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(getRef, {
      serviceSecret,
      workspace: "missing-workspace",
      project: "missing-project",
      idempotencyKey: "keyxgithub_pat_review-xoxb-review",
    })).resolves.toBeNull();
  });

  test("does not echo embedded hostile bytes", async () => {
    const t = convexTest(schema, modules);
    const hostile = `keyxxoxb-${"z".repeat(16)}`;
    try {
      await t.query(getRef, {
        serviceSecret,
        workspace: "missing-workspace",
        project: "missing-project",
        idempotencyKey: hostile,
      });
      throw new Error("expected embedded lookup rejection");
    } catch (error) {
      expect(String(error)).toContain("GitHub repository write receipt is invalid");
      expect(String(error)).not.toContain(hostile);
    }
  });
});

function hostileKeys(): string[] {
  const jwt = `eyJ${"d".repeat(8)}.eyJ${"e".repeat(8)}.${"f".repeat(8)}`;
  return [
    `keyxgithub_pat_${"a".repeat(20)}`,
    `keyxghp_${"b".repeat(20)}`,
    `keyxxoxb-${"c".repeat(16)}`,
    "keyxsecret://github/app-private-key",
    `keyx${jwt}`,
  ];
}
