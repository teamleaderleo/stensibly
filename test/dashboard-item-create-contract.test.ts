import { describe, expect, test } from "bun:test";

const html = await Bun.file(new URL("../site/index.html", import.meta.url)).text();
const app = await Bun.file(new URL("../site/app.js", import.meta.url)).text();
const controller = await Bun.file(new URL("../site/item-create-controller.js", import.meta.url)).text();
const helper = await Bun.file(new URL("../site/item-create.js", import.meta.url)).text();
const session = await Bun.file(new URL("../site/session-context-controller.js", import.meta.url)).text();
const styles = await Bun.file(new URL("../site/styles.css", import.meta.url)).text();

describe("dashboard item creation integration", () => {
  test("ships the complete create form with server field limits", () => {
    expect(html).toContain('id="create-item"');
    expect(html).toContain('id="create-item-dialog"');
    expect(html).toContain('id="create-item-form"');
    expect(html).toContain('maxlength="80"');
    expect(html).toContain('maxlength="240"');
    expect(html).toContain('maxlength="10000"');
    expect(html).toContain('maxlength="2000"');
    expect(html).toContain('min="0" max="100" step="1"');
  });

  test("shows creation only when principal and actor context permit writes", () => {
    expect(app).toContain("createItemCreateController");
    expect(app).toContain("principal: sessionContext.getPrincipal()");
    expect(app).toContain("actor: sessionContext.getActor()");
    expect(session).toContain("onChange");
    expect(app).toContain("itemCreate?.sync()");
    expect(controller).toContain("principal?.capabilities.write && actor");
  });

  test("uses one idempotent server write with existing authorization", () => {
    expect(controller).toContain("/api/v1/items");
    expect(controller).toContain("method: 'POST'");
    expect(controller).toContain("authorization: `Bearer ${token}`");
    expect(controller).toContain("'idempotency-key': idempotencyKey");
    expect(controller).toContain("createIdempotencyTracker");
    expect(helper).toContain("globalThis.crypto?.randomUUID");
    expect(controller).not.toContain("STENSIBLY_SERVICE_SECRET");
    expect(controller).not.toContain("serviceSecret");
  });

  test("keeps unchanged retries safe and guards stale responses", () => {
    expect(controller).toContain("Retry the unchanged form to reuse the same idempotency key");
    expect(controller).toContain("gate.begin()");
    expect(controller).toContain("gate.isCurrent(requestId)");
    expect(controller).toContain("submitButton.disabled = true");
    expect(controller).toContain("formatValidationIssues");
    expect(controller).toContain("safeRequestId");
    expect(controller).toContain("redactCredentialText");
  });

  test("refreshes the board and opens the created server record", () => {
    expect(app).toContain("await refreshCurrent({ interactive: true })");
    expect(app).toContain("items.some((candidate) => candidate.id === item.id)");
    expect(app).toContain("button.card[data-item-id]");
    expect(app).toContain("card?.click()");
  });

  test("routes auth errors and retains the successful create result", () => {
    expect(controller).toContain("response.status === 401 || response.status === 403");
    expect(controller).toContain("reportConnectionIssue(message)");
    expect(controller).toContain("Created ${redactCredentialText(item.title)}, but the board did not refresh");
    expect(controller).not.toContain("innerHTML");
  });

  test("includes responsive create presentation", () => {
    expect(styles).toContain(".create-item-dialog");
    expect(styles).toContain(".create-item-form");
    expect(styles).toContain(".create-item-actions");
  });
});
