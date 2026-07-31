import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { frontendLabManifest } from "../site/labs/manifest.js";

const routeRoot = join(import.meta.dir, "..", "site", "labs", "field-console");
const html = readFileSync(join(routeRoot, "index.html"), "utf8");

describe("Field Console selected-detail truth", () => {
  test("keeps authority and persistence visible through every dynamic detail render", () => {
    const detailHeader = html.indexOf('id="detail-region-title"');
    const truthNote = html.indexOf('class="boundary detail-truth" role="note"');
    const dynamicBody = html.indexOf('id="detail-body"');

    expect(detailHeader).toBeGreaterThan(-1);
    expect(truthNote).toBeGreaterThan(detailHeader);
    expect(dynamicBody).toBeGreaterThan(truthNote);
    expect(html).toContain("Authority:</strong> Fixture guidance only.");
    expect(html).toContain("Persistence:</strong> Page instance only; nothing saved.");
    expect(html).toContain("relationships, authority, persistence, and safe next action");
  });

  test("pins the exact detail-truth implementation while preserving merged catalogue rows", () => {
    expect(frontendLabManifest.slice(0, 4).map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "quiet-control", status: "prototype" },
      { id: "soft-companion", status: "prototype" },
      { id: "field-console", status: "prototype" },
      { id: "signal-atlas", status: "prototype" },
    ]);
    expect(frontendLabManifest.find((entry) => entry.id === "field-console")?.revision)
      .toBe("c40ae91146d87401fabffac48f292a84e23b0eeb");
  });
});
