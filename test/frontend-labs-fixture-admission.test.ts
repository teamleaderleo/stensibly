import { describe, expect, test } from "bun:test";
import {
  createFrontendLabReport,
  frontendLabFixture,
  frontendLabTasks,
  parseFrontendLabFixture,
  parseFrontendLabTasks,
} from "../site/labs/fixtures.js";

function fixtureCopy(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(frontendLabFixture)) as Record<string, unknown>;
}

function taskCopy(): Record<string, unknown>[] {
  return JSON.parse(JSON.stringify(frontendLabTasks)) as Record<string, unknown>[];
}

describe("frontend lab fixture admission", () => {
  test("rejects fixture accessors without invoking them", () => {
    let reads = 0;
    const fixture = fixtureCopy();
    Object.defineProperty(fixture, "project", {
      enumerable: true,
      get() {
        reads += 1;
        return frontendLabFixture.project;
      },
    });

    expect(() => parseFrontendLabFixture(fixture)).toThrow(
      "Frontend labs fixture field project must be an enumerable data property",
    );
    expect(reads).toBe(0);
  });

  test("rejects list-entry and nested-field accessors without invocation", () => {
    let entryReads = 0;
    const fixtureWithEntryAccessor = fixtureCopy();
    const workers = fixtureWithEntryAccessor.workers as unknown[];
    Object.defineProperty(workers, 0, {
      enumerable: true,
      get() {
        entryReads += 1;
        return frontendLabFixture.workers[0];
      },
    });

    expect(() => parseFrontendLabFixture(fixtureWithEntryAccessor)).toThrow(
      "List entry 1 must be an enumerable data property",
    );
    expect(entryReads).toBe(0);

    let idReads = 0;
    const fixtureWithIdAccessor = fixtureCopy();
    const worker = (fixtureWithIdAccessor.workers as Record<string, unknown>[])[0]!;
    Object.defineProperty(worker, "id", {
      enumerable: true,
      get() {
        idReads += 1;
        return "moss";
      },
    });

    expect(() => parseFrontendLabFixture(fixtureWithIdAccessor)).toThrow(
      "worker 1 field id must be an enumerable data property",
    );
    expect(idReads).toBe(0);
  });

  test("rejects hidden, symbolic, sparse, and decorated inputs", () => {
    const hidden = fixtureCopy();
    Object.defineProperty(hidden, "secret", { value: "credential" });
    expect(() => parseFrontendLabFixture(hidden)).toThrow(
      "Frontend labs fixture must use exact fields",
    );

    const symbolic = fixtureCopy();
    Object.defineProperty(symbolic, Symbol("secret"), { value: "credential" });
    expect(() => parseFrontendLabFixture(symbolic)).toThrow(
      "Frontend labs fixture must not contain symbol fields",
    );

    const decorated = fixtureCopy();
    Object.defineProperty(decorated.workers as unknown[], "secret", {
      value: "credential",
    });
    expect(() => parseFrontendLabFixture(decorated)).toThrow(
      "List contains unsupported field secret",
    );

    const sparse = fixtureCopy();
    sparse.workers = new Array(1);
    expect(() => parseFrontendLabFixture(sparse)).toThrow("Lists must be dense");
  });

  test("rejects task and report ID accessors without invocation", () => {
    let taskReads = 0;
    const tasks = taskCopy();
    Object.defineProperty(tasks[0]!, "id", {
      enumerable: true,
      get() {
        taskReads += 1;
        return "human-decision";
      },
    });

    expect(() => parseFrontendLabTasks(tasks)).toThrow(
      "task 1 field id must be an enumerable data property",
    );
    expect(taskReads).toBe(0);

    let reportReads = 0;
    const reportIds = ["human-decision"];
    Object.defineProperty(reportIds, 0, {
      enumerable: true,
      get() {
        reportReads += 1;
        return "human-decision";
      },
    });

    expect(() => createFrontendLabReport(reportIds)).toThrow(
      "List entry 1 must be an enumerable data property",
    );
    expect(reportReads).toBe(0);
  });

  test("returns the same deeply frozen public contract for admitted data", () => {
    const fixture = parseFrontendLabFixture(fixtureCopy());
    const tasks = parseFrontendLabTasks(taskCopy());
    const report = createFrontendLabReport(tasks.map((task) => task.id));

    expect(fixture).toEqual(frontendLabFixture);
    expect(tasks).toEqual(frontendLabTasks);
    expect(Object.isFrozen(fixture)).toBe(true);
    expect(Object.isFrozen(fixture.workers)).toBe(true);
    expect(Object.isFrozen(fixture.workers[0])).toBe(true);
    expect(Object.isFrozen(tasks)).toBe(true);
    expect(Object.isFrozen(tasks[0])).toBe(true);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.tasks)).toBe(true);
  });
});
