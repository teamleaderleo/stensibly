import { describe, expect, test } from "bun:test";
import {
  STENSIBLY_PRODUCTION_CONVEX_DEPLOYMENT,
  assertConvexProductionDeployKey,
} from "../scripts/convex-production-deploy-key.ts";

describe("Convex production deployment key admission", () => {
  test("accepts only a modern deployment-scoped production key", () => {
    expect(() => assertConvexProductionDeployKey(
      "prod:resilient-donkey-323|bounded-secret-material",
    )).not.toThrow();
    expect(STENSIBLY_PRODUCTION_CONVEX_DEPLOYMENT).toBe("resilient-donkey-323");

    for (const key of [
      "dev:resilient-donkey-323|bounded-secret-material",
      "preview:resilient-donkey-323|bounded-secret-material",
      "preview:team:project|bounded-secret-material",
      "project:project-id|bounded-secret-material",
      "prod:different-deployment-456|bounded-secret-material",
      "legacy-unscoped-key",
      "prod:resilient-donkey-323|",
      "",
    ]) {
      expect(() => assertConvexProductionDeployKey(key)).toThrow(
        "must target the Stensibly production deployment",
      );
    }
  });

  test("does not retain or publish a rejected key", () => {
    const rejected = "preview:team:project|private-material";
    try {
      assertConvexProductionDeployKey(rejected);
      throw new Error("Expected key admission to fail");
    } catch (error) {
      expect(String(error)).not.toContain(rejected);
      expect(String(error)).not.toContain("private-material");
    }
  });
});
