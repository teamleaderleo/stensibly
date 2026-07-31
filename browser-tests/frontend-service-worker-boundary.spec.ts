import { expect, test } from "@playwright/test";

test("denies service worker registration at the fixture response boundary", async ({ context, page }) => {
  const response = await page.goto("/labs/");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-security-policy"]).toContain("worker-src 'none'");

  const outcome = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return "unavailable";
    try {
      await navigator.serviceWorker.register("/labs/fixture-worker.js");
      return "registered";
    } catch {
      return "blocked";
    }
  });

  expect(outcome).toBe("blocked");
  expect(context.serviceWorkers()).toEqual([]);
});
