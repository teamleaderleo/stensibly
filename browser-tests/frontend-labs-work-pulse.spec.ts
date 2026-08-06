import { expect, test } from "@playwright/test";

test("renders Work Pulse inside the opaque Labs comparison sandbox", async ({ context, page }, testInfo) => {
  const allowedOrigin = resolvedOrigin(testInfo.project.use.baseURL);
  const unexpectedRequests = new Set<string>();
  const browserErrors: string[] = [];

  context.on("request", (request) => {
    const url = request.url();
    if (!isAllowedBrowserUrl(url, allowedOrigin)) unexpectedRequests.add(url);
  });
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (isAllowedBrowserUrl(url, allowedOrigin)) {
      await route.continue();
      return;
    }
    unexpectedRequests.add(url);
    await route.abort("blockedbyclient");
  });
  context.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  context.on("weberror", (error) => {
    browserErrors.push(`weberror: ${error.error().message}`);
  });

  const response = await page.goto("/labs/?compare=quiet-control,work-pulse");
  expect(response?.status()).toBe(200);

  const compare = page.getByRole("button", { name: "Compare selected" });
  await expect(compare).toBeEnabled();
  await compare.click();

  const frames = page.locator("iframe");
  await expect(frames).toHaveCount(2);
  for (const frame of await frames.all()) {
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  }

  const pulse = page.frameLocator('iframe[title="Work Pulse isolated preview"]');
  await expect(pulse.getByRole("heading", { name: "Observed execution evidence" })).toBeVisible();
  await expect(pulse.locator("body")).toHaveAttribute("data-stensibly-lab", "prototype");
  await expect(pulse.locator(".brief-facts")).toContainText("UTC");

  const skipLink = pulse.getByRole("link", { name: "Skip to attention ledger" });
  await activateSkipLink(skipLink);
  await expect(pulse.locator("#attention")).toBeFocused();

  await expect(pulse.locator('[data-record-id="ember-runtime"]')).toContainText("generation 7");
  await expect(pulse.locator('[data-record-id="attention-ambiguous"]')).toContainText(
    "Reconcile the exact operation receipt before replay.",
  );
  await expect(pulse.locator('[data-record-id="rel-overlay-supersedes"]')).toContainText(
    "Sable → Sable",
  );
  await expect(pulse.locator('[data-record-id="event-overlay-candidate"]')).toContainText(
    "Current candidate head published.",
  );

  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  expect([...unexpectedRequests]).toEqual([]);
  expect(browserErrors).toEqual([]);
});

test("renders the focusable empty Work Pulse state", async ({ page }) => {
  const response = await page.goto("/labs/work-pulse/?scenario=empty");
  expect(response?.status()).toBe(200);

  await expect(page.getByRole("heading", {
    name: "No attempts are shown in this preview",
  })).toBeVisible();
  const target = page.locator("#attention");
  await expect(target).toHaveAttribute("tabindex", "-1");
  await activateSkipLink(page.getByRole("link", { name: "Skip to attention ledger" }));
  await expect(target).toBeFocused();
});

test("renders degraded evidence without claiming current provider state", async ({ page }) => {
  const response = await page.goto("/labs/work-pulse/?scenario=degraded");
  expect(response?.status()).toBe(200);

  await expect(page.getByRole("status")).toContainText(
    "no claim is made that provider or runner state is still current",
  );
  await expect(page.locator('[data-record-id="ember-runtime"]')).toContainText(
    "generation 7",
  );
  await expect(page.locator(".brief-facts")).toContainText("UTC");
});

test("fails closed with a focusable panel when the fixture bridge is missing", async ({ page }) => {
  await page.route("**/work-pulse-fixtures.classic.js", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/javascript; charset=utf-8",
      body: "",
    });
  });

  const response = await page.goto("/labs/work-pulse/");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("alert")).toContainText(
    "The Work Pulse fixture could not be admitted",
  );
  await expect(page.getByRole("alert")).toContainText(
    "The Work Pulse fixture bridge is unavailable",
  );

  const target = page.locator("#attention");
  await expect(target).toHaveAttribute("tabindex", "-1");
  await activateSkipLink(page.getByRole("link", { name: "Skip to attention ledger" }));
  await expect(target).toBeFocused();
});

async function activateSkipLink(
  link: ReturnType<import("@playwright/test").Page["getByRole"]>,
): Promise<void> {
  await expect(link).toBeVisible();
  await link.focus();
  await expect(link).toBeFocused();
  await link.press("Enter");
}

function resolvedOrigin(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Work Pulse browser evidence requires a configured Playwright baseURL");
  }
  return new URL(value).origin;
}

function isAllowedBrowserUrl(value: string, allowedOrigin: string): boolean {
  if (value.startsWith("data:") || value.startsWith("about:")) return true;
  try {
    return new URL(value).origin === allowedOrigin;
  } catch {
    return false;
  }
}
