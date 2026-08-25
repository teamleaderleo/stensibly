import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertLedgerStatusRead,
  createLedgerStatusReader,
  DEFAULT_LEDGER_STATUS_ENDPOINT,
  LEDGER_STATUS_READ_METHODS,
  LEDGER_STATUS_READ_PATHS,
  LedgerStatusReadBoundaryError,
} from "../src/studio-status-read-client.js";
import {
  evaluateStudioBrief,
  runStudioBriefOnce,
  studioBriefLogLines,
  type StudioBrief,
} from "../src/studio-brief-monitor.js";
import {
  buildOvernightSummary,
  overnightSummaryLogLines,
  runOvernightSummaryOnce,
  type OvernightSummary,
} from "../src/overnight-studio-summary.js";
import { compareJudgmentProvenance, computeDigest, validateJudgmentProvenance } from "../src/independence-provenance.js";
import { cliOptionKeys as briefCliOptionKeys } from "../scripts/studio-brief-monitor.js";
import { cliOptionKeys as summaryCliOptionKeys } from "../scripts/overnight-studio-summary.js";
import type { LedgerStatusItem } from "../src/studio-status-read-client.js";

const REPO_ROOT = join(import.meta.dir, "..");

const MONITOR_SCRIPT_FILES = [
  "studio-brief-monitor.ts",
  "overnight-studio-summary.ts",
  "autonomous-worker-daemon.ts",
  "night-shift-daemon.ts",
] as const;

const DEPRECATED_ALIAS_FILES = ["autonomous-worker-daemon.ts", "night-shift-daemon.ts"] as const;

const ALLOWED_SCRIPT_IMPORTS: Record<string, readonly string[]> = {
  "studio-brief-monitor.ts": [
    "node:util",
    "../src/studio-status-read-client.js",
    "../src/studio-brief-monitor.js",
  ],
  "overnight-studio-summary.ts": [
    "node:util",
    "node:child_process",
    "../src/studio-status-read-client.js",
    "../src/overnight-studio-summary.js",
  ],
  "autonomous-worker-daemon.ts": [],
  "night-shift-daemon.ts": [],
};

const MUTATION_ENDPOINT_SUFFIXES = [
  "/api/v1/items",
  "/api/v1/items/item-1/artifacts",
  "/api/v1/items/item-1/claim",
  "/api/v1/items/item-1/renew",
  "/api/v1/items/item-1/handoff",
  "/api/v1/items/item-1/block",
  "/api/v1/items/item-1/unblock",
  "/api/v1/items/item-1/release",
  "/api/v1/items/item-1/complete",
  "/api/v1/items/item-1/events",
] as const;

function scriptSource(fileName: string): string {
  return readFileSync(join(REPO_ROOT, "scripts", fileName), "utf8");
}

/**
 * Command surface means executable statements. Doc comments may explain the
 * boundary; they cannot issue requests.
 */
