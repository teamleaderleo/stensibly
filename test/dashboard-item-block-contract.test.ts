import { describe, expect, test } from "bun:test";

const claimHelper = await Bun.file(new URL("../site/item-claim.js", import.meta.url)).text();
const controller = await Bun.file(new URL("../site/item-block-controller.js", import.meta.url)).text();
const helper = await Bun.file(new URL("../site/item-block.js", import.meta.url)).text();
const styles = await Bun.file(new URL("../site/item-block.css", import.meta.url)).text();

describe("dashboard block and unblock integration", () => {
  test("loads as an isolated item-detail sidecar", () => {
    expect(claimHelper).toContain("import './item-block-controller.js'");
    expect(controller).toContain("if (typeof document !== 'undefined') installBlockController()");
    expect(controller).toContain("MutationObserver");
    expect(controller).toContain("isSidecarOnlyMutation");
    expect(controller).toContain("item-block-transition-section");
    expect(controller).not.toContain("/complete");
  });

  test("uses the exact block and unblock REST contracts", () => {
    expect(controller).toContain("encodeURIComponent(input.id)");
    expect(controller).toContain("/${action}`");
    expect(controller).toContain("method: 'POST'");
    expect(controller).toContain("'idempotency-key': idempotencyKey");
    expect(controller).toContain("{ actor: input.actor, reason: input.reason");
    expect(controller).toContain("{ actor: input.actor, ...(input.nextAction");
    expect(helper).toContain("action: 'block'");
    expect(helper).toContain("action: 'unblock'");
  });

  test("explains destructive block effects and status-driven actions", () => {
    expect(controller).toContain("Blocking replaces the current summary with this reason");
    expect(controller).toContain("releases the current lease");
    expect(controller).toContain("Unblocking returns this item to ready");
    expect(controller).toContain("transitionForStatus(currentStatus)");
    expect(controller).toContain("readRenderedStatus(body)");
  });

  test("uses the current actor at submit time and invalidates stale requests", () => {
    expect(controller).toContain("validateBlockInput(itemId, reason?.value, nextAction.value, context.actor)");
    expect(controller).toContain("validateUnblockInput(itemId, nextAction.value, context.actor)");
    expect(controller).toContain("gate.isCurrent(requestId)");
    expect(controller).toContain("readContext().fingerprint === expectedContext");
    expect(controller).toContain("formState.mode === expectedAction");
  });

  test("preserves server success and conflict state across detail refresh races", () => {
    expect(controller).toContain("!['submitting', 'transitioned'].includes(formState.phase)");
    expect(controller).toContain("formState.phase === 'transitioned'");
    expect(controller).toContain("stateForStatusChange(currentStatus, formState)");
    expect(controller).toContain("['conflict', 'retry available'].includes(previous.phase)");
  });

  test("does not create an observer loop with progress and owns only its locks", () => {
    expect(controller).toContain("#item-progress-section, #item-block-transition-section");
    expect(controller).toContain("records.every(isSidecarOnlyMutation)");
    expect(controller).toContain("button.dataset.transitionLocked = 'true'");
    expect(controller).toContain("button[data-transition-locked=\"true\"]");
    expect(controller).toContain("refreshButton.disabled && !locks.refresh");
  });

  test("shows canonical and legacy block reasons through text-only rendering", () => {
    expect(controller).toContain("type !== 'work.blocked' && type !== 'item.blocked'");
    expect(controller).toContain("heading.textContent = 'Block reason'");
    expect(controller).toContain("copy.textContent = reason");
    expect(controller).not.toContain("innerHTML");
  });

  test("surfaces bounded errors and refreshes the server state after success", () => {
    expect(controller).toContain("formatValidationIssues");
    expect(controller).toContain("safeRequestId");
    expect(controller).toContain("response.status === 409");
    expect(controller).toContain("Retry the unchanged form to reuse the same idempotency key");
    expect(controller).toContain("refreshButton.click()");
    expect(controller).toContain("redactCredentialText");
  });

  test("loads only transition styling and supports narrow screens", () => {
    expect(controller).toContain("/item-block.css");
    expect(styles).toContain(".detail-transition-form");
    expect(styles).toContain(".detail-transition-error");
    expect(styles).toContain("@media (max-width: 560px)");
  });
});
