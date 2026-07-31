import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { frontendLabManifest } from "../site/labs/manifest.js";

const repositoryRoot = join(import.meta.dir, "..");
const routeRoot = join(repositoryRoot, "site", "labs", "signal-atlas");
const html = readFileSync(join(routeRoot, "index.html"), "utf8");
const css = readFileSync(join(routeRoot, "styles.css"), "utf8");
const app = readFileSync(join(routeRoot, "app.js"), "utf8");
const mapFocus = readFileSync(join(routeRoot, "map-focus.js"), "utf8");
const guide = readFileSync(join(repositoryRoot, "docs", "frontend-signal-atlas.md"), "utf8");
const routeSource = `${html}\n${css}\n${app}\n${mapFocus}`;
const sourceWithoutSvgNamespace = routeSource.replaceAll("http://www.w3.org/2000/svg", "");

const sharedTargets = [
  "approve-release-note",
  "moss",
  "ember",
  "repair-focus-order",
  "deploy-amber",
  "github",
  "api",
  "mcp",
];

const chapterIds = ["decision", "workers", "recommendation", "ambiguity", "connections"];

describe("Signal Atlas frontend lab", () => {
  test("publishes one independent narrative prototype route", () => {
    const manifestEntry = frontendLabManifest.find((entry) => entry.id === "signal-atlas");
    expect(manifestEntry).toMatchObject({
      owner: "Cinder",
      status: "prototype",
      issue: 611,
      path: "./signal-atlas/",
    });
    expect(manifestEntry?.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(manifestEntry?.support).toEqual([
      "wide",
      "medium",
      "narrow",
      "light",
      "dark",
      "keyboard",
      "reduced-motion",
    ]);
    expect(html).toContain('data-stensibly-lab="prototype"');
    expect(html).toContain('<script src="./app.js"></script>');
    expect(html).toContain('<script src="./map-focus.js"></script>');
    expect(html).not.toContain("../planned.js");
    expect(html).not.toContain("../planned.css");
  });

  test("keeps every shared target available through five direct chapters", () => {
    for (const target of sharedTargets) expect(app).toContain(`"${target}"`);
    for (const chapterId of chapterIds) expect(app).toContain(`id: "${chapterId}"`);
    expect(app).toContain("The concise wording is the only human decision");
    expect(app).toContain("Lease expired 12 minutes ago");
    expect(app).toContain("Top recommendation because it unlocks keyboard evidence");
    expect(app).toContain("settlement is unknown");
    expect(app).toContain("GitHub is healthy, the API is reconnecting, and MCP is offline");
  });

  test("provides a static explanation and complete ledger outside chapter order", () => {
    expect(html).toContain('id="static-grid"');
    expect(html).toContain("Complete static explanation");
    expect(html).toContain('id="show-ledger"');
    expect(html).toContain('id="ledger"');
    expect(html).toContain('id="ledger-list"');
    expect(app).toContain("renderStaticStory()");
    expect(app).toContain("renderLedger()");
    expect(app).toContain("Complete static timeline opened");
    expect(guide).toContain("complete static explanation");
    expect(guide).toContain("chapter order is explanatory, not authoritative");
  });

  test("keeps evidence, time, source, provider health, and safe action persistent", () => {
    expect(html).toContain('id="evidence-body" tabindex="-1"');
    for (const label of ["Identity", "Kind", "Owner", "Observed", "Evidence head", "Source"]) expect(app).toContain(`["${label}"`);
    expect(app).toContain("Paper Lantern fictional fixture");
    expect(app).toContain("Safe next action");
    expect(app).toContain("Read the remote receipt and target state before accepting or retrying");
    expect(app).toContain('["GitHub", "healthy"]');
    expect(app).toContain('["API", "reconnecting"]');
    expect(app).toContain('["MCP", "offline"]');
    expect(guide).toContain("The ambiguous operation never exposes a retry action");
  });

  test("uses native navigation, direct keyboard chapters, and reduced-motion parity", () => {
    for (const key of ["ArrowRight", "ArrowLeft", "Escape"]) expect(app).toContain(`"${key}"`);
    expect(app).toContain('/^[1-5]$/.test(keyboardEvent.key)');
    expect(app).toContain('keyboardEvent.key.toLowerCase() === "l"');
    expect(app).toContain('behavior: reducedMotion ? "auto" : "smooth"');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain("scroll-behavior: auto");
    expect(routeSource).not.toMatch(/addEventListener\(["'](?:wheel|scroll)["']/);
    expect(routeSource).not.toMatch(/scroll-snap|setInterval|autoplay/i);
    expect(guide).toContain("There is no wheel interception, scroll snapping, forced autoplay, timed chapter advance, or locked progression");
  });

  test("restores focus to the replacement landscape node after a scene update", () => {
    class FakeElement {
      dataset: { recordId?: string };
      hidden: boolean;
      focused = false;
      closestResult: FakeElement | null;

      constructor(recordId?: string, hidden = false, closestResult?: FakeElement | null) {
        this.dataset = { recordId };
        this.hidden = hidden;
        this.closestResult = closestResult === undefined ? this : closestResult;
      }

      closest(selector: string) {
        return selector === "button[data-record-id]" ? this.closestResult : null;
      }

      focus() {
        this.focused = true;
      }
    }

    let nodes: FakeElement[] = [];
    let clickListener: ((event: { target: FakeElement }) => void) | null = null;
    let listenerOptions: { capture?: boolean } | undefined;
    const animationFrames: Array<() => void> = [];
    const mapNodes = {
      addEventListener(type: string, listener: typeof clickListener, options: { capture?: boolean }) {
        if (type === "click") {
          clickListener = listener;
          listenerOptions = options;
        }
      },
      contains(node: FakeElement) {
        return nodes.includes(node);
      },
      querySelectorAll(selector: string) {
        return selector === "button[data-record-id]" ? nodes : [];
      },
    };

    runInNewContext(mapFocus, {
      document: { querySelector: (selector: string) => selector === "#map-nodes" ? mapNodes : null },
      Element: FakeElement,
      requestAnimationFrame: (callback: () => void) => animationFrames.push(callback),
      Error,
    });

    expect(listenerOptions).toEqual({ capture: true });
    const registeredClickListener = clickListener as ((event: { target: FakeElement }) => void) | null;
    if (!registeredClickListener) throw new Error("Signal Atlas map listener was not registered");
    const oldNode = new FakeElement("deploy-amber");
    nodes = [oldNode];
    registeredClickListener({ target: oldNode });
    expect(animationFrames).toHaveLength(1);

    const hiddenDuplicate = new FakeElement("deploy-amber", true);
    const replacement = new FakeElement("deploy-amber");
    nodes = [hiddenDuplicate, replacement];
    animationFrames.shift()?.();
    expect(hiddenDuplicate.focused).toBe(false);
    expect(replacement.focused).toBe(true);
  });

  test("uses abstract fiction and stays flat, local, and authority-free", () => {
    expect(() => new Function(app)).not.toThrow();
    expect(() => new Function(mapFocus)).not.toThrow();
    expect(html).toContain("abstract fictional work landscape");
    expect(guide).toContain("has no relevant real-world coordinates");
    expect(guide).toContain("No real data layer is used");
    expect(routeSource).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/);
    expect(sourceWithoutSvgNamespace).not.toMatch(/https?:\/\//);
    expect(routeSource).not.toMatch(/stn\.tok_/);
    expect(routeSource).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB)\b/);
    expect(routeSource).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
    expect(css).not.toContain("url(");
    expect(css).not.toContain("@import");
    expect(html).not.toMatch(/<(?:img|iframe)\b/i);
    expect(guide).toContain("No production dashboard, authentication, API, persistence, deployment, or durable state is involved");
  });
});
