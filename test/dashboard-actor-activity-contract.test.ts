import { describe, expect, test } from "bun:test";

const loader = await Bun.file(new URL("../site/item-claim.js", import.meta.url)).text();
const controller = await Bun.file(new URL("../site/actor-activity-controller.js", import.meta.url)).text();
const helper = await Bun.file(new URL("../site/actor-activity.js", import.meta.url)).text();
const declaration = await Bun.file(new URL("../site/actor-activity.d.ts", import.meta.url)).text();
const styles = await Bun.file(new URL("../site/actor-activity.css", import.meta.url)).text();

describe("dashboard actor activity integration", () => {
  test("loads as a read-only dashboard sidecar", () => {
    expect(loader).toContain("import './actor-activity-controller.js'");
    expect(controller).toContain("if (typeof document !== 'undefined') installActorActivityController()");
    expect(controller).not.toContain("method: 'POST'");
    expect(controller).not.toContain("Idempotency-Key");
    expect(controller).not.toContain("STENSIBLY_SERVICE_SECRET");
  });

  test("derives only current board candidates and keeps the sample bounded", () => {
    expect(controller).toContain("button.card[data-item-id]");
    expect(controller).toContain("card.dataset.itemId || ''");
    expect(controller).toContain("normalizeActivityCandidates(values)");
    expect(helper).toContain("MAX_ACTIVITY_ITEMS = 20");
    expect(helper).toContain("MAX_ACTIVITY_CONCURRENCY = 4");
    expect(helper).toContain("MAX_EVENTS_PER_ITEM = 20");
    expect(helper).toContain("MAX_ACTIVITY_EVENTS = 200");
    expect(controller).toContain("MAX_ACTIVITY_CONCURRENCY");
  });

  test("uses exact authorized no-cache item detail reads", () => {
    expect(controller).toContain("/api/v1/items/${encodeURIComponent(candidate.id)}");
    expect(controller).toContain("authorization: `Bearer ${connection.token}`");
    expect(controller).toContain("cache: 'no-store'");
    expect(controller).toContain("sessionStorage.getItem(TOKEN_STORAGE_KEY)");
    expect(controller).toContain("localStorage.getItem(ENDPOINT_STORAGE_KEY)");
  });

  test("guards stale board, project, connection, and dialog responses", () => {
    expect(controller).toContain("const requestId = gate.begin()");
    expect(controller).toContain("gate.invalidate()");
    expect(controller).toContain("requestFingerprint(connection, candidates)");
    expect(controller).toContain("gate.isCurrent(requestId)");
    expect(controller).toContain("projectFilter.addEventListener('change'");
    expect(controller).toContain("if (!connectForm.hidden && dialog.open) dialog.close()");
    expect(controller).toContain("if (dashboard.hidden && dialog.open) dialog.close()");
  });

  test("preserves cached success and reports partial failures safely", () => {
    expect(controller).toContain("currentSample?.fingerprint === fingerprint ? 'refreshing sample' : 'loading sample'");
    expect(controller).toContain("if (!currentSample || currentSample.fingerprint !== fingerprint)");
    expect(controller).toContain("failures.length");
    expect(controller).toContain("showInlineError");
    expect(controller).toContain("safeRequestId");
    expect(controller).toContain("redactCredentialText(String(message).slice(0, 1_200))");
  });

  test("renders actor claims and canonical event types without payloads", () => {
    expect(controller).toContain("Current claims · ${actor.currentClaims.length}");
    expect(controller).toContain("Recent events · ${actor.eventCount}");
    expect(controller).toContain("heading.textContent = redactCredentialText(event.type)");
    expect(controller).toContain("This is not a complete workspace audit.");
    expect(helper).not.toContain("payload:");
    expect(controller).not.toContain("event.payload");
    expect(controller).not.toContain("innerHTML");
  });

  test("uses native close behavior, focus restoration, and responsive presentation", () => {
    expect(controller).toContain("dialog.showModal()");
    expect(controller).toContain("dialog.addEventListener('close'");
    expect(controller).toContain("if (target?.isConnected) target.focus()");
    expect(declaration).toContain("interface ActivityCandidate");
    expect(controller).toContain("/actor-activity.css");
    expect(styles).toContain(".actor-activity-dialog");
    expect(styles).toContain(".actor-activity-metrics");
    expect(styles).toContain("@media (max-width: 720px)");
  });
});
