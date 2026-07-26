import { describe, expect, test } from "bun:test";

const claimHelper = await Bun.file(new URL("../site/item-claim.js", import.meta.url)).text();
const controller = await Bun.file(
  new URL("../site/item-semantic-generation-controller.js", import.meta.url),
).text();
const declaration = await Bun.file(
  new URL("../site/item-semantic-generation-controller.d.ts", import.meta.url),
).text();

describe("dashboard semantic generation sidecar", () => {
  test("loads before semantic action controllers and stores only bounded item generation", () => {
    const generationImport = claimHelper.indexOf("import './item-semantic-generation-controller.js'");
    expect(generationImport).toBeGreaterThanOrEqual(0);
    expect(generationImport).toBeLessThan(claimHelper.indexOf("import './item-block-controller.js'"));
    expect(generationImport).toBeLessThan(claimHelper.indexOf("import './item-complete-controller.js'"));
    expect(generationImport).toBeLessThan(claimHelper.indexOf("import './item-handoff-controller.js'"));
    expect(controller).toContain("body.dataset[ITEM_ID_DATA_KEY] = returnedItemId");
    expect(controller).toContain("body.dataset[GENERATION_DATA_KEY] = String(generation)");
    expect(controller).not.toContain("claimedBy");
    expect(controller).not.toContain("allowedOperations");
    expect(controller).not.toContain("authority");
  });

  test("fetches current detail with bounded stale-response and credential guards", () => {
    expect(controller).toContain("createRequestGate");
    expect(controller).toContain("cache: 'no-store'");
    expect(controller).toContain("signal: AbortSignal.timeout(15_000)");
    expect(controller).toContain("authorization: `Bearer ${context.token}`");
    expect(controller).toContain("returnedItemId !== expectedItemId");
    expect(controller).toContain("readContext().fingerprint === expectedContext");
    expect(controller).toContain("tokenDiscriminator(token)");
    expect(controller).toContain("Number.isInteger(generation)");
    expect(controller).toContain("generation < 0");
  });

  test("invalidates projection on item, refresh, close, and session changes", () => {
    expect(controller).toContain("board.addEventListener('click'");
    expect(controller).toContain("refreshButton.addEventListener('click'");
    expect(controller).toContain("dialog.addEventListener('close'");
    expect(controller).toContain("contextObserver.observe");
    expect(controller).toContain("gate.invalidate()");
    expect(controller).toContain("delete body.dataset[ITEM_ID_DATA_KEY]");
    expect(controller).toContain("delete body.dataset[GENERATION_DATA_KEY]");
  });

  test("exports a typed fail-closed generation reader", () => {
    expect(controller).toContain("export function readSemanticClaimGeneration");
    expect(controller).toContain("itemId !== expectedItemId");
    expect(controller).toContain("Number.isInteger(generation) && generation >= 0");
    expect(declaration).toContain("expectedItemId?: string");
    expect(declaration).toContain("number | null");
  });
});
