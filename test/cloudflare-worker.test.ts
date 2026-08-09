import { describe, expect, test } from "bun:test";
import worker, {
  stringEnvironment,
  type CloudflareBindings,
} from "../src/cloudflare-worker.ts";

describe("Cloudflare Worker entrypoint", () => {
  test("serves the public hosted health endpoint from Worker bindings", async () => {
    const response = await worker.fetch(
      new Request("https://stensibly-api.example/health", {
        headers: { "x-request-id": "health-test" },
      }),
      {
        CONVEX_URL: "https://example.convex.cloud",
        STENSIBLY_SERVICE_SECRET: "test-service-secret",
        STENSIBLY_WORKSPACE: "default",
        STENSIBLY_ALLOWED_ORIGINS: "https://stensibly.com",
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("health-test");
    expect(await response.json()).toMatchObject({
      ok: true,
      service: "stensibly",
      backend: "convex",
      surfaces: ["api-v1", "mcp"],
    });
  });

  test("forwards GitHub provider feature gates from Worker bindings", () => {
    const bindings: CloudflareBindings = {
      CONVEX_URL: "https://example.convex.cloud",
      STENSIBLY_SERVICE_SECRET: "test-service-secret",
      STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED: "true",
      STENSIBLY_GITHUB_PUBLICATION_WRITES_ENABLED: "true",
      STENSIBLY_GITHUB_DELEGATED_READS_ENABLED: "false",
      STENSIBLY_GITHUB_JOB_DETAIL_READS_ENABLED: "true",
    };

    expect(stringEnvironment(bindings)).toMatchObject({
      STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED: "true",
      STENSIBLY_GITHUB_PUBLICATION_WRITES_ENABLED: "true",
      STENSIBLY_GITHUB_DELEGATED_READS_ENABLED: "false",
      STENSIBLY_GITHUB_JOB_DETAIL_READS_ENABLED: "true",
    });
  });
});
