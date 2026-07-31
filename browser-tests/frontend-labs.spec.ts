import { rm, writeFile } from "node:fs/promises";
import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import {
  createFrontendLabEvidencePlan,
  type FrontendLabEvidenceCase,
} from "../site/labs/evidence.js";
import { frontendLabFixture, frontendLabTasks } from "../site/labs/fixtures.js";
import { frontendLabManifest } from "../site/labs/manifest.js";

const allowedOrigin = "http://127.0.0.1:4173";
const maximumAttachmentStemLength = 180;
const evidencePlan = createFrontendLabEvidencePlan();
const tasksById = new Map(frontendLabTasks.map((task) => [task.id, task]));
const variantsById = new Map(frontendLabManifest.map((variant) => [variant.id, variant]));
const canonicalRoutes = canonicalRouteCases();
const responsiveRouteCases = responsiveEvidenceCases();
const degradedRouteCases = degradedEvidenceCases();

test("keeps the fixture server bounded to public site reads", async ({ request }, testInfo) => {
  const catalogue = await request.get("/labs/", { maxRedirects: 0 });
  expect(catalogue.status()).toBe(200);
  expect(catalogue.headers()["content-security-policy"]).toContain("connect-src 'none'");
  expect(catalogue.headers()["cache-control"]).toBe("no-store");

  const missing = await request.get("/labs/missing-evidence-route", { maxRedirects: 0 });
  expect(missing.status()).toBe(404);

  const traversal = await request.get("/labs/%2e%2e/%2e%2e/package.json", { maxRedirects: 0 });
  expect(traversal.status()).toBe(404);
  expect(await traversal.text()).not.toContain('"name": "stensibly"');

  const write = await request.post("/labs/", { maxRedirects: 0 });
  expect(write.status()).toBe(405);
  expect(write.headers().allow).toBe("GET, HEAD");

  await attachSyntheticReceipt(testInfo, "server-boundary", []);
});

test("renders the labs catalogue from canonical route evidence cases", async ({ context, page }, testInfo) => {
  const evidence = await prepareEvidence(context, page);
  const firstCase = requiredFirst(canonicalRoutes, "catalogue route cases");
  await applyEvidenceCase(page, firstCase);

  const response = await page.goto("/labs/");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Compare several ways Stensibly could feel." })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("invented local fixtures");
  await expect(page.locator("[data-variant-id]")).toHaveCount(canonicalRoutes.length);

  for (const evidenceCase of canonicalRoutes) {
    const variant = requiredVariant(evidenceCase.variantId);
    const card = page.locator(`[data-variant-id="${variant.id}"]`);
    await expect(card.getByRole("heading", { name: variant.title, exact: true })).toBeVisible();
    await expect(card.getByRole("checkbox", { name: `Select ${variant.title} for comparison` })).toBeVisible();
    await expect(card).toContainText(variant.revision ?? "unreviewed");
  }

  await assertNoHorizontalOverflow(page);
  await assertNamedInteractiveControls(page);
  await attachSyntheticScreenshot(page, testInfo, "catalogue");
  await attachSyntheticReceipt(testInfo, "catalogue", canonicalRoutes);
  await evidence.assertClean();
});

for (const evidenceCase of responsiveRouteCases) {
  const variant = requiredVariant(evidenceCase.variantId);
  test(`renders ${variant.title} ${evidenceCase.profileId} ${evidenceCase.colorScheme} ${evidenceCase.motion}`, async ({ context, page }, testInfo) => {
    const evidence = await prepareEvidence(context, page);
    await applyEvidenceCase(page, evidenceCase);

    const response = await page.goto(routeForEvidenceCase(evidenceCase));
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(new RegExp(escapeRegExp(variant.title)));
    await expect(page.locator("body")).toHaveAttribute("data-stensibly-lab", "prototype");
    await assertNoHorizontalOverflow(page);
    await assertNamedInteractiveControls(page);

    await attachEvidenceCase(page, testInfo, evidenceCase);
    await evidence.assertClean();
  });
}

