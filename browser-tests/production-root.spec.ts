import { rm } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const hostedSentinel = `stn.tok_${"0".repeat(32)}.${"s".repeat(40)}`;

type ItemsMode = "pending" | "success" | "unauthorized" | "network-error";

async function installDeterministicApi(
  page: Page,
  options: { returningSession: boolean; itemsMode: ItemsMode },
): Promise<void> {
  await page.addInitScript(
    ({ returningSession, initialMode, sentinel }) => {
      if (returningSession) {
        // A new tab has no sessionStorage marker. The hosted bridge must restore
        // cookie mode before the app starts, while localStorage supplies the
        // last-known dashboard immediately.
        sessionStorage.removeItem("stensiblyToken");
        localStorage.setItem("stensiblyDashboardSnapshotV1", JSON.stringify({
          version: 1,
          endpoint: "https://api.stensibly.com",
          savedAt: new Date().toISOString(),
          items: [{
            id: "item_cached_overview",
            project: "stensibly",
            kind: "task",
            title: "Keep the last known studio visible",
            summary: "The live request is deliberately pending.",
            nextAction: "Revalidate quietly in the background.",
            status: "active",
            priority: 90,
            claimedBy: "Keel",
            claimExpiresAt: null,
            claimGeneration: 1,
            version: 3,
            createdAt: new Date(Date.now() - 60_000).toISOString(),
            updatedAt: new Date().toISOString(),
          }],
        }));
      } else {
        sessionStorage.removeItem("stensiblyToken");
        localStorage.removeItem("stensiblyDashboardSnapshotV1");
      }
      localStorage.setItem("stensiblyEndpoint", "https://api.stensibly.com");

      let itemsMode = initialMode;
      let resolvePending: ((response: Response) => void) | null = null;
      let pendingItems = new Promise<Response>((resolve) => {
        resolvePending = resolve;
      });

      const json = (body: unknown, status: number) => new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

      const control = {
        resolveItems() {
          itemsMode = "success";
          resolvePending?.(json({ items: [] }, 200));
          resolvePending = null;
        },
        setItemsMode(nextMode: ItemsMode) {
          itemsMode = nextMode;
          if (nextMode === "pending") {
            pendingItems = new Promise<Response>((resolve) => {
              resolvePending = resolve;
            });
          }
        },
      };

      Object.defineProperty(window, "__stensiblyRootApi", {
        value: control,
        configurable: false,
        enumerable: false,
        writable: false,
      });

      Object.defineProperty(window, "fetch", {
        configurable: true,
        writable: true,
        value: async (input: RequestInfo | URL) => {
          const url = new URL(
            typeof input === "string" || input instanceof URL ? String(input) : input.url,
            window.location.href,
          );

          if (url.pathname === "/api/v1/items") {
            if (itemsMode === "pending") return pendingItems;
            if (itemsMode === "success") return json({ items: [] }, 200);
            if (itemsMode === "unauthorized") {
              return json({ error: { code: "invalid_token", message: "Sign in required." } }, 401);
            }
            throw new TypeError("fixture API unavailable");
          }

          if (url.pathname === "/api/v1/principal") {
            return json({ error: { code: "not_found", message: "Capability unavailable." } }, 404);
          }

          if (url.pathname === "/health") {
            if (itemsMode === "network-error") throw new TypeError("fixture health unavailable");
            return new Response(null, { status: 204 });
          }

          return json({ error: { code: "not_found", message: "Fixture route unavailable." } }, 404);
        },
      });
    },
    {
      returningSession: options.returningSession,
      initialMode: options.itemsMode,
      sentinel: hostedSentinel,
    },
  );
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`page:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console:${message.text()}`);
  });
  return errors;
}

async function waitForRootMode(page: Page, errors: string[], expected: string): Promise<void> {
  try {
    await page.waitForFunction(
      (mode) => document.documentElement.dataset.appMode === mode,
      expected,
      { timeout: 5_000 },
    );
  } catch {
    const diagnostics = await page.evaluate(() => ({
      mode: document.documentElement.dataset.appMode ?? null,
      title: document.title,
      heading: document.querySelector("h1")?.textContent ?? null,
      scripts: Array.from(document.scripts, (script) => script.src || "inline"),
      bridgePresent: Boolean(document.querySelector('script[src="/hosted-session-bridge.js"]')),
      readyState: document.readyState,
    }));
    throw new Error(`Root mode ${expected} was not reached: ${JSON.stringify({ errors, diagnostics })}`);
  }
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const sourcePath = testInfo.outputPath("attachment-source.png");
  try {
    await page.screenshot({
      path: sourcePath,
      fullPage: true,
      animations: "disabled",
      caret: "hide",
    });
    await testInfo.attach(name, { path: sourcePath, contentType: "image/png" });
  } finally {
    await rm(sourcePath, { force: true });
  }
}

