import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { frontendLabFixture, frontendLabTasks } from "../site/labs/fixtures.js";

const routeRoot = join(import.meta.dir, "..", "site", "labs", "field-console");
const policySource = readFileSync(join(routeRoot, "fixture-policy.js"), "utf8");

describe("Field Console shared fixture policy", () => {
  test("projects one frozen record set from exact shared identities", () => {
    const policy = executePolicy();
    const baseRecords = completeMetadata();
    const projected = policy.projectRecords(baseRecords, "degraded");

    expect(Object.isFrozen(projected)).toBe(true);
    expect(projected).toHaveLength(baseRecords.length);
    expect(requiredRecord(projected, fixtureId(frontendLabFixture.decision.id))).toMatchObject({
      kind: "decision",
      title: frontendLabFixture.decision.title,
      summary: frontendLabFixture.decision.detail,
      state: "attention",
      actionLabel: "Read next action",
    });

    const degraded = requiredRecord(projected, "sync-violet");
    expect(degraded).toMatchObject({
      kind: "operation",
      title: frontendLabFixture.operations[1]?.title,
      state: frontendLabFixture.operations[1]?.state,
      nextAction: frontendLabFixture.operations[1]?.action,
      actionLabel: "Read next action",
    });
    expect(degraded.summary).toContain("18 minutes");
    expect(requiredRecord(projected, "deploy-amber")).toMatchObject({
      nextAction: frontendLabFixture.operations[0]?.action,
      actionLabel: "Read safe next action",
    });
    expect(projected.filter((entry) => entry.kind === "connection").map(({ title, state }) => ({ title, state }))).toEqual([
      { title: "GitHub", state: "healthy" },
      { title: "API", state: "reconnecting" },
      { title: "MCP", state: "offline" },
    ]);
  });

  test("rejects incomplete, duplicate, mismatched, and unsafe metadata", () => {
    const policy = executePolicy();
    const complete = completeMetadata();

    expect(() => policy.projectRecords(complete.slice(1), "default")).toThrow("must match the shared fixture identities");
    expect(() => policy.projectRecords([...complete, complete[0]!], "default")).toThrow("must be unique");
    expect(() => policy.projectRecords(complete.map((entry) => entry.id === "moss" ? { ...entry, kind: "operation" } : entry), "default"))
      .toThrow("must keep its shared fixture kind");
    expect(() => policy.projectRecords(complete.map((entry) => entry.id === "moss" ? { ...entry, task: "unknown-task" } : entry), "default"))
      .toThrow("Unknown Field Console task identity");
    expect(() => policy.projectRecords(complete.map((entry) => entry.id === "moss" ? { ...entry, position: [20, Number.NaN] } : entry), "default"))
      .toThrow("requires one finite topology position");
    expect(() => policy.projectRecords(complete.map((entry) => entry.id === "moss" ? { ...entry, surprise: true } : entry), "default"))
      .toThrow("must use exact metadata fields");
    expect(() => policy.projectRecords(complete, "surprise")).toThrow("Unsupported Field Console scenario");
  });

  test("never invokes accessors while admitting metadata", () => {
    const policy = executePolicy();
    const complete = completeMetadata();
    let getterCalls = 0;
    const accessor = { ...complete[0]! } as MetadataRecord;
    Object.defineProperty(accessor, "owner", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return "operator";
      },
    });
    expect(() => policy.projectRecords([accessor, ...complete.slice(1)], "default"))
      .toThrow("metadata field owner must be an enumerable data property");
    expect(getterCalls).toBe(0);

    const symbolic = { ...complete[0]!, [Symbol("hidden")]: true };
    expect(() => policy.projectRecords([symbolic, ...complete.slice(1)] as MetadataRecord[], "default"))
      .toThrow("without symbol fields");
  });

  test("publishes an immutable local policy without external authority", () => {
    const runtime = executeRuntime();
    expect(Object.isFrozen(runtime.StensiblyFieldConsolePolicy)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(runtime, "StensiblyFieldConsolePolicy")).toMatchObject({
      writable: false,
      enumerable: false,
      configurable: false,
    });
    expect(() => new Function(policySource)).not.toThrow();
    expect(policySource).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/);
    expect(policySource).not.toMatch(/https?:\/\//);
    expect(policySource).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB)\b/);
    expect(policySource).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
  });
});

type MetadataRecord = {
  id: string;
  kind: string;
  owner: string;
  timestamp: string;
  evidence: string;
  priority: number;
  nextAction: string;
  position: number[];
  task: string | null;
};

type ProjectedRecord = MetadataRecord & {
  state: string;
  title: string;
  summary: string;
  actionLabel: string;
};

type Policy = {
  projectRecords(records: readonly MetadataRecord[], scenario: string): readonly ProjectedRecord[];
};

function completeMetadata(): MetadataRecord[] {
  return [
    base(fixtureId(frontendLabFixture.decision.id), "decision", "human-decision"),
    ...frontendLabFixture.workers.map((entry) => base(fixtureId(entry.id), "worker", "worker-health")),
    ...frontendLabFixture.readyWork.map((entry, index) => base(fixtureId(entry.id), "ready work", index === 0 ? "recommended-work" : null)),
    ...frontendLabFixture.operations.map((entry, index) => base(fixtureId(entry.id), "operation", index === 0 ? "safe-reconciliation" : null)),
    ...frontendLabFixture.connections.map((entry) => base(fixtureId(entry.id), "connection", "connection-health")),
  ];
}

function fixtureId(value: unknown): string {
  if (typeof value !== "string" || !value) throw new TypeError("Expected a shared fixture string identity");
  return value;
}

function base(id: string, kind: string, task: string | null): MetadataRecord {
  return {
    id,
    kind,
    owner: "fixture owner",
    timestamp: "09:42 UTC",
    evidence: "fixture-evidence",
    priority: 1,
    nextAction: "Read the bounded local guidance.",
    position: [50, 50],
    task,
  };
}

function requiredRecord(records: readonly ProjectedRecord[], id: string): ProjectedRecord {
  const record = records.find((candidate) => candidate.id === id);
  if (!record) throw new Error(`Missing projected record ${id}`);
  return record;
}

function executePolicy(): Policy {
  const runtime = executeRuntime();
  if (!runtime.StensiblyFieldConsolePolicy) throw new Error("Field Console policy was not published");
  return runtime.StensiblyFieldConsolePolicy;
}

function executeRuntime(): {
  StensiblyFieldConsolePolicy?: Policy;
} {
  const runtime: {
    StensiblyFrontendLabFixtures: {
      frontendLabFixture: typeof frontendLabFixture;
      frontendLabTasks: typeof frontendLabTasks;
    };
    StensiblyFieldConsolePolicy?: Policy;
    Map: MapConstructor;
    Set: SetConstructor;
    Object: ObjectConstructor;
    Array: ArrayConstructor;
    Number: NumberConstructor;
    Error: ErrorConstructor;
    TypeError: TypeErrorConstructor;
  } = {
    StensiblyFrontendLabFixtures: { frontendLabFixture, frontendLabTasks },
    Map,
    Set,
    Object,
    Array,
    Number,
    Error,
    TypeError,
  };
  runInNewContext(policySource, runtime);
  return runtime;
}
