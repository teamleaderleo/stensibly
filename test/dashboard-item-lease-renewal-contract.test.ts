import { describe, expect, test } from "bun:test";

const claim = await Bun.file(new URL("../site/item-claim.js", import.meta.url)).text();
const renewal = await Bun.file(new URL("../site/item-lease-renewal.js", import.meta.url)).text();
const controller = await Bun.file(new URL("../site/item-lease-renewal-controller.js", import.meta.url)).text();
const styles = await Bun.file(new URL("../site/item-claim.css", import.meta.url)).text();


describe("dashboard holder-only lease renewal integration", () => {
  test("loads a dedicated controller and keeps acquisition separate", () => {
    expect(claim).toContain("import './item-lease-renewal-controller.js'");
    expect(controller).toContain("heading.textContent = 'Lease renewal'");
    expect(controller).toContain("submit.textContent = 'renew lease'");
    expect(controller).toContain("submit.textContent = 'claim item'");
    expect(controller).toContain("form.hidden = true");
    expect(controller).toContain("server-owned claim already exists");
    expect(controller).toContain("/renew`");
    expect(controller).not.toContain("/claim`");
  });

  test("consumes canonical server authority without reconstructing renewal permission from item fields", () => {
    expect(controller).toContain("readRenewalAuthority(payload, requestedItemId)");
    expect(renewal).toContain("payload.control.authority");
    expect(renewal).toContain("allowedOperations.includes(LEASE_RENEW_OPERATION)");
    expect(renewal).toContain("holderActorId !== actor.id");
    expect(controller).not.toContain("claimExpiresAt: fields");
    expect(controller).not.toContain("claimedBy: fields");
  });

  test("sends the exact expected claim generation and validates advancement", () => {
    expect(controller).toContain("expectedClaimGeneration: renewal.expectedClaimGeneration");
    expect(controller).toContain("authority.generation");
    expect(renewal).toContain("expectedClaimGeneration: generation");
    expect(renewal).toContain("claimGeneration <= expectedPreviousGeneration");
  });

  test("uses independent request generations, idempotency, and in-flight guards", () => {
    expect(controller).toContain("const detailGate = createRequestGate()");
    expect(controller).toContain("const renewalGate = createRequestGate()");
    expect(controller).toContain("const idempotency = createLeaseRenewalIdempotencyTracker()");
    expect(controller).toContain("if (submitButton.disabled || renewalInFlight) return");
    expect(controller).toContain("Retry the unchanged duration and generation to reuse the same idempotency key");
    expect(controller).toContain("renewalGate.isCurrent(requestId)");
  });

  test("handles conflicts, refresh guidance, redaction, and accessible errors", () => {
    expect(controller).toContain("response.status === 409");
    expect(controller).toContain("The claim generation changed. Refresh detail");
    expect(controller).toContain("safeRequestId");
    expect(controller).toContain("redactCredentialText");
    expect(controller).toContain("error.setAttribute('role', 'alert')");
    expect(controller).not.toContain("innerHTML");
    expect(controller).not.toContain("serviceSecret");
  });
});

describe("dashboard lease renewal presentation", () => {
  test("keeps the renewal form responsive and visibly distinct", () => {
    expect(styles).toContain(".detail-renewal-section");
    expect(styles).toContain(".detail-renewal-form");
    expect(styles).toContain(".detail-renewal-actions");
    expect(styles).toContain(".detail-renewal-error");
    expect(styles).toContain("@media (max-width: 560px)");
  });
});