for (const evidenceCase of degradedRouteCases) {
  const variant = requiredVariant(evidenceCase.variantId);
  test(`renders ${variant.title} degraded fixture scenario`, async ({ context, page }, testInfo) => {
    const evidence = await prepareEvidence(context, page);
    await applyEvidenceCase(page, evidenceCase);

    const response = await page.goto(routeForEvidenceCase(evidenceCase));
    expect(response?.status()).toBe(200);
    await expect(page.locator("body")).toHaveAttribute("data-scenario", "degraded");
    await assertNoHorizontalOverflow(page);
    await assertNamedInteractiveControls(page);

    await attachEvidenceCase(page, testInfo, evidenceCase);
    await evidence.assertClean();
  });
}

test("compares canonical Quiet Control and Soft Companion routes without widening the sandbox", async ({ context, page }, testInfo) => {
  const evidence = await prepareEvidence(context, page);
  const quietCase = requiredRouteCase("quiet-control", "wide", "light", "no-preference", "default");
  const softCase = requiredRouteCase("soft-companion", "wide", "light", "no-preference", "default");
  await applyEvidenceCase(page, quietCase);

  const response = await page.goto(`/labs/?compare=${quietCase.variantId},${softCase.variantId}`);
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

  const quiet = page.frameLocator(`iframe[title="${requiredVariant(quietCase.variantId).title} isolated preview"]`);
  await expect(quiet.getByRole("heading", { name: "Attention" })).toBeVisible();
  const soft = page.frameLocator(`iframe[title="${requiredVariant(softCase.variantId).title} isolated preview"]`);
  await expect(soft.getByRole("heading", { name: "A gentle place for exact work." })).toBeVisible();
  await expect(soft.getByText(requiredVariant(softCase.variantId).title, { exact: true }).first()).toBeVisible();

  await attachSyntheticScreenshot(page, testInfo, "comparison-quiet-control-soft-companion");
  await attachSyntheticReceipt(testInfo, "comparison", [quietCase, softCase]);
  await evidence.assertClean();
});

test("executes every shared task through canonical Quiet Control task cases", async ({ context, page }, testInfo) => {
  const evidence = await prepareEvidence(context, page);
  const taskCases = canonicalTaskCases("quiet-control", "wide");
  expect(taskCases.map((entry) => entry.taskId)).toEqual(frontendLabTasks.map((task) => task.id));

  for (const evidenceCase of taskCases) {
    const task = requiredTask(evidenceCase.taskId);
    expect(evidenceCase.expectedIdentity).toBe(task.success);
    await applyEvidenceCase(page, evidenceCase);
    const response = await page.goto(routeForEvidenceCase(evidenceCase));
    expect(response?.status()).toBe(200);

    await selectSharedTask(page, task.prompt);
    const expectedIds = evidenceCase.expectedIdentity.split(",");
    const expectedConnections = frontendLabFixture.connections.filter((connection) => expectedIds.includes(connection.id));

    if (expectedConnections.length === expectedIds.length) {
      const connectionHealth = page.locator("#connection-health");
      await expect(connectionHealth).toBeFocused();
      for (const connection of expectedConnections) {
        await expect(connectionHealth).toContainText(`${connection.label} ${connection.state}`);
      }
    } else {
      const target = recordByIdentity(page, requiredFirst(expectedIds, `${task.id} success identities`));
      await expect(target).toHaveAttribute("aria-current", "true");
      await expect(target).toBeFocused();
      if (task.id === "worker-health") {
        for (const worker of frontendLabFixture.workers) {
          await expect(recordByIdentity(page, worker.id)).toBeVisible();
        }
      }
    }

    await attachEvidenceCase(page, testInfo, evidenceCase);
  }

  await evidence.assertClean();
});

