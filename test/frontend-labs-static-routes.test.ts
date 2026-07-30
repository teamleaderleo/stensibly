import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { frontendLabManifest } from "../site/labs/manifest.js";

const labsRoot = join(import.meta.dir, "..", "site", "labs");

function source(relativePath: string): string {
  return readFileSync(join(labsRoot, relativePath), "utf8");
}

function allFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? allFiles(path) : [path];
  });
}

describe("frontend labs static routes", () => {
  test("keeps the catalogue additive and outside the production root bundle", () => {
    const productionIndex = readFileSync(join(labsRoot, "..", "index.html"), "utf8");
    const productionApp = readFileSync(join(labsRoot, "..", "app.js"), "utf8");
    expect(productionIndex).not.toContain("/labs/");
    expect(productionIndex).not.toContain("labs/catalogue.js");
    expect(productionApp).not.toContain("labs/manifest.js");
    expect(productionApp).not.toContain("frontendLabManifest");
  });

  test("publishes one stable HTML route for every manifest entry", () => {
    for (const variant of frontendLabManifest) {
      const html = source(join(variant.id, "index.html"));
      expect(html).toContain("data-stensibly-lab=");
      expect(html).toContain("../");
      expect(html).not.toContain("stn.tok_");
    }
    expect(source("index.html")).toContain("data-stensibly-lab=\"catalogue\"");
  });

  test("isolates side-by-side previews without same-origin authority", () => {
    const catalogue = source("catalogue.js");
    expect(catalogue).toContain('frame.setAttribute("sandbox", "allow-scripts")');
    expect(catalogue).toContain('frame.referrerPolicy = "no-referrer"');
    expect(catalogue).not.toContain("allow-same-origin");
    expect(catalogue).not.toContain("postMessage(");
  });

  test("contains no network client, credential shape, or gradient styling", () => {
    const files = allFiles(labsRoot).filter((path) => /\.(?:html|css|js)$/.test(path));
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      expect(text).not.toMatch(/\bfetch\s*\(/);
      expect(text).not.toMatch(/\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|sendBeacon\s*\(/);
      expect(text).not.toMatch(/stn\.tok_/i);
      expect(text).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
    }
  });

  test("labels planned routes honestly and keeps Quiet Control interactive", () => {
    for (const variant of frontendLabManifest.filter((entry) => entry.status === "planned")) {
      const html = source(join(variant.id, "index.html"));
      expect(html).toContain("data-stensibly-lab=\"planned\"");
      expect(html).toContain("planned variant");
      expect(html).toContain("../planned.js");
    }

    const quietHtml = source(join("quiet-control", "index.html"));
    const quietApp = source(join("quiet-control", "app.js"));
    expect(quietHtml).toContain("data-stensibly-lab=\"prototype\"");
    expect(quietHtml).toContain("fictional fixtures");
    expect(quietApp).toContain('currentView = "attention"');
    expect(quietApp).toContain('event.key === "/"');
    expect(quietApp).not.toContain("prefers-reduced-motion");
    expect(source(join("quiet-control", "styles.css"))).toContain("prefers-reduced-motion");
  });

  test("provides narrow-screen catalogue and specimen behavior", () => {
    expect(source("styles.css")).toContain("@media (max-width: 520px)");
    expect(source(join("quiet-control", "styles.css"))).toContain("@media (max-width: 480px)");
    expect(source(join("quiet-control", "app.js"))).toContain('workspace.dataset.mobileDetail = "true"');
    expect(source(join("quiet-control", "app.js"))).toContain('workspace.dataset.mobileDetail = "false"');
  });
});
