import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { frontendLabFixture } from "../site/labs/fixtures.js";

const routeRoot = join(import.meta.dir, "..", "site", "labs", "signal-atlas");
const html = readFileSync(join(routeRoot, "index.html"), "utf8");
const bridge = readFileSync(join(routeRoot, "fixture-bridge.js"), "utf8");

describe("Signal Atlas shared fixture and ledger bridge", () => {
  test("loads after the app, projects shared records, and declares exact ledger destinations", () => {
    expect(html.indexOf('../fixtures.classic.js')).toBeLessThan(html.indexOf('./app.js'));
    expect(html.indexOf('./app.js')).toBeLessThan(html.indexOf('./fixture-bridge.js'));
    expect(html.indexOf('./fixture-bridge.js')).toBeLessThan(html.indexOf('./map-focus.js'));

    const runtime = executeBridge();
    const policy = runtime.StensiblySignalAtlasPolicy;
    if (!policy) throw new Error("Signal Atlas policy was not published");
    expect(Object.isFrozen(policy)).toBe(true);

    expect(runtime.byId?.("approve-release-note")).toMatchObject({
      title: frontendLabFixture.decision.title,
      summary: frontendLabFixture.decision.detail,
      state: "attention",
    });
    const deploy = runtime.byId?.("deploy-amber");
    expect(deploy).toMatchObject({
      title: frontendLabFixture.operations[0]?.title,
      state: frontendLabFixture.operations[0]?.state,
    });
    expect(deploy?.nextAction).toContain(frontendLabFixture.operations[0]?.action);
    expect(runtime.byId?.("api")).toMatchObject({
      title: frontendLabFixture.connections[1]?.label,
      state: frontendLabFixture.connections[1]?.state,
    });

    expect(policy.ledgerChapter("deploy-amber")).toBe("ambiguity");
    expect(policy.ledgerChapter("api")).toBe("connections");
    expect(policy.ledgerChapter("ember")).toBe("workers");
  });

  test("routes ambiguous and provider ledger events to their declared chapters", () => {
    const runtime = executeBridge();
    const deployButton = findRecordButton(runtime.ledgerList.children, "deploy-amber");
    deployButton.clickListener?.();
    expect(runtime.chapterIndex).toBe(3);
    expect(runtime.selectedRecordId).toBe("deploy-amber");
    expect(runtime.evidenceBody.focused).toBe(true);
    expect(runtime.closeCalls).toEqual([false]);

    runtime.evidenceBody.focused = false;
    const apiButton = findRecordButton(runtime.ledgerList.children, "api");
    apiButton.clickListener?.();
    expect(runtime.chapterIndex).toBe(4);
    expect(runtime.selectedRecordId).toBe("api");
    expect(runtime.evidenceBody.focused).toBe(true);
    expect(runtime.closeCalls).toEqual([false, false]);
  });

  test("rejects incomplete, duplicate, or mismatched local record metadata", () => {
    const runtime = executeBridge();
    const policy = runtime.StensiblySignalAtlasPolicy;
    if (!policy) throw new Error("Signal Atlas policy was not published");
    const complete = signalBaseRecords();
    expect(() => policy.projectRecords(complete.slice(1))).toThrow("must match the admitted shared fixture subset");
    expect(() => policy.projectRecords([...complete, complete[0]!])).toThrow("must be unique");
    expect(() => policy.projectRecords(complete.map((entry) => entry.id === "api" ? { ...entry, kind: "operation" } : entry)))
      .toThrow("must keep its shared fixture kind");
    expect(() => policy.ledgerChapter("unknown-record")).toThrow("requires an explicit chapter");
  });

  test("stays local, fixture-only, storage-free, and gradient-free", () => {
    expect(() => new Function(bridge)).not.toThrow();
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
  owner: string;
  time: string;
  evidence: string;
  nextAction: string;
  position: readonly [number, number];
};

type ProjectedRecord = BaseRecord;

type SignalPolicy = {
  projectRecords(records: readonly BaseRecord[]): readonly ProjectedRecord[];
  ledgerChapter(recordId: string): string;
};

class FakeElement {
  children: FakeElement[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  textContent = "";
  hidden = false;
  focused = false;
  type = "";
  className = "";
  clickListener: (() => void) | null = null;

  append(...children: FakeElement[]) {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]) {
    this.children = children;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: () => void) {
    if (type === "click") this.clickListener = listener;
  }

  focus() {
    this.focused = true;
  }
}

function executeBridge() {
  const ledgerList = new FakeElement();
  const mapNodes = new FakeElement();
  const evidenceBody = new FakeElement();
  const closeCalls: boolean[] = [];
  let chapterRenders = 0;
  let chapterListRenders = 0;
  const records = signalBaseRecords();
  const chapters = signalChapters();
  const ledgerEvents = [
    event("09:28 UTC", "ember", "Lease crossed the recovery threshold.", "unhealthy"),
    event("09:31 UTC", "archive-coral", "Archive recovered.", "recovered"),
    event("09:36 UTC", "deploy-amber", "Publication timed out.", "ambiguous"),
    event("09:40 UTC", "moss", "Review remained healthy.", "healthy"),
    event("09:41 UTC", "api", "API reconnecting.", "reconnecting"),
    event("09:42 UTC", "approve-release-note", "Decision remains.", "attention"),
  ];

  const runtime: Record<string, unknown> & {
    StensiblySignalAtlasPolicy?: SignalPolicy;
    byId?: (id: string) => ProjectedRecord;
    chapterIndex: number;
    selectedRecordId: string;
    ledgerList: FakeElement;
    evidenceBody: FakeElement;
    closeCalls: boolean[];
  } = {
    StensiblyFrontendLabFixtures: { frontendLabFixture },
    records,
    chapters,
    ledgerEvents,
    stateLabels: {
      attention: "human decision",
      healthy: "healthy",
      unhealthy: "lease unhealthy",
      ready: "recommended ready work",
      ambiguous: "ambiguous settlement",
      recovered: "recovered",
      reconnecting: "reconnecting",
      offline: "offline",
    },
    ledgerList,
    mapNodes,
    evidenceBody,
    closeCalls,
    selectedRecordId: "approve-release-note",
    chapterIndex: 0,
    byId: (id: string) => requiredRecord(records, id),
    renderMap: () => undefined,
    renderEvidence: () => undefined,
    renderLedger: () => undefined,
    renderChapter: () => { chapterRenders += 1; },
    renderChapterList: () => { chapterListRenders += 1; },
    closeLedger: (restore: boolean) => closeCalls.push(restore),
    announce: () => undefined,
    selectRecord: () => undefined,
    symbolFor: () => "●",
    section: (_title: string, content: FakeElement) => content,
    evidenceList: () => new FakeElement(),
    elementWithChildren: (_tag: string, _className: string, ...children: FakeElement[]) => {
      const node = new FakeElement();
      node.append(...children);
      return node;
    },
    text: (_tag: string, value: string) => {
      const node = new FakeElement();
      node.textContent = value;
      return node;
    },
    document: {
      createElement: () => new FakeElement(),
    },
    Map,
    Set,
    Object,
    Array,
    String,
    Error,
    TypeError,
  };

  runInNewContext(bridge, runtime);
  expect(chapterRenders).toBe(1);
  expect(chapterListRenders).toBe(0);
  return runtime;
}

function signalBaseRecords(): BaseRecord[] {
  return [
    base(fixtureId(frontendLabFixture.decision.id, "decision"), "decision"),
    ...frontendLabFixture.workers.map((entry, index) => base(fixtureId(entry.id, `worker ${index + 1}`), "worker")),
    base(fixtureId(frontendLabFixture.readyWork[0]?.id, "top ready work"), "ready work"),
    base(fixtureId(frontendLabFixture.operations[0]?.id, "ambiguous operation"), "operation"),
    base(fixtureId(frontendLabFixture.operations[2]?.id, "recovered operation"), "operation"),
    ...frontendLabFixture.connections.map((entry, index) => base(fixtureId(entry.id, `connection ${index + 1}`), "connection")),
  ];
}

function signalChapters() {
  return [
    chapter("decision", ["approve-release-note", "deploy-amber"]),
    chapter("workers", ["moss", "ember", "repair-focus-order"]),
    chapter("recommendation", ["repair-focus-order", "moss", "deploy-amber"]),
    chapter("ambiguity", ["deploy-amber", "api", "archive-coral", "approve-release-note"]),
    chapter("connections", ["github", "api", "mcp", "deploy-amber"]),
  ];
}

function base(id: string, kind: string): BaseRecord {
  return {
    id,
    kind,
    state: "stale",
    title: "stale local title",
    summary: "stale local summary",
    owner: "local owner",
    time: "fixture time",
    evidence: "fixture evidence",
    nextAction: "local safe next action",
    position: [10, 20],
  };
}

function chapter(id: string, active: string[]) {
  return { id, active, selected: active[0] };
}

function event(time: string, recordId: string, copy: string, state: string) {
  return { time, recordId, copy, state };
}

function fixtureId(value: string | number | undefined, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Missing fixture id for ${label}`);
  return value;
}

function requiredRecord(records: readonly BaseRecord[], id: string): BaseRecord {
  const entry = records.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Missing fake Signal Atlas record: ${id}`);
  return entry;
}

function findRecordButton(nodes: readonly FakeElement[], recordId: string): FakeElement {
  const found = findRecordButtonOrNull(nodes, recordId);
  if (!found) throw new Error(`Missing Signal Atlas ledger button: ${recordId}`);
  return found;
}

function findRecordButtonOrNull(nodes: readonly FakeElement[], recordId: string): FakeElement | null {
  for (const node of nodes) {
    if (node.dataset.recordId === recordId) return node;
    const nested = findRecordButtonOrNull(node.children, recordId);
    if (nested) return nested;
  }
  return null;
}