test("preserves Quiet Control keyboard movement and exact command return focus", async ({ context, page }, testInfo) => {
  const evidence = await prepareEvidence(context, page);
  const evidenceCase = requiredRouteCase("quiet-control", "wide", "dark", "reduce", "default");
  await applyEvidenceCase(page, evidenceCase);
  const response = await page.goto(routeForEvidenceCase(evidenceCase));
  expect(response?.status()).toBe(200);

  await page.keyboard.press("2");
  await expect(page.getByRole("heading", { name: "Active" })).toBeVisible();
  await page.keyboard.press("j");

  const unhealthyWorker = frontendLabFixture.workers.find((worker) => worker.state === "unhealthy");
  if (!unhealthyWorker) throw new Error("Shared fixture requires one unhealthy worker");
  const unhealthyRecord = recordByIdentity(page, unhealthyWorker.id);
  await expect(unhealthyRecord).toHaveAttribute("aria-current", "true");
  await expect(unhealthyRecord).toBeFocused();

  await page.keyboard.press("/");
  const dialog = page.getByRole("dialog", { name: "Search, shared tasks, and commands" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search work, shared tasks, and commands" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(unhealthyRecord).toBeFocused();

  await page.keyboard.press("4");
  await expect(page.getByRole("heading", { name: "Recover" })).toBeVisible();
  const ambiguousOperation = frontendLabFixture.operations.find((operation) => operation.state === "ambiguous");
  if (!ambiguousOperation) throw new Error("Shared fixture requires one ambiguous operation");
  await expect(recordByIdentity(page, ambiguousOperation.id)).toBeFocused();

  await attachEvidenceCase(page, testInfo, evidenceCase);
  await evidence.assertClean();
});

test("preserves canonical task identity through narrow list and detail navigation", async ({ context, page }, testInfo) => {
  const evidence = await prepareEvidence(context, page);
  const evidenceCase = requiredTaskCase("quiet-control", "narrow", "dark", "reduce", "human-decision");
  const task = requiredTask(evidenceCase.taskId);
  await applyEvidenceCase(page, evidenceCase);
  const response = await page.goto(routeForEvidenceCase(evidenceCase));
  expect(response?.status()).toBe(200);

  await selectSharedTask(page, task.prompt);
  const decision = recordByIdentity(page, evidenceCase.expectedIdentity);
  await expect(decision).toBeFocused();
  await page.keyboard.press("Enter");

  const workspace = page.locator("#workspace");
  await expect(workspace).toHaveAttribute("data-mobile-detail", "true");
  await expect(page.getByRole("heading", { name: frontendLabFixture.decision.title })).toBeVisible();
  const back = page.getByRole("button", { name: "← List" });
  await expect(back).toBeVisible();
  await assertNoHorizontalOverflow(page);

  await attachEvidenceCase(page, testInfo, evidenceCase);
  await back.click();
  await expect(workspace).toHaveAttribute("data-mobile-detail", "false");
  await expect(page.getByRole("heading", { name: "Attention" })).toBeVisible();
  await expect(decision).toBeFocused();

  await evidence.assertClean();
});

function canonicalRouteCases(): FrontendLabEvidenceCase[] {
  return frontendLabManifest.map((variant) => requiredRouteCase(
    variant.id,
    "wide",
    preferredColorScheme(variant, "light"),
    "no-preference",
    "default",
  ));
}

function responsiveEvidenceCases(): FrontendLabEvidenceCase[] {
  const cases = frontendLabManifest.flatMap((variant) => [
    requiredRouteCase(variant.id, "wide", preferredColorScheme(variant, "light"), "no-preference", "default"),
    requiredRouteCase(variant.id, "narrow", preferredColorScheme(variant, "dark"), "reduce", "default"),
    requiredRouteCase(variant.id, "zoom-200", preferredColorScheme(variant, "light"), "reduce", "default"),
  ]);
  assertUniqueCaseIds(cases, "responsive route evidence");
  return cases;
}

function degradedEvidenceCases(): FrontendLabEvidenceCase[] {
  const cases = frontendLabManifest
    .filter((variant) => variant.support.includes("degraded"))
    .map((variant) => requiredRouteCase(
      variant.id,
      "wide",
      preferredColorScheme(variant, "light"),
      "no-preference",
      "degraded",
    ));
  assertUniqueCaseIds(cases, "degraded route evidence");
  return cases;
}

function canonicalTaskCases(variantId: string, profileId: string): FrontendLabEvidenceCase[] {
  const variant = requiredVariant(variantId);
  const colorScheme = preferredColorScheme(variant, "light");
  return frontendLabTasks.map((task) => requiredTaskCase(
    variantId,
    profileId,
    colorScheme,
    "no-preference",
    task.id,
  ));
}

function requiredRouteCase(
  variantId: string,
  profileId: string,
  colorScheme: FrontendLabEvidenceCase["colorScheme"],
  motion: FrontendLabEvidenceCase["motion"],
  scenarioId: string,
): FrontendLabEvidenceCase {
  return requiredEvidenceCase((entry) =>
    entry.kind === "route"
    && entry.variantId === variantId
    && entry.profileId === profileId
    && entry.colorScheme === colorScheme
    && entry.motion === motion
    && entry.scenarioId === scenarioId,
  `route ${variantId}/${profileId}/${colorScheme}/${motion}/${scenarioId}`);
}

function requiredTaskCase(
  variantId: string,
  profileId: string,
  colorScheme: FrontendLabEvidenceCase["colorScheme"],
  motion: FrontendLabEvidenceCase["motion"],
  taskId: string,
): FrontendLabEvidenceCase {
  return requiredEvidenceCase((entry) =>
    entry.kind === "task"
    && entry.variantId === variantId
    && entry.profileId === profileId
    && entry.colorScheme === colorScheme
    && entry.motion === motion
    && entry.scenarioId === "default"
    && entry.taskId === taskId,
  `task ${taskId} for ${variantId}/${profileId}/${colorScheme}/${motion}`);
}

function requiredEvidenceCase(
  predicate: (entry: FrontendLabEvidenceCase) => boolean,
  label: string,
): FrontendLabEvidenceCase {
  const evidenceCase = evidencePlan.cases.find(predicate);
  if (!evidenceCase) throw new Error(`Evidence plan is missing ${label}`);
  return evidenceCase;
}

function requiredVariant(variantId: string) {
  const variant = variantsById.get(variantId);
  if (!variant) throw new Error(`Unknown frontend lab variant ${variantId}`);
  return variant;
}

function requiredTask(taskId: string | null) {
  if (!taskId) throw new Error("Task evidence case is missing a task identity");
  const task = tasksById.get(taskId);
  if (!task) throw new Error(`Unknown frontend lab task ${taskId}`);
  return task;
}

function preferredColorScheme(
  variant: ReturnType<typeof requiredVariant>,
  preferred: FrontendLabEvidenceCase["colorScheme"],
): FrontendLabEvidenceCase["colorScheme"] {
  if (variant.support.includes(preferred)) return preferred;
  const fallback = preferred === "light" ? "dark" : "light";
  if (variant.support.includes(fallback)) return fallback;
  throw new Error(`Variant ${variant.id} has no supported color scheme`);
}

function routeForEvidenceCase(evidenceCase: FrontendLabEvidenceCase): string {
  return evidenceCase.scenarioId === "default"
    ? evidenceCase.route
    : `${evidenceCase.route}?scenario=${encodeURIComponent(evidenceCase.scenarioId)}`;
}

function recordByIdentity(page: Page, identity: string) {
  return page.locator(`[data-record-id="${identity}"]`);
}

function requiredFirst<T>(values: readonly T[], label: string): T {
  const value = values[0];
  if (value === undefined) throw new Error(`${label} must contain at least one value`);
  return value;
}

function assertUniqueCaseIds(cases: readonly FrontendLabEvidenceCase[], label: string) {
  if (new Set(cases.map((entry) => entry.id)).size !== cases.length) {
    throw new Error(`${label} must use unique evidence cases`);
  }
}

async function selectSharedTask(page: Page, prompt: string) {
  await page.keyboard.press("/");
  const dialog = page.getByRole("dialog", { name: "Search, shared tasks, and commands" });
  await expect(dialog).toBeVisible();
  const commandInput = page.getByRole("searchbox", { name: "Search work, shared tasks, and commands" });
  await expect(commandInput).toBeFocused();
  await commandInput.fill(prompt);
  const option = page.getByRole("button", { name: `Task: ${prompt}` });
  await expect(option).toBeVisible();
  await option.click();
  await expect(dialog).toBeHidden();
}

async function applyEvidenceCase(page: Page, evidenceCase: FrontendLabEvidenceCase) {
  if (![100, 200].includes(evidenceCase.zoomPercent)) {
    throw new Error(`Browser flow selected unsupported zoom case ${evidenceCase.id}`);
  }
  const zoomScale = 100 / evidenceCase.zoomPercent;
  await page.setViewportSize({
    width: Math.round(evidenceCase.viewportWidth * zoomScale),
    height: Math.round(evidenceCase.viewportHeight * zoomScale),
  });
  await page.emulateMedia({
    colorScheme: evidenceCase.colorScheme,
    reducedMotion: evidenceCase.motion,
  });
}

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const widest = Math.max(root.scrollWidth, document.body?.scrollWidth ?? 0);
    return widest - root.clientWidth;
  });
  expect(overflow, "horizontal overflow in canonical evidence case").toBeLessThanOrEqual(1);
}

