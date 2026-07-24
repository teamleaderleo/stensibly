import { describe, expect, test } from "bun:test";

const claimHelper = await Bun.file(new URL("../site/item-claim.js", import.meta.url)).text();
const controller = await Bun.file(new URL("../site/item-progress-controller.js", import.meta.url)).text();
const helper = await Bun.file(new URL("../site/item-progress.js", import.meta.url)).text();
const styles = await Bun.file(new URL("../site/item-progress.css", import.meta.url)).text();

describe("dashboard progress integration", () => {
  test("loads as an isolated side effect without changing the dashboard app", () => {
    expect(claimHelper).toContain("import './item-progress-controller.js'");
    expect(controller).toContain("if (typeof document !== 'undefined') installProgressController()");
    expect(controller).toContain("MutationObserver");
    expect(controller).toContain("findEventSection");
    expect(controller).toContain("item-progress-section");
  });

  test("uses the exact append-only REST event contract", () => {
    expect(helper).toContain("'item.progress'");
    expect(controller).toContain("encodeURIComponent(input.id)");
    expect(controller).toContain("/events`");
    expect(controller).toContain("method: 'POST'");
    expect(controller).toContain("'idempotency-key': idempotencyKey");
    expect(controller).toContain("body: JSON.stringify({ actor: input.actor, type: input.type, payload: input.payload })");
    expect(controller).not.toContain("/block");
    expect(controller).not.toContain("/unblock");
    expect(controller).not.toContain("/complete");
  });

  test("gates on session-only write context and active actor", () => {
    expect(controller).toContain("sessionStorage.getItem(ACTOR_STORAGE_KEY)");
    expect(controller).toContain("sessionStorage.getItem(TOKEN_STORAGE_KEY)");
    expect(controller).toContain("localStorage.getItem(ENDPOINT_STORAGE_KEY)");
    expect(controller).toContain("panel?.dataset.mode === 'write'");
    expect(controller).toContain("readStoredActor");
    expect(controller).not.toContain("STENSIBLY_SERVICE_SECRET");
  });

  test("preserves form and request state across detail refreshes and actor changes", () => {
    expect(controller).toContain("let formState = freshState()");
    expect(controller).toContain("bodyObserver.disconnect()");
    expect(controller).toContain("bodyObserver.observe");
    expect(controller).toContain("contextObserver.observe");
    expect(controller).toContain("gate.invalidate()");
    expect(controller).toContain("readContext().fingerprint === expectedContext");
    expect(controller).toContain("idempotency.reset()");
  });

  test("prevents overlapping detail actions without unlocking someone else's action", () => {
    expect(controller).toContain("refreshButton.disabled && !locks.refresh");
    expect(controller).toContain("locks.refresh = true");
    expect(controller).toContain("button.dataset.progressLocked = 'true'");
    expect(controller).toContain("button[data-progress-locked=\"true\"]");
  });

  test("surfaces bounded errors and refreshes history after success", () => {
    expect(controller).toContain("formatValidationIssues");
    expect(controller).toContain("safeRequestId");
    expect(controller).toContain("response.status === 409");
    expect(controller).toContain("Retry the unchanged form to reuse the same idempotency key");
    expect(controller).toContain("refreshButton.click()");
    expect(controller).toContain("redactCredentialText");
    expect(controller).not.toContain("innerHTML");
  });

  test("loads progress styling and supports narrow screens", () => {
    expect(controller).toContain("/item-progress.css");
    expect(styles).toContain(".detail-progress-form");
    expect(styles).toContain(".detail-progress-error");
    expect(styles).toContain("@media (max-width: 560px)");
  });
});
