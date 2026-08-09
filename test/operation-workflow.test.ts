import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitOperationWorkflow, assertOperationWorkflowTransition } from "../src/operation-workflow-admission.js";
import { buildOperationWorkflow, reserveOperationWorkflowStep, settleOperationWorkflowStep } from "../src/operation-workflow-machine.js";
import { SqliteOperationWorkflowStore } from "../src/operation-workflow-sqlite-store.js";
import { StensiblyStore } from "../src/store.js";

const at = (second: number) => `2026-08-10T00:00:${String(second).padStart(2, "0")}.000Z`;
const sha = (digit: string) => `sha256:${digit.repeat(64)}`;

function workflow(id = "opw_one") {
  return buildOperationWorkflow({
    id,
    project: "stensibly",
    itemId: "item_154",
    runId: "run_keel",
    actorId: "agent_keel",
    clientId: "codex",
    kind: "github_publish_change",
    target: "teamleaderleo/stensibly:refs/heads/codex/test",
    request: { revision: sha("1") },
    idempotencyKey: "publish_change:test",
    authorityFence: {
      resource: "run:run_keel:generation:1",
      holderId: "agent_keel",
      generation: 1,
      expiresAt: at(59),
    },
    steps: [
      {
        kind: "github_create_branch",
        command: { branch: "codex/test", from: "a".repeat(40) },
        compensation: {
          disposition: "conditionally_reversible",
          kind: "github_delete_branch_if_exact",
          command: { branch: "codex/test", expectedSha: "a".repeat(40) },
        },
      },
      {
        kind: "github_create_file",
        command: { path: "notes/test.md", contentSha256: sha("2") },
        compensation: {
          disposition: "compensatable",
          kind: "github_revert_commit",
          command: { expectedParent: "a".repeat(40) },
        },
      },
      {
        kind: "github_create_pull_request",
        command: { head: "codex/test", base: "main" },
        compensation: {
          disposition: "conditionally_reversible",
          kind: "github_close_pull_request_if_open",
          command: { head: "codex/test", base: "main" },
        },
      },
    ],
    now: at(0),
  });
}