test("signed-out root stays recoverable at narrow dark reduced-motion settings", async ({ page }, testInfo) => {
  const errors = collectBrowserErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await installDeterministicApi(page, { returningSession: false, itemsMode: "unauthorized" });

  const response = await page.goto("/");
  expect(response?.status()).toBe(200);

  await waitForRootMode(page, errors, "signed-out");
  await expect(page.getByRole("heading", { name: "Know what needs you." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
  await expect(page.locator("#root-connecting-status")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#root-connecting-status")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#dashboard")).toBeHidden();
  await expect(page.locator("#connect-form [name=token]")).toBeHidden();
  await expect(page.locator("#connection-error")).toBeHidden();
  await expect(page.locator("#connection-state")).toHaveText("disconnected");
  await expect(page.locator("#hosted-sign-out")).toBeHidden();

  await attachScreenshot(page, testInfo, "production-root-signed-out-narrow-dark");

  await page.getByText("Connect another endpoint", { exact: true }).click();
  await expect(page.locator("#connect-form [name=token]")).toBeVisible();
  await expect(page.locator("#connect-form [name=endpoint]")).toBeVisible();

  const viewportBoundary = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
  }));
  expect(viewportBoundary.scrollWidth).toBeLessThanOrEqual(viewportBoundary.width + 1);
  expect(viewportBoundary.reduced).toBe(true);
  expect(viewportBoundary.dark).toBe(true);

  expect(errors).toEqual([]);
});

test("returning session shows the last known overview before live reconciliation", async ({ page }, testInfo) => {
  const errors = collectBrowserErrors(page);
  await installDeterministicApi(page, { returningSession: true, itemsMode: "pending" });

  const response = await page.goto("/");
  expect(response?.status()).toBe(200);

  const root = page.locator("html");
  const status = page.locator("#root-connecting-status");
  await waitForRootMode(page, errors, "connected");
  await expect(page.locator(".hero-login")).toBeHidden();
  await expect(page.locator("#dashboard")).toBeVisible();
  await expect(page.locator("#sync-state")).toContainText("Saved");
  await expect(page.locator('.overview-item[data-overview-item-id="item_cached_overview"]').first()).toBeVisible();
  await expect(page.getByText("Keep the last known studio visible", { exact: true }).first()).toBeVisible();
  await expect(status).toBeHidden();
  await expect(status).toHaveAttribute("aria-busy", "false");
  await expect(status).toHaveAttribute("aria-hidden", "true");

  await attachScreenshot(page, testInfo, "production-root-last-known-overview");
  await page.locator('.overview-item[data-overview-item-id="item_cached_overview"]').first().click();
  await expect(page.locator("#item-detail-dialog")).toBeVisible();
  await page.getByRole("button", { name: "Close item detail" }).click();
  await expect(page.locator("#item-detail-dialog")).toBeHidden();

  await page.evaluate(() => {
    (window as unknown as { __stensiblyRootApi: { resolveItems(): void } })
      .__stensiblyRootApi.resolveItems();
  });

  await expect(root).toHaveAttribute("data-app-mode", "connected");
  await expect(page.locator("#dashboard")).toBeVisible();
  await expect(page.locator("#sync-state")).toContainText("Live");
  await expect(page.locator('[data-overview-item-id="item_cached_overview"]')).toHaveCount(0);
  await expect(page.locator("#connect-form")).toBeHidden();
  await expect(page.locator("#connected-summary")).toBeHidden();
  await expect(status).toBeHidden();
  await expect(page.locator(".hero-copy")).toBeHidden();

  await attachScreenshot(page, testInfo, "production-root-connected-desk");

  await page.setViewportSize({ width: 390, height: 844 });
  const narrowBoundary = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(narrowBoundary.scrollWidth).toBeLessThanOrEqual(narrowBoundary.width + 1);
  await expect(page.locator('[data-dashboard-view-panel="overview"]')).toBeVisible();
  await attachScreenshot(page, testInfo, "production-root-connected-overview-narrow");
  await page.setViewportSize({ width: 1_440, height: 900 });

  await page.getByRole("button", { name: "Work", exact: true }).click();
  await expect(page.locator('[data-dashboard-view-panel="work"]')).toBeVisible();
  await expect(page.locator("#board-filter-panel")).toBeVisible();
  await page.reload();
  await waitForRootMode(page, errors, "connected");
  await expect(page.locator('[data-dashboard-view-panel="work"]')).toBeVisible();

  await page.getByRole("button", { name: "Use light theme" }).click();
  await expect(root).toHaveAttribute("data-theme", "light");
  await page.reload();
  await waitForRootMode(page, errors, "connected");
  await expect(root).toHaveAttribute("data-theme", "light");

  await page.getByRole("button", { name: "System", exact: true }).click();
  await expect(page.locator("#connected-summary")).toBeVisible();
  await page.getByRole("button", { name: "Change", exact: true }).click();
  await expect(root).toHaveAttribute("data-app-mode", "editing");
  await expect(page.locator("#dashboard")).toBeVisible();
  await expect(page.locator("#connect-form")).toBeVisible();
  await expect(page.locator(".hero-copy")).toBeHidden();
  const editingHeight = await page.locator(".hero-login").evaluate((element) =>
    element.getBoundingClientRect().height,
  );
  expect(editingHeight).toBeLessThan(420);

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(root).toHaveAttribute("data-app-mode", "connected");

  await page.evaluate(() => {
    (window as unknown as { __stensiblyRootApi: { setItemsMode(mode: ItemsMode): void } })
      .__stensiblyRootApi.setItemsMode("network-error");
  });
  await page.getByRole("button", { name: "Sync now" }).click();

  await expect(root).toHaveAttribute("data-app-mode", "degraded");
  await expect(page.locator("#dashboard")).toBeVisible();
  await expect(page.locator("#connection-error")).toBeVisible();
  await expect(page.locator(".hero-copy")).toBeHidden();
  expect(errors).toEqual([]);
});
