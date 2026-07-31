import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { frontendLabFixture } from "../site/labs/fixtures.js";

const routeRoot = join(import.meta.dir, "..", "site", "labs", "field-console");
const html = readFileSync(join(routeRoot, "index.html"), "utf8");
const bridge = readFileSync(join(routeRoot, "fixture-bridge.js"), "utf8");

type DetailPresentation = {
  facts: readonly (readonly [string, string])[];
  connections: readonly string[];
};

type FieldConsolePolicy = {
  projectRecords(records: readonly BaseRecord[], scenario: string): readonly ProjectedRecord[];
  detailPresentation(records: readonly ProjectedRecord[]): DetailPresentation;
};

describe("Field Console shared fixture bridge", () => {
  test("loads the shared fixture before the app and projects one synchronous record set", () => {
    expect(html.indexOf('../fixtures.classic.js')).toBeLessThan(html.indexOf('./app.js'));
    expect(html.indexOf('./app.js')).toBeLessThan(html.indexOf('./fixture-bridge.js'));

    const baseRecords = fixtureBaseRecords();
    const connectionHealth = new FakeContainer();
    const detailGrid = new FakeNode();
    const connectionList = new FakeNode();
    const detailBody = {
      querySelector(selector: string) {
        if (selector === ".detail-grid") return detailGrid;
        if (selector === ".detail-list") return connectionList;
        return null;
      },
    };
    let renderCount = 0;
    let baseDetailRenderCount = 0;
    const runtime: Record<string, unknown> & {
      StensiblyFieldConsolePolicy?: FieldConsolePolicy;
      scenarioRecords?: () => readonly ProjectedRecord[];
      byId?: (id: string) => ProjectedRecord;
      renderHealth?: () => void;
      renderDetail?: () => void;
    } = {
      StensiblyFrontendLabFixtures: { frontendLabFixture },
      records: baseRecords,
      scenario: "degraded",
      selectedId: "sync-violet",
      detailBody,
      scenarioRecords: () => baseRecords,
      byId: (id: string) => requiredRecord(baseRecords, id),
      renderHealth: () => undefined,
      renderDetail: () => { baseDetailRenderCount += 1; },
      renderAll: () => { renderCount += 1; },
      required: (selector: string) => {
        if (selector !== "#connection-health") throw new Error(`Unexpected selector ${selector}`);
        return connectionHealth;
      },
      stateChip: (state: string, label: string) => ({ state, label }),
      stateLabels: {
        healthy: "healthy",
        reconnecting: "reconnecting",
        offline: "offline",
      },
      document: { createElement: () => new FakeNode() },
      Map,
      Set,
      Object,
      Array,
      Error,
      TypeError,
    };

    runInNewContext(bridge, runtime);

    expect(renderCount).toBe(1);
    expect(Object.isFrozen(runtime.StensiblyFieldConsolePolicy)).toBe(true);
    const first = runtime.scenarioRecords?.();
    const second = runtime.scenarioRecords?.();
    expect(first).toBe(second);
    expect(first).toHaveLength(baseRecords.length);

    const decision = first?.find((entry) => entry.id === fixtureId(frontendLabFixture.decision.id, "decision"));
    expect(decision).toMatchObject({
      title: frontendLabFixture.decision.title,
      summary: frontendLabFixture.decision.detail,
      state: "attention",
      actionLabel: "Read next action",
    });

    const degraded = runtime.byId?.("sync-violet");
    expect(degraded).toMatchObject({
      title: frontendLabFixture.operations[1]?.title,
      state: frontendLabFixture.operations[1]?.state,
      nextAction: frontendLabFixture.operations[1]?.action,
      actionLabel: "Read next action",
    });
    expect(degraded?.summary).toContain("18 minutes");
    expect(runtime.byId?.("deploy-amber")).toMatchObject({
      nextAction: frontendLabFixture.operations[0]?.action,
      actionLabel: "Read safe next action",
    });

    runtime.renderHealth?.();
    expect(connectionHealth.children).toEqual([
      { state: "healthy", label: "GitHub healthy" },
      { state: "reconnecting", label: "API reconnecting" },
      { state: "offline", label: "MCP offline" },
    ]);

    const presentation = runtime.StensiblyFieldConsolePolicy?.detailPresentation(first ?? []);
    if (!presentation) throw new Error("Field Console detail presentation was not published");
    expect(Object.isFrozen(presentation)).toBe(true);
    expect(Object.isFrozen(presentation.facts)).toBe(true);
    expect(Object.isFrozen(presentation.connections)).toBe(true);
    expect(presentation.facts).toEqual([
      ["Authority", "Fixture guidance only"],
      ["Persistence", "Page instance only; nothing saved"],
    ]);
    expect(presentation.connections).toEqual([
      `GitHub: healthy — ${frontendLabFixture.connections[0]?.detail}`,
      `API: reconnecting — ${frontendLabFixture.connections[1]?.detail}`,
      `MCP: offline — ${frontendLabFixture.connections[2]?.detail}`,
    ]);

    runtime.renderDetail?.();
    expect(baseDetailRenderCount).toBe(1);
    expect(detailGrid.children.map(nodeText)).toEqual([
      "AuthorityFixture guidance only",
      "PersistencePage instance only; nothing saved",
    ]);
    expect(connectionList.children.map(nodeText)).toEqual([...presentation.connections]);
  });

  test("rejects incomplete or duplicate local identity metadata", () => {
    const policy = executePolicy();
    const complete = fixtureBaseRecords();
    expect(() => policy.projectRecords(complete.slice(1), "default")).toThrow("must match the shared fixture identities");
    expect(() => policy.projectRecords([...complete, complete[0]!], "default")).toThrow("must be unique");
    expect(() => policy.projectRecords(complete.map((entry) => entry.id === "moss" ? { ...entry, kind: "operation" } : entry), "default"))
      .toThrow("must keep its shared fixture kind");
    expect(() => policy.detailPresentation(complete.slice(0, 2))).toThrow("requires every shared connection");
  });

  test("stays local, fixture-only, and gradient-free", () => {
    expect(() => new Function(bridge)).not.toThrow();
    expect(bridge).toContain("renderDetail = function renderProjectedDetail");
    expect(bridge).toContain("policy.detailPresentation(scenarioRecords())");
    expect(bridge).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/);
    expect(bridge).not.toMatch(/https?:\/\//);
    expect(bridge).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB)\b/);
    expect(bridge).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
  });
});

