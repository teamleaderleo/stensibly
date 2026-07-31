import { expect, test } from "@playwright/test";
import { frontendLabManifest } from "../site/labs/manifest.js";

const labsRoot = "/labs/";

test("denies service-worker creation across every frontend evidence surface", async ({ context, page }) => {
  const createdWorkers: string[] = [];
  context.on("serviceworker", (worker) => createdWorkers.push(worker.url()));

  const catalogue = await page.goto(labsRoot);
  expect(catalogue?.status()).toBe(200);
  expect(catalogue?.headers()["content-security-policy"]).toContain("worker-src 'none'");

  for (const variant of frontendLabManifest) {
    const route = `${labsRoot}${variant.id}/`;
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    await expect(page.locator("body")).toHaveAttribute("data-stensibly-lab", "prototype");

    if (variant.support.includes("degraded")) {
      const degraded = await page.goto(`${route}?scenario=degraded`);
      expect(degraded?.status()).toBe(200);
      await expect(page.locator("body")).toHaveAttribute("data-scenario", "degraded");
    }
  }

  const comparison = await page.goto(`${labsRoot}?compare=quiet-control,soft-companion`);
  expect(comparison?.status()).toBe(200);
  const compare = page.getByRole("button", { name: "Compare selected" });
  await expect(compare).toBeEnabled();
  await compare.click();
  const frames = page.locator("iframe");
  await expect(frames).toHaveCount(2);
  for (const frame of await frames.all()) {
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  }

  await page.goto(labsRoot);
  const outcome = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return { blocked: false, name: "unsupported" };
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
  expect(outcome.name).not.toBe("unsupported");
  await page.waitForTimeout(250);
  expect(createdWorkers).toEqual([]);
  expect(context.serviceWorkers()).toHaveLength(0);
});
