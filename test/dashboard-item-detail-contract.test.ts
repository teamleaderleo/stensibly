import { describe, expect, test } from "bun:test";

const html = await Bun.file(new URL("../site/index.html", import.meta.url)).text();
const app = await Bun.file(new URL("../site/app.js", import.meta.url)).text();

describe("dashboard item detail contract", () => {
  test("declares an accessible modal detail surface", () => {
    expect(html).toContain('id="item-detail-overlay"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="item-detail-title"');
    expect(html).toContain('id="item-detail-state" aria-live="polite"');
  });

  test("uses the existing item-detail REST route and stale-response gate", () => {
    expect(app).toContain('/api/v1/items/${encodeURIComponent(itemId)}');
    expect(app).toContain('detailRequests.begin()');
    expect(app).toContain('detailRequests.invalidate()');
    expect(app).toContain('detailRequests.isCurrent(requestId)');
  });

  test("supports keyboard close and focus restoration", () => {
    expect(app).toContain("event.key === 'Escape'");
    expect(app).toContain("event.key !== 'Tab'");
    expect(app).toContain("currentCard.focus({ preventScroll: true })");
  });

  test("keeps dynamic styling in classes and external links isolated", () => {
    expect(app).not.toContain('style="--status:');
    expect(app).toContain('target="_blank" rel="noreferrer noopener"');
    expect(html).not.toContain('<style');
  });
});