function executableSource(fileName: string): string {
  return scriptSource(fileName)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

function fixtureItem(overrides: Partial<LedgerStatusItem> = {}): LedgerStatusItem {
  return {
    id: "item-1",
    project: "scrapbook",
    kind: "task",
    title: "Fixture item",
    status: "ready",
    priority: 3,
    updatedAt: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

function fixtureItems(): LedgerStatusItem[] {
  return [
    fixtureItem({ id: "ready-a", status: "ready", priority: 5, nextAction: "Do the thing" }),
    fixtureItem({ id: "ready-b", status: "ready", priority: 2 }),
    fixtureItem({ id: "active-a", status: "active", claimedBy: "Lark" }),
    fixtureItem({ id: "blocked-a", status: "blocked", nextAction: "Awaiting a decision" }),
    fixtureItem({ id: "done-a", status: "done" }),
  ];
}

function jsonFetchResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function asFetch(impl: FetchLike): typeof fetch {
  return ((_url: unknown, _init?: unknown) => impl(_url as string, _init as RequestInit | undefined)) as unknown as typeof fetch;
}

describe("ledger status read boundary", () => {
  test("the entire network surface is exactly GET /api/v1/items", () => {
    expect([...LEDGER_STATUS_READ_METHODS]).toEqual(["GET"]);
    expect([...LEDGER_STATUS_READ_PATHS]).toEqual(["/api/v1/items"]);
    expect(() => assertLedgerStatusRead("GET", "/api/v1/items")).not.toThrow();
  });

  test("refuses every mutation method before opening any connection", () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      expect(() => assertLedgerStatusRead(method, "/api/v1/items")).toThrow(LedgerStatusReadBoundaryError);
    }
  });

  test("refuses claim/lease/transition/approval/settlement endpoints even over GET", () => {
    for (const path of MUTATION_ENDPOINT_SUFFIXES) {
      if (path === "/api/v1/items") continue;
      expect(() => assertLedgerStatusRead("GET", path)).toThrow(LedgerStatusReadBoundaryError);
      expect(() => assertLedgerStatusRead("POST", path)).toThrow(LedgerStatusReadBoundaryError);
    }
  });
});

describe("monitor cycles are behaviorally read-only", () => {
  test("studio brief cycle issues exactly one allowlisted GET", async () => {
    let fetchCalls = 0;
    const fetchImpl = asFetch(async () => {
      fetchCalls += 1;
      return jsonFetchResponse({ items: fixtureItems() });
    });
    const reader = createLedgerStatusReader({ endpoint: "https://ledger.example", fetchImpl });
    const lines: string[] = [];
    const now = () => new Date("2026-08-25T10:20:30Z");

    const brief = await runStudioBriefOnce({
      reader,
      project: "scrapbook",
      log: (line) => lines.push(line),
      now,
    });

    expect(brief.activeCount).toBe(1);
    expect(brief.blockedCount).toBe(1);
    expect(brief.readyCount).toBe(2);
    expect(fetchCalls).toBe(1);
    expect(reader.recordedRequests()).toEqual([
      { method: "GET", url: "https://ledger.example/api/v1/items?project=scrapbook" },
    ]);
    expect(lines.join("\n")).toContain("Read-only studio brief for scrapbook");
  });

  test("overnight summary cycle issues exactly one allowlisted GET and degrades offline", async () => {
    const recordedBodies: unknown[] = [];
    const fetchImpl = asFetch(async (_url, init) => {
      recordedBodies.push(init?.body);
      return jsonFetchResponse({ items: fixtureItems() });
    });
    const reader = createLedgerStatusReader({ endpoint: "https://ledger.example/", token: "t", fetchImpl });
    const now = () => new Date("2026-08-25T03:04:05Z");

    const summary = await runOvernightSummaryOnce({
      reader,
      project: "scrapbook",
      localHealth: { gitClean: true, typecheckPass: true, testPass: false },
      log: () => {},
      now,
    });

    expect(summary.ledgerCounts).toEqual({ openTasksCount: 4, readyTasksCount: 2, blockedCount: 1 });
    expect(recordedBodies).toEqual([undefined]);
    expect(reader.recordedRequests()).toEqual([
      { method: "GET", url: "https://ledger.example/api/v1/items?project=scrapbook" },
    ]);

    const failingReader = createLedgerStatusReader({
      endpoint: "https://ledger.example",
      fetchImpl: asFetch(async () => new Response("nope", { status: 503 })),
    });
    const degraded = await runOvernightSummaryOnce({
      reader: failingReader,
      project: "scrapbook",
      localHealth: { gitClean: true, typecheckPass: true, testPass: true },
      log: () => {},
      now,
    });
    expect(degraded.ledgerCounts).toBeUndefined();
    expect(degraded.ledgerNote).toContain("503");
  });
});

describe("structural command-surface controls", () => {
  test("CLI option surface stays pinned to read-only flags", () => {
    const expected = ["endpoint", "token", "project", "once", "poll-interval"];
    expect([...briefCliOptionKeys].sort()).toEqual([...expected].sort());
    expect([...summaryCliOptionKeys].sort()).toEqual([...expected].sort());
    for (const keys of [briefCliOptionKeys, summaryCliOptionKeys]) {
      for (const key of keys) {
        expect(key.toLowerCase()).not.toMatch(/claim|apply|dispatch|approve|complete|settle|transition|renew|release|block|handoff|event|artifact|create/);
      }
    }
  });

  test("monitor scripts contain no mutation request markers", () => {
    for (const fileName of MONITOR_SCRIPT_FILES) {
      const source = executableSource(fileName);
      expect(source).not.toMatch(/method\s*:\s*["'](POST|PATCH|PUT|DELETE)["']/i);
      expect(source).not.toMatch(/\.(post|patch|put|delete)\s*\(/i);
      expect(source).not.toMatch(/\bXMLHttpRequest\b/);
    }
  });

  test("monitor scripts never name API paths or endpoint URLs directly", () => {
    for (const fileName of MONITOR_SCRIPT_FILES) {
      const source = executableSource(fileName);
      expect(source).not.toMatch(/api\/v1/);
      expect(source).not.toMatch(/https?:\/\//);
    }
    expect(DEFAULT_LEDGER_STATUS_ENDPOINT).toMatch(/^https:\/\//);
  });

  test("monitor scripts never call fetch themselves; only the read client may", () => {
    for (const fileName of MONITOR_SCRIPT_FILES) {
      expect(executableSource(fileName)).not.toMatch(/\bfetch\s*\(/);
    }
  });

  test("static imports stay on the allowlisted dependency surface", () => {
    for (const fileName of MONITOR_SCRIPT_FILES) {
      const source = executableSource(fileName);
      const specifiers = [...source.matchAll(/import\s+(?:[\s\S]*?from\s*)?["']([^"']+)["']/g)].map(
        (match) => match[1] ?? "",
      );
      const allowed = ALLOWED_SCRIPT_IMPORTS[fileName] ?? [];
      expect(specifiers).toEqual([...allowed]);
    }
  });

  test("deprecated aliases stay equally read-only and forward to the monitors", () => {
    const expectedTargets: Record<string, string> = {
      "autonomous-worker-daemon.ts": "./studio-brief-monitor.js",
      "night-shift-daemon.ts": "./overnight-studio-summary.js",
    };
    for (const fileName of DEPRECATED_ALIAS_FILES) {
      const source = scriptSource(fileName);
      expect(source).toContain("[deprecated]");
      expect(source).not.toMatch(/\bfetch\b/);
      expect(source).toContain(`await import("${expectedTargets[fileName]}")`);
      expect(source).toContain("read-only");
    }
  });

  test("monitor entries declare their read-only posture in banner text", () => {
    expect(scriptSource("studio-brief-monitor.ts")).toMatch(/read-only/i);
    expect(scriptSource("studio-brief-monitor.ts")).toMatch(/claims nothing/i);
    expect(scriptSource("overnight-studio-summary.ts")).toMatch(/read-only/i);
    expect(scriptSource("overnight-studio-summary.ts")).toMatch(/no ledger changes/i);
  });
});

describe("rendered wording matches the evidence emitted", () => {
  const brief: StudioBrief = evaluateStudioBrief(fixtureItems(), "scrapbook");
  const summary: OvernightSummary = buildOvernightSummary({
    timestamp: "2026-08-25T03:04:05.000Z",
    localHealth: { gitClean: true, typecheckPass: false, testPass: true },
    ledgerCounts: { openTasksCount: 4, readyTasksCount: 2, blockedCount: 1 },
  });

  test("output describes monitoring/status/summary with no autonomy or approval claims", () => {
    const text = [...studioBriefLogLines(brief, "10:20:30"), ...overnightSummaryLogLines(summary)]
      .join("\n")
      .toLowerCase();
    expect(text).toContain("read-only");
    expect(text).toMatch(/monitor/);
    expect(text).toMatch(/summary/);
    expect(text).not.toMatch(/autonom/);
    expect(text).not.toMatch(/approv/);
    expect(text).not.toMatch(/lease/);
    expect(text).not.toMatch(/night shift autonomous/);
  });

  test("brief marks blocked items as needing an owner decision, not autonomous action", () => {
    const text = studioBriefLogLines(brief, "10:20:30").join("\n").toLowerCase();
    expect(text).toContain("needs an owner decision");
  });

  test("brief marks suggested ready work as observed-only and routes claiming to the canonical ledger", () => {
    const readyOnlyBrief = evaluateStudioBrief(fixtureItems().filter((item) => item.status !== "blocked"), "scrapbook");
    const text = studioBriefLogLines(readyOnlyBrief, "10:20:30").join("\n").toLowerCase();
    expect(text).toContain("nothing claimed");
    expect(text).toContain("canonical ledger");
  });

  test("summary states that no ledger changes were made", () => {
    const text = overnightSummaryLogLines(summary).join("\n").toLowerCase();
    expect(text).toContain("no ledger changes were made");
  });
});

describe("dashboard wording reconciliation", () => {
  test("decision tray batch action is labeled by its real resolution effect", () => {
    const html = readFileSync(join(REPO_ROOT, "site", "index.html"), "utf8");
    const appJs = readFileSync(join(REPO_ROOT, "site", "app.js"), "utf8");
    expect(html).not.toContain("Approve All Ready");
    expect(appJs).not.toContain("Approve All Ready");
    // Completion can fall back to unblock, so a blanket "done" claim is untrue.
    expect(html).not.toContain("Mark All Done");
    expect(appJs).not.toContain("Mark All Done");
    expect(html).toContain("Clear Blockers");
    expect(appJs).toContain("TRAY_BATCH_LABEL = '⚡ Clear Blockers'");
  });
});

describe("#1661 judgment-provenance contract remains descriptive", () => {
  test("comparisons stay facts-only with no numeric oracle or independence verdict", async () => {
    const mod = (await import("../src/independence-provenance.js")) as unknown as Record<string, unknown>;
    expect(typeof mod.compareJudgmentProvenance).toBe("function");
    expect(mod.assessJudgmentIndependence).toBeUndefined();

    const primary = validateJudgmentProvenance({
      actorId: "sol",
      modelProvider: "openai",
      modelFamily: "gpt",
      modelIdentity: "gpt-5.6-sol",
      harness: "codex-cli",
      instructionDigest: computeDigest("brief"),
      contextPacketDigest: computeDigest({ context: "primary" }),
      priorJudgmentExposure: "sealed",
      recordedAt: "2026-08-25T00:00:00.000Z",
    });
    const reviewer = validateJudgmentProvenance({
      actorId: "luna",
      modelProvider: "anthropic",
      modelFamily: "claude",
      modelIdentity: "claude-luna",
      harness: "codex-cli",
      instructionDigest: computeDigest("review brief"),
      contextPacketDigest: computeDigest({ context: "review" }),
      priorJudgmentExposure: "partial",
      recordedAt: "2026-08-25T00:01:00.000Z",
    });

    const comparison = compareJudgmentProvenance(primary, reviewer);
    expect(comparison.modelProvider).toBe("different");
    expect(comparison.harness).toBe("same");
    expect(comparison.priorJudgmentExposure).toBe("partial");
    expect(comparison).not.toHaveProperty("separationScore");
    expect(comparison).not.toHaveProperty("isIndependent");
    expect(comparison).not.toHaveProperty("riskTier");
  });
});