type BaseRecord = {
  id: string;
  kind: string;
  state: string;
  title: string;
  summary: string;
  nextAction: string;
  actionLabel: string;
};

type ProjectedRecord = BaseRecord;

class FakeContainer {
  children: unknown[] = [];
  replaceChildren(...children: unknown[]) {
    this.children = children;
  }
}

class FakeNode {
  children: FakeNode[] = [];
  className = "";
  textContent = "";
  append(...children: FakeNode[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: FakeNode[]) {
    this.children = children;
  }
}

function nodeText(node: FakeNode): string {
  return `${node.textContent}${node.children.map(nodeText).join("")}`;
}

function fixtureBaseRecords(): BaseRecord[] {
  return [
    base(fixtureId(frontendLabFixture.decision.id, "decision"), "decision"),
    ...frontendLabFixture.workers.map((entry, index) => base(fixtureId(entry.id, `worker ${index + 1}`), "worker")),
    ...frontendLabFixture.readyWork.map((entry, index) => base(fixtureId(entry.id, `ready work ${index + 1}`), "ready work")),
    ...frontendLabFixture.operations.map((entry, index) => base(fixtureId(entry.id, `operation ${index + 1}`), "operation")),
    ...frontendLabFixture.connections.map((entry, index) => base(fixtureId(entry.id, `connection ${index + 1}`), "connection")),
  ];
}

function fixtureId(value: string | number | undefined, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Missing fixture id for ${label}`);
  return value;
}

function base(id: string, kind: string): BaseRecord {
  return {
    id,
    kind,
    state: "stale",
    title: "stale local title",
    summary: "stale local summary",
    nextAction: "stale local action",
    actionLabel: "stale operational promise",
  };
}

function requiredRecord(records: readonly BaseRecord[], id: string): BaseRecord {
  const entry = records.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Missing fake Field Console record: ${id}`);
  return entry;
}

function executePolicy(): FieldConsolePolicy {
  const records = fixtureBaseRecords();
  const runtime: Record<string, unknown> & {
    StensiblyFieldConsolePolicy?: FieldConsolePolicy;
  } = {
    StensiblyFrontendLabFixtures: { frontendLabFixture },
    records,
    scenario: "default",
    selectedId: null,
    detailBody: { querySelector: () => null },
    scenarioRecords: () => records,
    byId: (id: string) => requiredRecord(records, id),
    renderHealth: () => undefined,
    renderDetail: () => undefined,
    renderAll: () => undefined,
    required: () => new FakeContainer(),
    stateChip: (state: string, label: string) => ({ state, label }),
    stateLabels: { healthy: "healthy", reconnecting: "reconnecting", offline: "offline" },
    document: { createElement: () => new FakeNode() },
    Map,
    Set,
    Object,
    Array,
    Error,
    TypeError,
  };
  runInNewContext(bridge, runtime);
  if (!runtime.StensiblyFieldConsolePolicy) throw new Error("Field Console policy was not published");
  return runtime.StensiblyFieldConsolePolicy;
}
