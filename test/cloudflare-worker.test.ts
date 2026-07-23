import { describe, expect, test } from "bun:test";
import worker from "../src/cloudflare-worker.ts";

describe("Cloudflare Worker entrypoint", () => {
  test("serves the public hosted health endpoint from Worker bindings", async () => {
    const response = await worker.fetch(
      new Request("https://stensibly-api.example/health"),
      {
        CONVEX_URL: "https://example.convex.cloud",
        STENSIBLY_SERVICE_SECRET: "test-service-secret",
        STENSIBLY_WORKSPACE: "default",
        STENSIBLY_ALLOWED_ORIGINS: "https://stensibly.com",
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      service: "stensibly",
      backend: "convex",
      surfaces: ["api-v1", "mcp"],
    });
  });
});
