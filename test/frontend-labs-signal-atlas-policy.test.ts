import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { frontendLabFixture, frontendLabTasks } from "../site/labs/fixtures.js";

const routeRoot = join(import.meta.dir, "..", "site", "labs", "signal-atlas");
const policySource = readFileSync(join(routeRoot, "fixture-policy.js"), "utf8");

describe("Signal Atlas shared fixture policy", () => {
  test("projects one frozen record set from the exact narrative subset", () => {
    const policy = executePolicy();
    const metadata = completeMetadata();
    const projected = policy.projectRecords(metadata);

    expect(Object.isFrozen(projected)).toBe(true);
    expect(projected).toHaveLength(metadata.length);
    expect(requiredRecord(projected, fixtureId(frontendLabFixture.decision.id))).toMatchObject({
      kind: "decision",
      title: frontendLabFixture.decision.title,
      summary: frontendLabFixture.decision.detail,
      state: "attention",
    });
    expect(requiredRecord(projected, "deploy-amber")).toMatchObject({
      kind: "operation",
      title: frontendLabFixture.operations[0]?.title,
      state: frontendLabFixture.operations[0]?.state,
    });
    expect(requiredRecord(projected, "deploy-amber").nextAction)
      .toContain(fixtureText(frontendLabFixture.operations[0]?.action));
    expect(requiredRecord(projected, "api")).toMatchObject({
      title: frontendLabFixture.connections[1]?.label,
      state: frontendLabFixture.connections[1]?.state,
    });
  });

  test("rejects incomplete, duplicate, mismatched, and unsafe metadata", () => {
    const policy = executePolicy();
    const complete = completeMetadata();
    expect(() => policy.projectRecords(complete.slice(1))).toThrow("must match the admitted shared fixture subset");
    expect(() => policy.projectRecords([...complete, complete[0]!])).toThrow("must be unique");
    expect(() => policy.projectRecords(complete.map((entry) => entry.id === "api" ? { ...entry, kind: "operation" } : entry)))
      .toThrow("must keep its shared fixture kind");
    expect(() => policy.projectRecords(complete.map((entry) => entry.id === "api" ? { ...entry, task: "unknown-task" } : entry)))
      .toThrow("Unknown Signal Atlas task identity");
    expect(() => policy.projectRecords(complete.map((entry) => entry.id === "api" ? { ...entry, position: [10, Number.NaN] } : entry)))
      .toThrow("requires one finite landscape position");
    expect(() => policy.projectRecords(complete.map((entry) => entry.id === "api" ? { ...entry, surprise: true } : entry)))
      .toThrow("must use exact metadata fields");
  });

  test("never invokes accessors during metadata admission", () => {
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
    expect(() => policy.projectRecords([accessor, ...complete.slice(1)]))
      .toThrow("metadata field owner must be an enumerable data property");
    expect(getterCalls).toBe(0);

    const symbolic = { ...complete[0]!, [Symbol("hidden")]: true };
    expect(() => policy.projectRecords([symbolic, ...complete.slice(1)] as MetadataRecord[]))
      .toThrow("without symbol fields");
  });

  test("admits arrays without invoking caller methods, iterators, or slot accessors", () => {
    const policy = executePolicy();
    const complete = completeMetadata();
    let calls = 0;

    for (const key of ["map", "every"] as const) {
      const decorated = [...complete] as MetadataRecord[] & Record<string, unknown>;
      Object.defineProperty(decorated, key, {
        enumerable: true,
        configurable: true,
        get() {
          calls += 1;
          return () => [];
        },
      });
      expect(() => policy.projectRecords(decorated)).toThrow("contains an unsupported field");
    }

    const iterated = [...complete];
    Object.defineProperty(iterated, Symbol.iterator, {
      enumerable: false,
      configurable: true,
      get() {
        calls += 1;
        return Array.prototype[Symbol.iterator];
      },
    });
    expect(() => policy.projectRecords(iterated)).toThrow("cannot contain symbol fields");

    const accessor = [...complete];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return complete[0];
      },
    });
    expect(() => policy.projectRecords(accessor)).toThrow("must be a dense data array");

    const sparse = [...complete];
    delete sparse[0];
    expect(() => policy.projectRecords(sparse)).toThrow("must be a dense data array");

    const outOfRange = [...complete] as MetadataRecord[] & Record<string, unknown>;
    Object.defineProperty(outOfRange, String(outOfRange.length), {
      enumerable: true,
      configurable: true,
      value: complete[0],
    });
    Object.defineProperty(outOfRange, "length", {
      writable: true,
      enumerable: false,
      configurable: false,
      value: complete.length,
    });
    expect(() => policy.projectRecords(outOfRange)).toThrow("contains an unsupported field");

    const hostilePosition = complete.map((entry) => ({ ...entry, position: [...entry.position] }));
    Object.defineProperty(hostilePosition[0]!.position, "every", {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return () => true;
      },
    });
    expect(() => policy.projectRecords(hostilePosition)).toThrow("contains an unsupported field");
    expect(calls).toBe(0);
  });

  test("publishes an immutable local policy without external authority", () => {
    const runtime = executeRuntime();
    expect(Object.isFrozen(runtime.StensiblySignalAtlasPolicy)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(runtime, "StensiblySignalAtlasPolicy")).toMatchObject({
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
  time: string;
  evidence: string;
  nextAction: string;
  position: number[];
  task: string | null;
};

type ProjectedRecord = MetadataRecord & {
  state: string;
  title: string;
  summary: string;
};

type Policy = {
  projectRecords(records: readonly MetadataRecord[]): readonly ProjectedRecord[];
};

function completeMetadata(): MetadataRecord[] {
  return [
    base(fixtureId(frontendLabFixture.decision.id), "decision", "human-decision"),
    ...frontendLabFixture.workers.map((entry) => base(fixtureId(entry.id), "worker", "worker-health")),
    base(fixtureId(frontendLabFixture.readyWork[0]?.id), "ready work", "recommended-work"),
    base(fixtureId(frontendLabFixture.operations[0]?.id), "operation", "safe-reconciliation"),
    base(fixtureId(frontendLabFixture.operations[2]?.id), "operation", null),
    ...frontendLabFixture.connections.map((entry) => base(fixtureId(entry.id), "connection", "connection-health")),
  ];
}

function base(id: string, kind: string, task: string | null): MetadataRecord {
  return {
    id,
    kind,
    owner: "fixture owner",
    time: "09:42 UTC",
    evidence: "fixture-evidence",
    nextAction: "Read the bounded local guidance.",
    position: [50, 50],
    task,
  };
}

function fixtureId(value: unknown): string {
  if (typeof value !== "string" || !value) throw new TypeError("Expected a shared fixture string identity");
  return value;
}

function fixtureText(value: unknown): string {
  if (typeof value !== "string" || !value) throw new TypeError("Expected shared fixture text");
  return value;
}

function requiredRecord(records: readonly ProjectedRecord[], id: string): ProjectedRecord {
  const record = records.find((candidate) => candidate.id === id);
  if (!record) throw new Error(`Missing projected Signal Atlas record ${id}`);
  return record;
}

function executePolicy(): Policy {
  const runtime = executeRuntime();
  if (!runtime.StensiblySignalAtlasPolicy) throw new Error("Signal Atlas policy was not published");
  return runtime.StensiblySignalAtlasPolicy;
}

function executeRuntime(): { StensiblySignalAtlasPolicy?: Policy } {
  const runtime: {
    StensiblyFrontendLabFixtures: {
      frontendLabFixture: typeof frontendLabFixture;
      frontendLabTasks: typeof frontendLabTasks;
    };
    StensiblySignalAtlasPolicy?: Policy;
    Map: MapConstructor;
    Set: SetConstructor;
    Object: ObjectConstructor;
    Array: ArrayConstructor;
    Number: NumberConstructor;
    Reflect: typeof Reflect;
    Error: ErrorConstructor;
    TypeError: TypeErrorConstructor;
  } = {
    StensiblyFrontendLabFixtures: { frontendLabFixture, frontendLabTasks },
    Map,
    Set,
    Object,
    Array,
    Number,
    Reflect,
    Error,
    TypeError,
  };
  runInNewContext(policySource, runtime);
  return runtime;
}
