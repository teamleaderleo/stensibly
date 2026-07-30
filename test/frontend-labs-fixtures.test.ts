import { describe, expect, test } from "bun:test";
import { createFrontendLabReport, frontendLabFixture, frontendLabTasks, parseFrontendLabFixture, parseFrontendLabTasks } from "../site/labs/fixtures.js";

function cloneFixture() { return JSON.parse(JSON.stringify(frontendLabFixture)); }
function cloneTasks() { return JSON.parse(JSON.stringify(frontendLabTasks)); }

describe("frontend labs shared fixtures", () => {
  test("publishes fictional bounded records for the shared operator tasks", () => {
    expect(frontendLabFixture.project.id).toBe("paper-lantern");
    expect(frontendLabFixture.decision.id).toBe("approve-release-note");
    expect(frontendLabFixture.workers.map((worker) => worker.state)).toEqual(["healthy", "unhealthy"]);
    expect(frontendLabFixture.readyWork[0]).toMatchObject({ id: "repair-focus-order", rank: 1, state: "ready" });
    expect(frontendLabFixture.operations.some((operation) => operation.state === "ambiguous")).toBe(true);
    expect(frontendLabFixture.connections.map((connection) => connection.state)).toEqual(["healthy", "reconnecting", "offline"]);
    expect(frontendLabTasks.map((task) => task.id)).toEqual(["human-decision", "worker-health", "recommended-work", "safe-reconciliation", "connection-health"]);
    expect(Object.isFrozen(frontendLabFixture)).toBe(true);
    expect(Object.isFrozen(frontendLabFixture.operations)).toBe(true);
  });

  test("rejects unknown fixture and task fields", () => {
    const fixture = cloneFixture();
    fixture.secret = "no";
    expect(() => parseFrontendLabFixture(fixture)).toThrow("exact fields");
    const tasks = cloneTasks();
    tasks[0].selector = ".button";
    expect(() => parseFrontendLabTasks(tasks)).toThrow("exact fields");
  });

  test("rejects unsupported states, unsafe text, and oversized collections", () => {
    const fixture = cloneFixture();
    fixture.operations[0].state = "sparkly";
    expect(() => parseFrontendLabFixture(fixture)).toThrow("Unsupported state");
    const unsafe = cloneFixture();
    unsafe.project.name = "Paper\u202eLantern";
    expect(() => parseFrontendLabFixture(unsafe)).toThrow("safe characters");
    const oversized = cloneFixture();
    oversized.workers = Array.from({ length: 9 }, (_, index) => ({ id: `worker-${index}`, state: "healthy", label: `Worker ${index}`, detail: "Fictional worker." }));
    expect(() => parseFrontendLabFixture(oversized)).toThrow("1-8 entries");
  });

  test("creates an in-memory report with the shared usability measures", () => {
    const report = createFrontendLabReport(["human-decision", "safe-reconciliation"]);
    expect(report).toEqual({ version: 1, tasks: [
      { taskId: "human-decision", elapsedMs: null, wrongTurns: 0, scrollDistance: 0, targetMisses: 0, terminologyConfusion: "", comfort: "", delight: "" },
      { taskId: "safe-reconciliation", elapsedMs: null, wrongTurns: 0, scrollDistance: 0, targetMisses: 0, terminologyConfusion: "", comfort: "", delight: "" },
    ] });
    expect(Object.isFrozen(report.tasks)).toBe(true);
    expect(() => createFrontendLabReport(["unknown-task"])).toThrow("Unknown report task");
  });
});
