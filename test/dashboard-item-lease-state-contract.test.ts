import { describe, expect, test } from "bun:test";

const claimHelper = await Bun.file(new URL("../site/item-claim.js", import.meta.url)).text();
const controller = await Bun.file(new URL("../site/item-lease-state-controller.js", import.meta.url)).text();
const helper = await Bun.file(new URL("../site/item-lease-state.js", import.meta.url)).text();
const styles = await Bun.file(new URL("../site/item-lease-state.css", import.meta.url)).text();

describe("dashboard lease edge-state integration", () => {
  test("loads as an isolated item-detail side effect", () => {
    expect(claimHelper).toContain("import './item-lease-state-controller.js'");
    expect(controller).toContain("if (typeof document !== 'undefined') installLeaseStateController()");
    expect(controller).toContain("MutationObserver");
    expect(controller).toContain("setInterval");
    expect(controller).toContain("item-lease-state");
  });

  test("renders all lease classifications from server-owned fields", () => {
    expect(helper).toContain("'none'");
    expect(helper).toContain("'healthy'");
    expect(helper).toContain("'expiring'");
    expect(helper).toContain("'expired'");
    expect(helper).toContain("'invalid'");
    expect(controller).toContain("readRenderedItem");
    expect(controller).toContain("classifyLease(item)");
    expect(controller).toContain("describeLease(item, actor)");
  });

  test("refreshes conflicts while preserving the form and same action key", () => {
    expect(controller).toContain("state !== 'conflict'");
    expect(controller).toContain("values[field.name] = field.value");
    expect(controller).toContain("field.value = conflict.values[field.name]");
    expect(controller).toContain("conflict.refreshed = true");
    expect(controller).toContain("refreshButton.click()");
    expect(controller).toContain("error.textContent = conflict.message");
    expect(controller).toContain("state.textContent = 'conflict'");
    expect(controller).not.toContain("idempotency.reset");
  });

  test("clears retry context on item, actor, input, or status changes", () => {
    expect(controller).toContain("itemId = nextItemId");
    expect(controller).toContain("contextFingerprint = next");
    expect(controller).toContain("form.addEventListener('input'");
    expect(controller).toContain("conflict.status !== item.status");
    expect(controller).toContain("conflict = null");
  });

  test("distinguishes read-only, actorless, and status-specific empty states", () => {
    expect(helper).toContain("This token is read-only");
    expect(helper).toContain("Choose an active session actor");
    expect(helper).toContain("Unblock it before claiming");
    expect(helper).toContain("already complete");
    expect(controller).toContain("polishEmptyStates");
  });

  test("keeps credentials session-only and renders text safely", () => {
    expect(controller).toContain("sessionStorage.getItem(ACTOR_STORAGE_KEY)");
    expect(controller).toContain("sessionStorage.getItem(TOKEN_STORAGE_KEY)");
    expect(controller).toContain("localStorage.getItem(ENDPOINT_STORAGE_KEY)");
    expect(controller).toContain("redactCredentialText");
    expect(controller).not.toContain("innerHTML");
    expect(controller).not.toContain("STENSIBLY_SERVICE_SECRET");
  });

  test("loads responsive urgency styling", () => {
    expect(controller).toContain("/item-lease-state.css");
    expect(styles).toContain("data-lease-state=\"healthy\"");
    expect(styles).toContain("data-lease-state=\"expiring\"");
    expect(styles).toContain("data-lease-state=\"expired\"");
    expect(styles).toContain("@media (max-width: 560px)");
  });
});
