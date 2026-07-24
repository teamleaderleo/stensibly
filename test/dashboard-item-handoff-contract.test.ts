import { describe, expect, test } from "bun:test";

const claimHelper = await Bun.file(new URL("../site/item-claim.js", import.meta.url)).text();
const controller = await Bun.file(new URL("../site/item-handoff-controller.js", import.meta.url)).text();
const historyController = await Bun.file(new URL("../site/item-handoff-history-controller.js", import.meta.url)).text();
const helper = await Bun.file(new URL("../site/item-handoff.js", import.meta.url)).text();
const declaration = await Bun.file(new URL("../site/item-handoff.d.ts", import.meta.url)).text();
const styles = await Bun.file(new URL("../site/item-handoff.css", import.meta.url)).text();

describe("dashboard handoff integration", () => {
  test("loads the action and readable history as isolated side effects", () => {
    expect(claimHelper).toContain("import './item-handoff-controller.js'");
    expect(claimHelper).toContain("import './item-handoff-history-controller.js'");
    expect(controller).toContain("if (typeof document !== 'undefined') installHandoffController()");
    expect(historyController).toContain("if (typeof document !== 'undefined') installHandoffHistoryController()");
    expect(historyController).toContain("work.handed_off");
    expect(historyController).toContain("handoffEventLabel");
  });

  test("uses the exact idempotent REST handoff contract", () => {
    expect(controller).toContain("/api/v1/items/${encodeURIComponent(input.id)}/handoff");
    expect(controller).toContain("method: 'POST'");
    expect(controller).toContain("'idempotency-key': idempotencyKey");
    expect(controller).toContain("actor: input.actor");
    expect(controller).toContain("summary: input.summary");
    expect(controller).toContain("nextAction: input.nextAction");
    expect(controller).toContain("...(input.toActorId ? { toActorId: input.toActorId } : {})");
    expect(controller).not.toContain("/complete");
    expect(controller).not.toContain("/claim");
  });

  test("explains server-owned consequences and target semantics", () => {
    expect(controller).toContain("replaces the current summary and next action");
    expect(controller).toContain("returns the item to ready");
    expect(controller).toContain("releases any lease");
    expect(controller).toContain("routing context only; it does not claim the item");
    expect(helper).toContain("status !== 'ready'");
    expect(helper).toContain("item.claimedBy !== null || item.claimExpiresAt !== null");
  });

  test("gates on session-only write context and current actor", () => {
    expect(controller).toContain("sessionStorage.getItem(ACTOR_STORAGE_KEY)");
    expect(controller).toContain("sessionStorage.getItem(TOKEN_STORAGE_KEY)");
    expect(controller).toContain("localStorage.getItem(ENDPOINT_STORAGE_KEY)");
    expect(controller).toContain("panel?.dataset.mode === 'write'");
    expect(controller).toContain("validateHandoffInput(itemId, summary.value, nextAction.value, toActorId.value, context.actor)");
    expect(controller).not.toContain("STENSIBLY_SERVICE_SECRET");
  });

  test("preserves values, conflicts, and success state across detail polling", () => {
    expect(controller).toContain("!['submitting', 'handed-off'].includes(formState.phase)");
    expect(controller).toContain("nextStatus === currentStatus && formState.phase === 'handed-off'");
    expect(controller).toContain("stateForStatusChange(currentStatus, formState)");
    expect(controller).toContain("['conflict', 'retry available'].includes(previous.phase)");
    expect(controller).toContain("appendStoredError(section)");
    expect(controller).toContain("gate.invalidate()");
    expect(controller).toContain("idempotency.reset()");
  });

  test("locks other actions without unlocking controls owned elsewhere", () => {
    expect(controller).toContain("refreshButton.disabled && !locks.refresh");
    expect(controller).toContain("form:not(.detail-handoff-form) button[type=\"submit\"]");
    expect(controller).toContain("button.dataset.handoffLocked = 'true'");
    expect(controller).toContain("button[data-handoff-locked=\"true\"]");
  });

  test("surfaces bounded errors and refreshes board, detail, and history after success", () => {
    expect(controller).toContain("formatValidationIssues");
    expect(controller).toContain("safeRequestId");
    expect(controller).toContain("response.status === 409");
    expect(controller).toContain("Retry the unchanged form to reuse the same idempotency key");
    expect(controller).toContain("boardRefreshButton.click()");
    expect(controller).toContain("refreshButton.click()");
    expect(controller).toContain("redactCredentialText");
    expect(controller).not.toContain("innerHTML");
  });

  test("keeps the type and responsive presentation contracts in sync", () => {
    expect(declaration).toContain("action: 'handoff'");
    expect(declaration).toContain("toActorId?: string");
    expect(controller).toContain("/item-handoff.css");
    expect(styles).toContain(".detail-handoff-form");
    expect(styles).toContain(".detail-handoff-error");
    expect(styles).toContain("@media (max-width: 560px)");
  });
});
