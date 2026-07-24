import { describe, expect, test } from "bun:test";

const claimHelper = await Bun.file(new URL("../site/item-claim.js", import.meta.url)).text();
const controller = await Bun.file(new URL("../site/item-complete-controller.js", import.meta.url)).text();
const helper = await Bun.file(new URL("../site/item-complete.js", import.meta.url)).text();
const styles = await Bun.file(new URL("../site/item-complete.css", import.meta.url)).text();

describe("dashboard completion integration", () => {
  test("loads as an isolated item-detail side effect", () => {
    expect(claimHelper).toContain("import './item-complete-controller.js'");
    expect(controller).toContain("if (typeof document !== 'undefined') installCompleteController()");
    expect(controller).toContain("MutationObserver");
    expect(controller).toContain("findEventSection");
    expect(controller).toContain("item-complete-section");
  });

  test("uses the exact completion REST contract", () => {
    expect(helper).toContain("action: 'complete'");
    expect(controller).toContain("encodeURIComponent(input.id)");
    expect(controller).toContain("/complete`");
    expect(controller).toContain("method: 'POST'");
    expect(controller).toContain("'idempotency-key': idempotencyKey");
    expect(controller).toContain("actor: input.actor");
    expect(controller).toContain("...(input.summary ? { summary: input.summary } : {})");
    expect(controller).not.toContain("/block`");
    expect(controller).not.toContain("/unblock`");
  });

  test("gates on session-only write context and active actor", () => {
    expect(controller).toContain("sessionStorage.getItem(ACTOR_STORAGE_KEY)");
    expect(controller).toContain("sessionStorage.getItem(TOKEN_STORAGE_KEY)");
    expect(controller).toContain("localStorage.getItem(ENDPOINT_STORAGE_KEY)");
    expect(controller).toContain("panel?.dataset.mode === 'write'");
    expect(controller).toContain("readStoredActor");
    expect(controller).not.toContain("STENSIBLY_SERVICE_SECRET");
  });

  test("preserves form and request state across refreshes and context changes", () => {
    expect(controller).toContain("let formState = freshState()");
    expect(controller).toContain("bodyObserver.disconnect()");
    expect(controller).toContain("bodyObserver.observe");
    expect(controller).toContain("contextObserver.observe");
    expect(controller).toContain("readContext().fingerprint === expectedContext");
    expect(controller).toContain("idempotency.reset()");
    expect(controller).toContain("summary: formState.summary");
  });

  test("prevents overlapping detail actions without unlocking another action", () => {
    expect(controller).toContain("refreshButton.disabled && !locks.refresh");
    expect(controller).toContain("locks.refresh = true");
    expect(controller).toContain("button.dataset.completeLocked = 'true'");
    expect(controller).toContain("button[data-complete-locked=\"true\"]");
    expect(controller).toContain("form:not(.detail-complete-form)");
  });

  test("validates the safe completion response and refreshes board plus detail", () => {
    expect(helper).toContain("status !== 'done'");
    expect(helper).toContain("item.claimedBy !== null || item.claimExpiresAt !== null");
    expect(helper).toContain("Number.isInteger(item.version)");
    expect(controller).toContain("readCompletedItem");
    expect(controller).toContain("boardRefreshButton.click()");
    expect(controller).toContain("refreshButton.click()");
  });

  test("surfaces bounded failures without raw HTML or credentials", () => {
    expect(controller).toContain("formatValidationIssues");
    expect(controller).toContain("safeRequestId");
    expect(controller).toContain("response.status === 409");
    expect(controller).toContain("Retry the unchanged form to reuse the same idempotency key");
    expect(controller).toContain("redactCredentialText");
    expect(controller).not.toContain("innerHTML");
    expect(helper).toContain("Credential-shaped values are not valid completion fields");
  });

  test("loads only completion styling and supports narrow screens", () => {
    expect(controller).toContain("/item-complete.css");
    expect(controller).not.toContain("/item-claim.css");
    expect(styles).toContain(".detail-complete-form");
    expect(styles).toContain(".detail-complete-error");
    expect(styles).toContain("@media (max-width: 560px)");
  });
});