describe("operation workflow", () => {
  test("reserves before dispatch and advances one verified step at a time", () => {
    const initial = workflow();
    const reserved = reserveOperationWorkflowStep(initial, initial.steps[0]!.id, at(1));
    expect(reserved.state).toBe("running");
    expect(reserved.steps[0]!.state).toBe("dispatch_reserved");
    const verified = settleOperationWorkflowStep(reserved, {
      stepId: reserved.steps[0]!.id,
      outcome: "verified",
      settledAt: at(2),
      providerReceiptRef: "github-receipt:branch",
      before: { absent: true },
      after: { sha: "a".repeat(40) },
      verification: { source: "github_readback" },
    });
    expect(verified.state).toBe("running");
    expect(verified.steps[0]!.state).toBe("verified");
    expect(() => reserveOperationWorkflowStep(verified, verified.steps[2]!.id, at(3))).toThrow(
      "Operation workflow steps must dispatch in order",
    );
  });

  test("ambiguous provider outcome blocks every later dispatch", () => {
    const initial = workflow();
    const reserved = reserveOperationWorkflowStep(initial, initial.steps[0]!.id, at(1));
    const pending = settleOperationWorkflowStep(reserved, {
      stepId: reserved.steps[0]!.id,
      outcome: "pending_reconciliation",
      settledAt: at(2),
      providerReceiptRef: "github-receipt:branch",
      errorCode: "github_branch_outcome_ambiguous",
    });
    expect(pending.state).toBe("waiting_reconciliation");
    expect(pending.recovery.nextAction).toBe("reconcile_current_step");
    expect(() => reserveOperationWorkflowStep(pending, pending.steps[1]!.id, at(3))).toThrow(
      "Operation workflow requires reconciliation before dispatch",
    );
  });

  test("rejects authority drift, invented evidence, and compensation mutation", () => {
    const initial = workflow();
    expect(() => buildOperationWorkflow({
      project: "stensibly",
      itemId: "item_154",
      runId: "run_keel",
      actorId: "agent_keel",
      clientId: "codex",
      kind: "github_publish_change",
      target: "teamleaderleo/stensibly:refs/heads/codex/test",
      request: {},
      idempotencyKey: "authority-drift",
      authorityFence: { ...initial.steps[0]!.authorityFence, holderId: "agent_other" },
      steps: [{
        kind: "github_create_branch",
        command: {},
        compensation: { disposition: "irreversible" },
      }],
      now: at(0),
    })).toThrow("Operation workflow authority must bind its actor");

    const reserved = reserveOperationWorkflowStep(initial, initial.steps[0]!.id, at(1));
    const hostile = {
      ...reserved,
      revision: reserved.revision + 1,
      state: "waiting_reconciliation" as const,
      updatedAt: at(2),
      recovery: { nextAction: "reconcile_current_step" as const },
      steps: reserved.steps.map((step, index) => index === 0 ? {
        ...step,
        state: "pending_reconciliation" as const,
        settledAt: at(2),
        afterSha256: sha("e"),
        errorCode: "ambiguous",
        retry: "reconcile_before_retry" as const,
        compensation: { ...step.compensation, state: "reserved" as const },
      } : step),
    };
    expect(() => assertOperationWorkflowTransition(reserved, hostile)).toThrow();
  });

  test("rejects accessor-backed records without invoking caller code", () => {
    const initial = workflow();
    let invoked = false;
    const hostile = { ...initial } as Record<string, unknown>;
    Object.defineProperty(hostile, "target", {
      enumerable: true,
      get() {
        invoked = true;
        return initial.target;
      },
    });
    expect(() => admitOperationWorkflow(hostile)).toThrow("Operation workflow record is invalid");
    expect(invoked).toBe(false);
  });

  test("keeps partial completion compensatable until verified effects are reversed", () => {
    const firstReserved = reserveOperationWorkflowStep(workflow(), "opw_one:step:1", at(1));
    const firstVerified = settleOperationWorkflowStep(firstReserved, {
      stepId: firstReserved.steps[0]!.id,
      outcome: "verified",
      settledAt: at(2),
      providerReceiptRef: "github-receipt:branch",
      before: { absent: true },
      after: { sha: "a".repeat(40) },
      verification: { source: "github_readback" },
    });
    const secondReserved = reserveOperationWorkflowStep(firstVerified, firstVerified.steps[1]!.id, at(3));
    const partial = settleOperationWorkflowStep(secondReserved, {
      stepId: secondReserved.steps[1]!.id,
      outcome: "rejected",
      settledAt: at(4),
      errorCode: "github_file_write_rejected",
    });
    expect(partial).toMatchObject({
      state: "partially_completed",
      terminalAt: null,
      recovery: { nextAction: "compensate_completed_steps" },
    });
    const compensating = admitOperationWorkflow({
      ...partial,
      revision: partial.revision + 1,
      state: "compensating",
      updatedAt: at(5),
      recovery: { nextAction: "continue" },
      steps: partial.steps.map((step, index) => index === 0 ? {
        ...step,
        state: "compensating",
        compensation: { ...step.compensation, state: "reserved" },
      } : step),
    });
    expect(() => assertOperationWorkflowTransition(partial, compensating)).not.toThrow();
  });

  test("SQLite reservation replays exact intent and conflicts on altered intent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "operation-workflow-"));
    const store = new StensiblyStore(join(directory, "db.sqlite"));
    store.createItem({ project: "stensibly", kind: "task", title: "Fixture", priority: 50 });
    const workflows = new SqliteOperationWorkflowStore(store);
    const initial = workflow();
    expect((await workflows.reserveOperationWorkflow(initial)).outcome).toBe("reserved");
    const rebuilt = workflow("opw_rebuilt");
    const replay = await workflows.reserveOperationWorkflow(rebuilt);
    expect(replay.outcome).toBe("replay");
    expect(replay.workflow.id).toBe("opw_one");
    const renewedAuthority = {
      ...rebuilt,
      steps: rebuilt.steps.map((step) => ({
        ...step,
        authorityFence: { ...step.authorityFence, expiresAt: "2026-08-10T00:01:59.000Z" },
      })),
    };
    expect((await workflows.reserveOperationWorkflow(renewedAuthority)).outcome).toBe("replay");
    const altered = { ...rebuilt, requestSha256: sha("f") };
    expect((await workflows.reserveOperationWorkflow(altered)).outcome).toBe("conflict");
    store.close();
  });

  test("SQLite compare-and-swap rejects stale transitions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "operation-workflow-cas-"));
    const store = new StensiblyStore(join(directory, "db.sqlite"));
    store.createItem({ project: "stensibly", kind: "task", title: "Fixture", priority: 50 });
    const workflows = new SqliteOperationWorkflowStore(store);
    const initial = workflow();
    await workflows.reserveOperationWorkflow(initial);
    const reserved = reserveOperationWorkflowStep(initial, initial.steps[0]!.id, at(1));
    await workflows.transitionOperationWorkflow({ current: initial, next: reserved });
    await expect(workflows.transitionOperationWorkflow({ current: initial, next: reserved })).rejects.toThrow(
      "Operation workflow storage failed",
    );
    store.close();
  });

  test("SQLite external-ID conflicts do not disclose another project workflow", async () => {
    const directory = mkdtempSync(join(tmpdir(), "operation-workflow-isolation-"));
    const store = new StensiblyStore(join(directory, "db.sqlite"));
    store.createItem({ project: "stensibly", kind: "task", title: "Fixture", priority: 50 });
    store.createItem({ project: "another", kind: "task", title: "Fixture", priority: 50 });
    const workflows = new SqliteOperationWorkflowStore(store);
    const original = workflow("opw_shared");
    await workflows.reserveOperationWorkflow(original);
    const other = { ...workflow("opw_shared"), project: "another", idempotencyKey: "another:key" };
    const conflict = await workflows.reserveOperationWorkflow(other);
    expect(conflict.outcome).toBe("conflict");
    expect(conflict.workflow.project).toBe("another");
    expect(JSON.stringify(conflict.workflow)).not.toContain("publish_change:test");
    store.close();
  });
});