async function assertNamedInteractiveControls(page: Page) {
  const unnamed = await page.locator('button, input, select, textarea, a[href], [role="button"], [role="tab"]').evaluateAll((nodes) =>
    nodes.flatMap((node) => {
      if (!(node instanceof HTMLElement)) return [];
      const style = getComputedStyle(node);
      if (node.hidden || style.display === "none" || style.visibility === "hidden" || node.getAttribute("aria-hidden") === "true") return [];
      if (node instanceof HTMLInputElement && node.type === "hidden") return [];

      const labelledBy = (node.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/u)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
        .join(" ")
        .trim();
      const associatedLabels = "labels" in node && node.labels
        ? [...node.labels].map((label) => label.textContent?.trim() ?? "").join(" ").trim()
        : "";
      const name = [
        node.getAttribute("aria-label") ?? "",
        labelledBy,
        associatedLabels,
        node.getAttribute("title") ?? "",
        node.textContent?.trim() ?? "",
        node instanceof HTMLInputElement ? node.value.trim() : "",
      ].find((candidate) => candidate.length > 0);
      return name ? [] : [`${node.tagName.toLowerCase()}#${node.id || "unnamed"}`];
    }));
  expect(unnamed, "visible interactive controls without a deterministic name").toEqual([]);
}

async function prepareEvidence(context: BrowserContext, page: Page) {
  const unexpectedRequests = new Set<string>();
  const browserErrors: string[] = [];

  const recordUnexpectedRequest = (requestUrl: string) => {
    if (isAllowedBrowserUrl(requestUrl)) return;
    unexpectedRequests.add(requestUrl);
  };

  context.on("request", (request) => recordUnexpectedRequest(request.url()));
  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    if (isAllowedBrowserUrl(requestUrl)) {
      await route.continue();
      return;
    }
    unexpectedRequests.add(requestUrl);
    await route.abort("blockedbyclient");
  });

  await context.routeWebSocket("**/*", async (webSocket) => {
    unexpectedRequests.add(webSocket.url());
    await webSocket.close({ code: 1008, reason: "Browser evidence denies WebSockets" });
  });

  context.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  context.on("weberror", (webError) => browserErrors.push(`weberror: ${webError.error().message}`));
  context.on("dialog", (dialog) => {
    browserErrors.push(`dialog: ${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });

  const watchPage = (candidate: Page) => {
    candidate.on("download", (download) => {
      browserErrors.push(`download: ${download.suggestedFilename()}`);
      void download.cancel();
    });
    candidate.on("crash", () => browserErrors.push(`crash: ${candidate.url()}`));
  };
  watchPage(page);
  context.on("page", watchPage);

  return {
    async assertClean() {
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
      expect([...unexpectedRequests], "unexpected external browser requests").toEqual([]);
      expect(browserErrors, "browser console, page, dialog, download, and crash errors").toEqual([]);
    },
  };
}

function isAllowedBrowserUrl(requestUrl: string): boolean {
  if (requestUrl.startsWith("data:") || requestUrl.startsWith("about:")) return true;
  try {
    return new URL(requestUrl).origin === allowedOrigin;
  } catch {
    return false;
  }
}

function syntheticStem(label: string): string {
  const normalized = label.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  const stem = `frontend-labs-${normalized}--fixture-${evidencePlan.fixtureRevision.slice(0, 16)}--plan-${evidencePlan.planRevision.slice(0, 16)}`;
  if (!normalized || stem.length > maximumAttachmentStemLength) {
    throw new Error(`Browser evidence attachment stem must contain 1-${maximumAttachmentStemLength} characters`);
  }
  return stem;
}

function evidenceAttachmentStem(evidenceCase: FrontendLabEvidenceCase): string {
  const caseIndex = evidencePlan.cases.findIndex((entry) => entry.id === evidenceCase.id);
  if (caseIndex < 0) throw new Error(`Unknown browser evidence case ${evidenceCase.id}`);
  return syntheticStem([
    `case-${String(caseIndex + 1).padStart(3, "0")}`,
    evidenceCase.variantId,
    evidenceCase.kind,
    evidenceCase.profileId,
    evidenceCase.colorScheme,
    evidenceCase.motion,
    evidenceCase.scenarioId,
    evidenceCase.taskId ?? "route",
  ].join("-"));
}

async function attachEvidenceCase(page: Page, testInfo: TestInfo, evidenceCase: FrontendLabEvidenceCase) {
  const stem = evidenceAttachmentStem(evidenceCase);
  await attachScreenshot(page, testInfo, stem);
  await attachReceipt(testInfo, stem, [evidenceCase]);
}

async function attachSyntheticScreenshot(page: Page, testInfo: TestInfo, label: string) {
  await attachScreenshot(page, testInfo, syntheticStem(label));
}

async function attachSyntheticReceipt(testInfo: TestInfo, label: string, cases: readonly FrontendLabEvidenceCase[]) {
  await attachReceipt(testInfo, syntheticStem(label), cases);
}

async function attachScreenshot(page: Page, testInfo: TestInfo, stem: string) {
  const name = `${stem}.png`;
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

async function attachReceipt(testInfo: TestInfo, stem: string, cases: readonly FrontendLabEvidenceCase[]) {
  const name = `${stem}.json`;
  const sourcePath = testInfo.outputPath("receipt-source.json");
  const receipt = JSON.stringify({
    version: evidencePlan.version,
    fixtureId: evidencePlan.fixtureId,
    fixtureRevision: evidencePlan.fixtureRevision,
    planRevision: evidencePlan.planRevision,
    caseIds: cases.map((entry) => entry.id),
    cases: cases.map((entry) => ({
      artifactStem: entry.artifactStem,
      colorScheme: entry.colorScheme,
      expectedIdentity: entry.expectedIdentity,
      motion: entry.motion,
      profileId: entry.profileId,
      route: entry.route,
      scenarioId: entry.scenarioId,
      taskId: entry.taskId,
      variantId: entry.variantId,
      variantRevision: entry.variantRevision,
      viewportHeight: entry.viewportHeight,
      viewportWidth: entry.viewportWidth,
      zoomPercent: entry.zoomPercent,
    })),
  }, null, 2);
  try {
    await writeFile(sourcePath, receipt, "utf8");
    await testInfo.attach(name, { path: sourcePath, contentType: "application/json" });
  } finally {
    await rm(sourcePath, { force: true });
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
