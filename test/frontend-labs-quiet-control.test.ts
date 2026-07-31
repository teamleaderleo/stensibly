import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { frontendLabFixture, frontendLabTasks } from "../site/labs/fixtures.js";

const repositoryRoot = join(import.meta.dir, "..");
const labsRoot = join(repositoryRoot, "site", "labs");
const html = readFileSync(join(labsRoot, "quiet-control", "index.html"), "utf8");
const app = readFileSync(join(labsRoot, "quiet-control", "app.js"), "utf8");
const navFocus = readFileSync(join(labsRoot, "quiet-control", "nav-focus.js"), "utf8");
const semantics = readFileSync(join(labsRoot, "quiet-control", "semantics.css"), "utf8");
const classicFixturePath = join(labsRoot, "fixtures.classic.js");
const classicFixture = readFileSync(classicFixturePath, "utf8");
const moduleFixture = readFileSync(join(labsRoot, "fixtures.js"), "utf8");
const moduleFixtureUrl = pathToFileURL(join(labsRoot, "fixtures.js")).href;

describe("Quiet Control shared fixture and keyboard contract", () => {
  test("publishes one immutable fixture identity to modules and opaque sandbox classic scripts", () => {
    expect(StensiblyFrontendLabFixtures.frontendLabFixture).toBe(frontendLabFixture);
    expect(StensiblyFrontendLabFixtures.frontendLabTasks).toBe(frontendLabTasks);
    expect(Object.getOwnPropertyDescriptor(globalThis, "StensiblyFrontendLabFixtures")).toMatchObject({ writable: false, configurable: false, enumerable: false });
    expect(classicFixture).not.toMatch(/^\s*(?:import|export)\s/m);
  });

  test("supports both initialization orders and rejects mutable, accessor, or incompatible globals", () => {
    expect(moduleFixture).not.toMatch(/^\s*import\s/m);
    expect(moduleFixture).toContain('await import("./fixtures.classic.js")');
    expect(moduleFixture).toContain("Object.getOwnPropertyDescriptor");
    expect(moduleFixture).toContain("apiFromDescriptor");
    expect(moduleFixture).toContain("incompatible contract");

    runIsolatedFixtureCheck(`
      const module = await import(${JSON.stringify(`${moduleFixtureUrl}?module-first`)});
      const api = globalThis.StensiblyFrontendLabFixtures;
      if (!api || module.frontendLabFixture !== api.frontendLabFixture || module.frontendLabTasks !== api.frontendLabTasks) {
        throw new Error("module-first identities diverged");
      }
    `);

    runIsolatedFixtureCheck(`
      const { readFileSync } = await import("node:fs");
      (0, eval)(readFileSync(${JSON.stringify(classicFixturePath)}, "utf8"));
      const before = globalThis.StensiblyFrontendLabFixtures;
      const module = await import(${JSON.stringify(`${moduleFixtureUrl}?classic-first`)});
      if (globalThis.StensiblyFrontendLabFixtures !== before || module.frontendLabFixture !== before.frontendLabFixture) {
        throw new Error("classic-first identity changed");
      }
    `);

    runIsolatedFixtureCheck(`
      Object.defineProperty(globalThis, "StensiblyFrontendLabFixtures", {
        value: Object.freeze({}),
        writable: false,
        configurable: false,
      });
      let rejected = false;
      try {
        await import(${JSON.stringify(`${moduleFixtureUrl}?incompatible`)});
      } catch (error) {
        rejected = String(error).includes("incompatible contract");
      }
      if (!rejected) throw new Error("incompatible fixture global was accepted");
    `);

    runIsolatedFixtureCheck(`
      const fakeApi = Object.freeze({
        frontendLabFixture: Object.freeze({}),
        frontendLabTasks: Object.freeze([]),
        parseFrontendLabFixture() {},
        parseFrontendLabTasks() {},
        createFrontendLabReport() {},
      });
      Object.defineProperty(globalThis, "StensiblyFrontendLabFixtures", {
        value: fakeApi,
        writable: true,
        enumerable: false,
        configurable: false,
      });
      let rejected = false;
      try {
        await import(${JSON.stringify(`${moduleFixtureUrl}?mutable-descriptor`)});
      } catch (error) {
        rejected = String(error).includes("incompatible contract");
      }
      if (!rejected) throw new Error("mutable fixture global was accepted");
    `);

    runIsolatedFixtureCheck(`
      let getterCalls = 0;
      Object.defineProperty(globalThis, "StensiblyFrontendLabFixtures", {
        get() {
          getterCalls += 1;
          return Object.freeze({});
        },
        enumerable: false,
        configurable: false,
      });
      let rejected = false;
      try {
        await import(${JSON.stringify(`${moduleFixtureUrl}?accessor-descriptor`)});
      } catch (error) {
        rejected = String(error).includes("incompatible contract");
      }
      if (!rejected) throw new Error("accessor fixture global was accepted");
      if (getterCalls !== 0) throw new Error("fixture accessor was invoked");
    `);
  });

  test("loads the classic fixture bridge and focus repair around the interactive specimen", () => {
    expect(html.indexOf('../fixtures.classic.js')).toBeGreaterThan(0);
    expect(html.indexOf('../fixtures.classic.js')).toBeLessThan(html.indexOf('./app.js'));
    expect(html.indexOf('./app.js')).toBeLessThan(html.indexOf('./nav-focus.js'));
    expect(html).not.toContain('type="module"');
    expect(app).toContain("globalThis.StensiblyFrontendLabFixtures");
    expect(app).toContain("frontendLabFixture: fixture");
    expect(app).toContain("frontendLabTasks: tasks");
    expect(app).not.toContain("Project Lumen");
  });

  test("restores keyboard-activated nav focus after the app replaces the nav tree", () => {
    class FakeElement {
      dataset: { view?: string };
      focused = false;
      closestResult: FakeElement | null;

      constructor(view?: string, closestResult?: FakeElement | null) {
        this.dataset = { view };
        this.closestResult = closestResult === undefined ? this : closestResult;
      }

      closest(selector: string) {
        return selector === "button[data-view]" ? this.closestResult : null;
      }

      focus() {
        this.focused = true;
      }
    }

    let buttons: FakeElement[] = [];
    let clickListener: ((event: { detail: number; target: FakeElement }) => void) | null = null;
    let listenerOptions: { capture?: boolean } | undefined;
    const animationFrames: Array<() => void> = [];
    const navList = {
      addEventListener(type: string, listener: typeof clickListener, options: { capture?: boolean }) {
        if (type === "click") {
          clickListener = listener;
          listenerOptions = options;
        }
      },
      contains(node: FakeElement) {
        return buttons.includes(node);
      },
      querySelectorAll(selector: string) {
        return selector === "button[data-view]" ? buttons : [];
      },
    };

    runInNewContext(navFocus, {
      document: { querySelector: (selector: string) => selector === "#nav-list" ? navList : null },
      Element: FakeElement,
      requestAnimationFrame: (callback: () => void) => animationFrames.push(callback),
      Error,
    });

    expect(listenerOptions).toEqual({ capture: true });
    expect(clickListener).not.toBeNull();

    const oldButton = new FakeElement("active");
    buttons = [oldButton];
    clickListener?.({ detail: 0, target: oldButton });
    expect(animationFrames).toHaveLength(1);

    const replacementButton = new FakeElement("active");
    buttons = [replacementButton];
    animationFrames.shift()?.();
    expect(replacementButton.focused).toBe(true);

    replacementButton.focused = false;
    clickListener?.({ detail: 1, target: replacementButton });
    expect(animationFrames).toHaveLength(0);
    expect(replacementButton.focused).toBe(false);
  });

  test("makes every shared task reachable through deterministic record or connection identities", () => {
    for (const task of frontendLabTasks) {
      for (const identity of task.success.split(",")) {
        const appearsInRecords = [
          frontendLabFixture.decision.id,
          ...frontendLabFixture.workers.map((entry) => entry.id),
          ...frontendLabFixture.readyWork.map((entry) => entry.id),
          ...frontendLabFixture.operations.map((entry) => entry.id),
          ...frontendLabFixture.connections.map((entry) => entry.id),
        ].includes(identity);
        expect(appearsInRecords).toBe(true);
      }
    }
    expect(app).toContain("...tasks.map");
    expect(app).toContain("findRowLocation");
    expect(html).toContain('id="connection-health" tabindex="0"');
  });

  test("closes command-loop focus gaps and keeps filters recoverable", () => {
    expect(app).toContain("if (dialog.open)");
    expect(app).toContain("commandReturnFocus");
    expect(app).toContain("requestAnimationFrame(option.run)");
    expect(app).toContain('event.key === "ArrowDown"');
    expect(app).toContain('event.key === "ArrowUp"');
    expect(app).toContain("event.stopPropagation()");
    expect(app).toContain('currentFilter = "all"');
    expect(app).toContain("No matching item");
    expect(html).toContain('data-filter="unhealthy"');
  });

  test("uses valid current-item semantics and a visible empty-state treatment", () => {
    expect(app).toContain('setAttribute("aria-current"');
    expect(app).not.toContain('setAttribute("aria-selected"');
    expect(html).toContain('./semantics.css');
    expect(semantics).toContain('.work-list button[aria-current="true"]');
    expect(semantics).toContain('.empty-state');
  });
});

function runIsolatedFixtureCheck(body: string) {
  const script = `(async () => {${body}})().catch((error) => { console.error(error); process.exit(1); });`;
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--eval", script],
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new TextDecoder().decode(result.stderr);
  expect(result.exitCode, stderr).toBe(0);
}
