import { describe, expect, test } from "bun:test";

const index = await Bun.file(new URL("../site/index.html", import.meta.url)).text();
const app = await Bun.file(new URL("../site/app.js", import.meta.url)).text();
const controller = await Bun.file(new URL("../site/item-detail-controller.js", import.meta.url)).text();
const activityThread = await Bun.file(new URL("../site/item-activity-thread.js", import.meta.url)).text();
const helper = await Bun.file(new URL("../site/item-claim.js", import.meta.url)).text();
const declaration = await Bun.file(new URL("../site/item-detail-controller.d.ts", import.meta.url)).text();
const claimStyles = await Bun.file(new URL("../site/item-claim.css", import.meta.url)).text();

describe("dashboard claim integration", () => {
  test("gates claim controls on write authority, actor, and item status", () => {
    expect(controller).toContain("principal?.capabilities.write || !actor");
    expect(controller).toContain("['ready', 'active'].includes(item.status)");
    expect(controller).toContain("item.claimedBy === actor.id ? 'extend lease' : 'claim item'");
    expect(controller).toContain("input.min = '30'");
    expect(controller).toContain("input.max = '86400'");
    expect(controller).toContain("input.value = '1800'");
  });

  test("uses one encoded idempotent claim request", () => {
    expect(controller).toContain("encodeURIComponent(claim.id)");
    expect(controller).toContain("/claim`");
    expect(controller).toContain("method: 'POST'");
    expect(controller).toContain("authorization: `Bearer ${token}`");
    expect(controller).toContain("'idempotency-key': idempotencyKey");
    expect(controller).toContain("body: JSON.stringify({ actor: claim.actor, leaseSeconds: claim.leaseSeconds })");
    expect(helper).toContain("createIdempotencyTracker");
    expect(controller).not.toContain("serviceSecret");
    expect(controller).not.toContain("STENSIBLY_SERVICE_SECRET");
  });

  test("uses an independent generation and pauses detail refresh while claiming", () => {
    expect(controller).toContain("const claimGate = createRequestGate()");
    expect(controller).toContain("claimGate.isCurrent(requestId)");
    expect(controller).toContain("claimInFlight");
    expect(controller).toContain("if (!selectedItemId || !dialog.open || claimInFlight) return");
    expect(controller).toContain("refreshButton.disabled = true");
    expect(controller).toContain("if (submitButton.disabled || claimInFlight) return");
  });

  test("surfaces validation, conflicts, auth failures, request IDs, and safe retries", () => {
    expect(controller).toContain("formatValidationIssues");
    expect(controller).toContain("safeRequestId");
    expect(controller).toContain("response.status === 409");
    expect(controller).toContain("Refresh detail to inspect the current holder and lease");
    expect(controller).toContain("response.status === 401 || response.status === 403");
    expect(controller).toContain("reportConnectionIssue(message)");
    expect(controller).toContain("Retry the unchanged lease to reuse the same idempotency key");
    expect(controller).toContain("redactCredentialText");
  });

  test("refreshes board and event history after success and reacts to actor changes", () => {
    expect(controller).toContain("await onChanged(claimed.id)");
    expect(app).toContain("onChanged: async () =>");
    expect(app).toContain("await refreshCurrent()");
    expect(app).toContain("itemDetail?.syncContext()");
    expect(declaration).toContain("syncContext(): void");
  });

  test("preserves existing item-detail privacy guards", () => {
    expect(controller).toContain("subtitle.textContent = redactCredentialText(itemId)");
    expect(activityThread).toContain("actor · ${entry.actorId}");
    expect(controller).toContain("error.textContent = redactCredentialText(message)");
    expect(controller).toContain("Number.isNaN(date.getTime()) ? redactCredentialText(value)");
    expect(controller).not.toContain("innerHTML");
    expect(activityThread).not.toContain("innerHTML");
  });

  test("loads responsive claim presentation", () => {
    expect(index).toContain('<link rel="stylesheet" href="/item-claim.css" />');
    expect(claimStyles).toContain(".detail-claim-summary");
    expect(claimStyles).toContain(".detail-claim-form");
    expect(claimStyles).toContain(".detail-claim-actions");
    expect(claimStyles).toContain(".detail-claim-error");
    expect(claimStyles).toContain("@media (max-width: 560px)");
  });
});
