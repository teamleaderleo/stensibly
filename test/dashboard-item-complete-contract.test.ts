import { describe, expect, test } from "bun:test";

const claimHelper = await Bun.file(new URL("../site/item-claim.js", import.meta.url)).text();
const controller = await Bun.file(new URL("../site/item-complete-controller.js", import.meta.url)).text();
const helper = await Bun.file(new URL("../site/item-complete.js", import.meta.url)).text();
const styles = await Bun.file(new URL("../site/item-complete.css", import.meta.url)).text();
const sqliteLedger = await Bun.file(new URL("../src/sqlite-ledger.ts", import.meta.url)).text();
const tokenProvider = await Bun.file(new URL("../src/sqlite-token-provider.ts", import.meta.url)).text();
const parity = await Bun.file(new URL("../src/completion-parity.ts", import.meta.url)).text();

describe("dashboard completion integration", () => {
  test("loads as an isolated item-detail sidecar", () => {
    expect(claimHelper).toContain("import './item-complete-controller.js'");
    expect(controller).toContain("if (typeof document !== 'undefined') installCompletionController()");
    expect(controller).toContain("MutationObserver");
    expect(controller).toContain("isSidecarOnlyMutation");
    expect(controller).toContain("item-complete-section");
  });

  test("uses the exact idempotent completion request", () => {
    expect(controller).toContain("encodeURIComponent(input.id)");
    expect(controller).toContain("/complete`");
    expect(controller).toContain("method: 'POST'");
    expect(controller).toContain("'idempotency-key': idempotencyKey");
    expect(controller).toContain("{ actor: input.actor, ...(input.summary ? { summary: input.summary } : {}) }");
    expect(helper).toContain("action: 'complete'");
    expect(controller).not.toContain("/block`");
    expect(controller).not.toContain("/unblock`");
  });

  test("states terminal summary, next-action, and lease consequences before submission", () => {
    expect(controller).toContain("Completion is terminal in this dashboard workflow");
    expect(controller).toContain("releases the lease and clears the next action");
    expect(controller).toContain("Leave the summary blank to preserve the current summary");
    expect(controller).toContain("entered text replaces it");
  });

  test("uses current session context and invalidates stale responses", () => {
    expect(controller).toContain("validateCompleteInput(itemId, summary.value, context.actor)");
    expect(controller).toContain("gate.isCurrent(requestId)");
    expect(controller).toContain("readContext().fingerprint === expectedContext");
    expect(controller).toContain("contextObserver.observe");
    expect(controller).toContain("idempotency.reset()");
  });

  test("preserves typed input, success, and terminal errors across detail refresh races", () => {
    expect(controller).toContain("let formState = freshState()");
    expect(controller).toContain("!['submitting', 'completed'].includes(formState.phase)");
    expect(controller).toContain("formState.phase === 'completed'");
    expect(controller).toContain("summary: previous.summary");
    expect(controller).toContain("appendActionMessage(section, formState.message)");
    expect(controller).not.toContain("previousSummary");
  });

  test("prevents overlapping actions and unlocks only controls it owns", () => {
    expect(controller).toContain("refreshButton.disabled && !locks.refresh");
    expect(controller).toContain("button.dataset.completionLocked = 'true'");
    expect(controller).toContain("button[data-completion-locked=\"true\"]");
    expect(controller).toContain("form:not(.detail-complete-form)");
  });

  test("surfaces bounded errors and refreshes the server state after success", () => {
    expect(controller).toContain("formatValidationIssues");
    expect(controller).toContain("safeRequestId");
    expect(controller).toContain("response.status === 409");
    expect(controller).toContain("Retry the unchanged form to reuse the same idempotency key");
    expect(controller).toContain("refreshButton.click()");
    expect(controller).toContain("redactCredentialText");
    expect(controller).not.toContain("innerHTML");
  });

  test("installs one atomic parity trigger for both local backend entry points", () => {
    expect(parity).toContain("AFTER UPDATE OF status ON items");
    expect(parity).toContain("NEW.status = 'done'");
    expect(parity).toContain("UPDATE items SET next_action = NULL");
    expect(sqliteLedger).toContain("installSqliteCompletionParity(this.store)");
    expect(tokenProvider).toContain("installSqliteCompletionParity(this.store)");
  });

  test("loads only completion styling and supports narrow screens", () => {
    expect(controller).toContain("/item-complete.css");
    expect(styles).toContain(".detail-complete-form");
    expect(styles).toContain(".detail-complete-error");
    expect(styles).toContain("@media (max-width: 560px)");
  });
});
