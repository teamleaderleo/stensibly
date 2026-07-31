import { expect, test } from "@playwright/test";

test("denies same-origin service-worker creation through the fixture response policy", async ({ context, page }) => {
  const response = await page.goto("/labs/");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-security-policy"]).toContain("worker-src 'none'");

  const outcome = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return { blocked: true, name: "unsupported" };
    try {
      await navigator.serviceWorker.register("/labs/fixtures.classic.js", {
        scope: "/labs/",
      });
      return { blocked: false, name: "registered" };
    } catch (error) {
      return {
        blocked: true,
        name: error instanceof Error ? error.name : "unknown",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });

  expect(outcome.blocked).toBe(true);
  expect(outcome.name).not.toBe("registered");
  expect(context.serviceWorkers()).toHaveLength(0);
});
