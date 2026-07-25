import { describe, expect, test } from "bun:test";

const html = await Bun.file(new URL("../site/index.html", import.meta.url)).text();
const app = await Bun.file(new URL("../site/app.js", import.meta.url)).text();
const controller = await Bun.file(new URL("../site/item-detail-controller.js", import.meta.url)).text();
const reservations = await Bun.file(new URL("../site/item-reservations.js", import.meta.url)).text();
const styles = await Bun.file(new URL("../site/styles.css", import.meta.url)).text();

describe("dashboard item detail integration", () => {
  test("ships dialog markup and accessible board-card controls together", () => {
    expect(html).toContain('id="item-detail-dialog"');
    expect(html).toContain('id="item-detail-title"');
    expect(html).toContain('id="item-detail-error"');
    expect(html).toContain('id="item-detail-announcer"');
    expect(app).toContain("createItemDetailController");
    expect(app).toContain('type="button" data-item-id=');
    expect(app).toContain("itemDetail.reconcile()");
    expect(app).toContain("itemDetail.reset");
  });

  test("renders server content with DOM text APIs and guarded links", () => {
    expect(controller).toContain("document.createElement");
    expect(controller).toContain("textContent");
    expect(controller).toContain("safeArtifactHref");
    expect(controller).toContain("noreferrer noopener");
    expect(reservations).toContain("document.createElement");
    expect(reservations).toContain("textContent");
    expect(controller).not.toContain("innerHTML");
    expect(reservations).not.toContain("innerHTML");
  });

  test("renders dependency links and unresolved blockers from item detail", () => {
    expect(controller).toContain("dependencySection(detail.dependencies)");
    expect(controller).toContain("dependencyBlocksCurrent");
    expect(controller).toContain("dependencyRelationship");
    expect(controller).toContain("unresolved");
    expect(styles).toContain(".detail-dependencies");
    expect(styles).toContain(".detail-dependency-blocking");
  });

  test("renders item reservations with aggregate capacity and expiry", () => {
    expect(controller).toContain("reservationSection(detail.reservations)");
    expect(controller).toContain("from './item-reservations.js'");
    expect(reservations).toContain("reservationCapacityLabel");
    expect(reservations).toContain("this item reserves");
    expect(reservations).toContain("no remaining capacity");
    expect(reservations).toContain("expires");
    expect(styles).toContain(".detail-reservations");
    expect(styles).toContain(".detail-reservation-full");
  });

  test("guards stale responses and supports close, retry, and focus restoration", () => {
    expect(controller).toContain("createRequestGate");
    expect(controller).toContain("gate.isCurrent");
    expect(controller).toContain("dialog.addEventListener('cancel'");
    expect(controller).toContain("refreshButton.addEventListener");
    expect(controller).toContain("?.focus()");
  });

  test("includes desktop and mobile dialog presentation", () => {
    expect(styles).toContain(".item-detail-dialog");
    expect(styles).toContain(".item-detail-dialog::backdrop");
    expect(styles).toContain("height: 100%");
    expect(styles).toContain("overscroll-behavior: contain");
  });
});
