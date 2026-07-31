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
        sessionStorage.setItem("stensiblyToken", sentinel);
      } else {
        sessionStorage.removeItem("stensiblyToken");
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
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("signed-out root stays recoverable at narrow dark reduced-motion settings", async ({ page }, testInfo) => {
  const errors = collectBrowserErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await installDeterministicApi(page, { returningSession: false, itemsMode: "unauthorized" });

  const response = await page.goto("/");
  expect(response?.status()).toBe(200);

  await waitForRootMode(page, errors, "signed-out");
  await expect(page.getByRole("heading", { name: "Shared work." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
  await expect(page.locator("#root-connecting-status")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#root-connecting-status")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#dashboard")).toBeHidden();
  await expect(page.locator("#connect-form [name=token]")).toBeHidden();

  await page.getByText("Use API token", { exact: true }).click();
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

  await attachScreenshot(page, testInfo, "production-root-signed-out-narrow-dark");
  expect(errors).toEqual([]);
});

test("returning session exposes a real connecting status before the compact desk", async ({ page }, testInfo) => {
  const errors = collectBrowserErrors(page);
  await installDeterministicApi(page, { returningSession: true, itemsMode: "pending" });

  const response = await page.goto("/");
  expect(response?.status()).toBe(200);

  const root = page.locator("html");
  const status = page.locator("#root-connecting-status");
  await waitForRootMode(page, errors, "connecting");
  await expect(status).toBeVisible();
  await expect(status).toHaveAttribute("aria-busy", "true");
  await expect(status).toHaveAttribute("aria-hidden", "false");
  await expect(status).toContainText("Opening project desk…");
  await expect(page.locator(".hero-login")).toBeHidden();

  await page.evaluate(() => {
    (window as unknown as { __stensiblyRootApi: { resolveItems(): void } })
      .__stensiblyRootApi.resolveItems();
  });

  await expect(root).toHaveAttribute("data-app-mode", "connected");
  await expect(page.locator("#dashboard")).toBeVisible();
  await expect(page.locator("#connect-form")).toBeHidden();
  await expect(page.locator("#connected-summary")).toBeVisible();
  await expect(status).toBeHidden();
  await expect(status).toHaveAttribute("aria-busy", "false");
  await expect(status).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator(".hero-copy")).toBeHidden();

  await attachScreenshot(page, testInfo, "production-root-connected-desk");

  await page.getByRole("button", { name: "change connection" }).click();
  await expect(root).toHaveAttribute("data-app-mode", "editing");
  await expect(page.locator("#dashboard")).toBeVisible();
  await expect(page.locator("#connect-form")).toBeVisible();
  await expect(page.locator(".hero-copy")).toBeHidden();
  const editingHeight = await page.locator(".hero-login").evaluate((element) =>
    element.getBoundingClientRect().height,
  );
  expect(editingHeight).toBeLessThan(420);

  await page.getByRole("button", { name: "cancel" }).click();
  await expect(root).toHaveAttribute("data-app-mode", "connected");

  await page.evaluate(() => {
    (window as unknown as { __stensiblyRootApi: { setItemsMode(mode: ItemsMode): void } })
      .__stensiblyRootApi.setItemsMode("network-error");
  });
  await page.getByRole("button", { name: "refresh" }).click();

  await expect(root).toHaveAttribute("data-app-mode", "degraded");
  await expect(page.locator("#dashboard")).toBeVisible();
  await expect(page.locator("#connection-error")).toBeVisible();
  await expect(page.locator(".hero-copy")).toBeHidden();
  expect(errors).toEqual([]);
});
