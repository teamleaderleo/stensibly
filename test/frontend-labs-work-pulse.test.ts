import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import {
  frontendLabManifest,
  frontendLabVariantById,
} from "../site/labs/manifest.js";
import {
  workPulseFixture,
  workPulseFixtureTasks,
} from "../site/labs/work-pulse-fixtures.js";

const repositoryRoot = join(import.meta.dir, "..");
const labsRoot = join(repositoryRoot, "site", "labs");
const routeRoot = join(labsRoot, "work-pulse");
const html = readFileSync(join(routeRoot, "index.html"), "utf8");
const app = readFileSync(join(routeRoot, "app.js"), "utf8");
const classicFixture = readFileSync(join(labsRoot, "work-pulse-fixtures.classic.js"), "utf8");
const css = [
  readFileSync(join(routeRoot, "styles.css"), "utf8"),
  readFileSync(join(routeRoot, "attempts.css"), "utf8"),
].join("\n");

const admittedAttemptStates = [
  "queued",
  "reserved",
  "starting",
  "running",
  "verifying",
  "waiting_external",
  "stalled",
  "cancelling",
  "cancelled",
  "blocked",
  "succeeded",
  "failed",
] as const;

describe("Work Pulse frontend lab", () => {
  test("registers one exact fixture-only operator route", () => {
    const variant = frontendLabVariantById(frontendLabManifest, "work-pulse");

    expect(variant).toEqual({
      id: "work-pulse",
      title: "Work Pulse",
      thesis: "A text-first evidence pulse for active responsibility, stale authority, ambiguous effects, and human attention.",
      owner: "Plover",
      status: "prototype",
      revision: "de2c9aed8b9d1d7c5d5eab0d7ea50193f40c32f3",
      issue: 699,
      path: "./work-pulse/",
      support: [
        "wide",
        "medium",
        "narrow",
        "light",
        "dark",
        "keyboard",
        "reduced-motion",
        "empty",
        "degraded",
      ],
    });
  });

  test("uses the dedicated admitted attempt and authority fixture", () => {
    expect(workPulseFixture.attempts).toHaveLength(8);
    expect(workPulseFixture.attention).toHaveLength(5);
    expect(workPulseFixture.relations).toHaveLength(7);
    expect(workPulseFixture.events).toHaveLength(7);
    expect(workPulseFixture.briefs).toHaveLength(3);
    expect(new Set(workPulseFixture.briefs.map((brief) => brief.attemptId)).size).toBe(3);
    for (const brief of workPulseFixture.briefs) {
      expect(brief.grantsAuthority).toBe(false);
      expect(brief.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    }
    expect(workPulseFixture.views.map((view) => view.id)).toEqual([
      "list",
      "lanes",
      "attention",
      "polar",
      "timeline",
    ]);
    expect(workPulseFixtureTasks).toHaveLength(10);
    expect(workPulseFixture.attempts.some((attempt) =>
      attempt.state === "stalled"
      && attempt.authorityGeneration === 7
      && attempt.polar.freshnessRing === "stale"
    )).toBe(true);
  });

  test("publishes an immutable classic bridge identical to the module fixture", () => {
    const sandbox: Record<string, unknown> = {};
    runInNewContext(classicFixture, sandbox);
    const descriptor = Object.getOwnPropertyDescriptor(
      sandbox,
      "StensiblyWorkPulseFixtures",
    );
    expect(descriptor).toMatchObject({
      writable: false,
      enumerable: false,
      configurable: false,
    });
    if (!descriptor || !("value" in descriptor)) {
      throw new Error("Classic Work Pulse bridge did not publish its API");
    }
    const api = descriptor.value as {
      workPulseFixture: unknown;
      workPulseFixtureTasks: unknown;
      parseWorkPulseFixture(value: unknown): unknown;
      parseWorkPulseFixtureTasks(value: unknown): unknown;
    };
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.workPulseFixture)).toBe(true);
    expect(Object.isFrozen(api.workPulseFixtureTasks)).toBe(true);
    expect(JSON.stringify(api.workPulseFixture)).toBe(JSON.stringify(workPulseFixture));
    expect(JSON.stringify(api.workPulseFixtureTasks)).toBe(JSON.stringify(workPulseFixtureTasks));
    expect(JSON.stringify(api.parseWorkPulseFixture(api.workPulseFixture))).toBe(
      JSON.stringify(workPulseFixture),
    );
    expect(JSON.stringify(
      api.parseWorkPulseFixtureTasks(api.workPulseFixtureTasks),
    )).toBe(JSON.stringify(workPulseFixtureTasks));
    expect(classicFixture).not.toMatch(/^\s*(?:import|export)\s/mu);
  });

  test("rejects an incompatible pre-existing classic bridge without replacing it", () => {
    const existing = Object.freeze({ incompatible: true });
    const sandbox: Record<string, unknown> = {
      StensiblyWorkPulseFixtures: existing,
    };

    expect(() => runInNewContext(classicFixture, sandbox)).toThrow(
      "StensiblyWorkPulseFixtures is already defined with an incompatible contract",
    );
    expect(sandbox.StensiblyWorkPulseFixtures).toBe(existing);
  });

  test("loads the sandbox-safe fixture bridge before the renderer", () => {
    const fixtureIndex = html.indexOf('../work-pulse-fixtures.classic.js');
    const appIndex = html.indexOf('./app.js');
    expect(fixtureIndex).toBeGreaterThan(0);
    expect(appIndex).toBeGreaterThan(fixtureIndex);
    expect(html).not.toContain('type="module"');
    expect(html).toContain('<body data-stensibly-lab="prototype" data-scenario="default">');
    expect(html).toContain('href="./attempts.css"');
    expect(html).toContain('href="#attention"');
    expect(html).toContain('data-scenario-link="default"');
    expect(html).toContain('data-scenario-link="degraded"');
    expect(html).toContain('data-scenario-link="empty"');
  });

  test("renders literal attempt, authority, relation, evidence, and recovery concepts", () => {
    expect(app).toContain('const globalName = "StensiblyWorkPulseFixtures"');
    expect(app).toContain("Object.getOwnPropertyDescriptor(globalThis, globalName)");
    expect(app).toContain('Object.getOwnPropertyDescriptor(api, "parseWorkPulseFixture")');
    expect(app).toContain("Reflect.apply(");
    expect(app).toContain('"Observed execution evidence"');
    expect(app).toContain('"Attempt roster"');
    expect(app).toContain("authority generation ${attempt.authorityGeneration}");
    expect(app).toContain('fact("Run", attempt.runId)');
    expect(app).toContain('fact("Authority", `generation ${attempt.authorityGeneration}`)');
    expect(app).toContain('"Declared work lanes"');
    expect(app).toContain('"Evidence scrubber"');
    expect(app).toContain('"Attention ledger"');
    expect(app).toContain('"No proximity guesses: every connection has a closed relation kind and an evidence record."');
    expect(app).toContain("codeUnitCompare(right.at, left.at)");
    expect(app).toContain('document.body.setAttribute("data-scenario", activeScenario)');
    expect(app).toContain('return `${formatted} UTC`;');
    expect(app).not.toContain('"Current execution evidence"');
  });

  test("renders compiled worker-brief identity without granting authority", () => {
    expect(app).toContain('"Worker briefs"');
    expect(app).toContain('workerBriefs(fixture, attemptsById)');
    expect(app).toContain("requiredAttempt(attemptsById, brief.attemptId)");
    expect(app).toContain('fact("Digest", brief.digest)');
    expect(app).toContain('`worker-brief/v1 @ ${brief.compilerVersion}`');
    expect(app).toContain('fact("Policy snapshot", brief.policySnapshotSha256)');
    expect(app).toContain('fact("Authority", "none granted")');
    expect(app).toContain('"Compiled guidance identity per attempt');
    const serializedFixture = JSON.stringify(workPulseFixture);
    for (const brief of workPulseFixture.briefs) {
      expect(serializedFixture).toContain(brief.digest);
    }
  });

  test("contains no live transport, fake progress, or unsafe HTML sink", () => {
    expect(app).not.toMatch(/\bfetch\s*\(/u);
    expect(app).not.toContain("WebSocket");
    expect(app).not.toContain("EventSource");
    expect(app).not.toContain("setInterval");
    expect(app).not.toContain("Math.random");
    expect(app).not.toContain("innerHTML");
    expect(`${html}\n${app}`.toLowerCase()).not.toContain("percent complete");
    expect(`${html}\n${app}`.toLowerCase()).not.toContain("estimated time");
    expect(`${html}\n${app}`.toLowerCase()).not.toContain("chain of thought");
  });

  test("keeps the visual contract responsive, accessible, and motion-independent", () => {
    expect(css).toContain(":focus-visible");
    expect(css).toContain("prefers-color-scheme: dark");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("@media (max-width: 48rem)");
    expect(css).toContain("max-height: 48rem");
    expect(css).toContain("max-height: 40rem");
    expect(css).toContain("overflow-y: auto");
    expect(css).toContain(".identity-grid");
    expect(css).toContain(".timeline-list");
    for (const state of admittedAttemptStates) {
      expect(css).toContain(`[data-state="${state}"]`);
    }
    expect(css).not.toContain(".evidence-list");
    expect(css).not.toContain(".record-list.compact");
    expect(css).not.toMatch(/gradient/iu);
    expect(app).toContain('role: "region"');
    expect(app).toContain('tabindex: "0"');
    expect(app).toContain('"aria-label": "Attempt roster records"');
    expect(app).toContain('"aria-label": "Evidence timeline records"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-busy="true"');
  });
});
