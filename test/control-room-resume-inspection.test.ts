import { describe, expect, test } from "bun:test";
import { assembleControlRoomResumeInspectionV1 } from "../src/control-room-resume-inspection.ts";
import { dispatchNextWork } from "../src/dispatcher.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const supervisor = {
  id: "service:resume-inspection-supervisor",
  name: "Resume Inspection Supervisor",
  kind: "service" as const,
};
const runner = {
  id: "agent:resume-inspection-runner",
  name: "Resume Inspection Runner",
  kind: "agent" as const,
};

describe("Control Room resume inspection assembly", () => {
  test("surfaces durable checkpoint and interruption evidence without granting resume authority", async () => {
    const fixture = await claimedFixture("resume_evidence");
    try {
      const checkpoint = {
        version: 1 as const,
        kind: "checkpoint" as const,
        adapterId: "vercel-ai-sdk",
        externalId: "checkpoint-42",
        digest: `sha256:${"c".repeat(64)}`,
        uri: "file:///tmp/checkpoint-42.json",
        generation: 1,
        createdAt: "2026-08-15T00:00:00.000Z",
        accessClass: "project" as const,
        containsPrivateContent: false as const,
        containsCredentials: false as const,
      };
      fixture.store.db.query(`
        UPDATE work_runs
        SET checkpoint = ?1, continuation_ref = ?2
        WHERE id = ?3
      `).run(JSON.stringify(checkpoint), "continuation-42", fixture.run.id);

      const reservation = await fixture.ledger.reserveRunnerAdapterCommand({
        project: "resume_evidence",
        itemId: fixture.itemId,
        runId: fixture.run.id,
        runGeneration: fixture.run.generation,
        leaseGeneration: fixture.run.leaseGeneration,
        actor: runner,
        adapterId: "vercel-ai-sdk",
        profileId: "default",
        requestFingerprint: `sha256:${"a".repeat(64)}`,
        commandId: "resume-evidence-command",
        commandFingerprint: `sha256:${"b".repeat(64)}`,
        idempotencyKey: "resume-evidence-command-key",
      });
      await fixture.ledger.settleRunnerAdapterCommand({
        commandId: reservation.command.commandId,
        commandFingerprint: reservation.command.commandFingerprint,
        outcome: {
          version: 1,
          kind: "bounded_episode_completed",
          observationCount: 1,
          observationsSha256: `sha256:${"d".repeat(64)}`,
          terminalObservationId: "resume-interrupted",
          terminalObservationType: "interrupted",
          latestCheckpointExternalId: checkpoint.externalId,
          latestCheckpointSha256: checkpoint.digest,
          containsPrivateContent: false,
          containsCredentials: false,
        },
      });

      const inspection = assembleControlRoomResumeInspectionV1(fixture.store, fixture.run.id);
      expect(inspection).toMatchObject({
        version: 1,
        runId: fixture.run.id,
        project: "resume_evidence",
        decision: "unknown",
        checkpoint,
        priorCommandId: "resume-evidence-command",
        priorCommandSettled: true,
        interruptionObserved: true,
        currentAuthorityPresent: true,
        continuationRef: "continuation-42",
        authorizesMutation: false,
        authorizesResume: false,
      });
      expect(inspection.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "checkpoint-reference", state: "pass" }),
        expect.objectContaining({ id: "interruption-evidence", state: "pass" }),
        expect.objectContaining({ id: "continuation", state: "pass" }),
        expect.objectContaining({ id: "current-capability-binding", state: "unknown" }),
        expect.objectContaining({ id: "authoritative-command", state: "unknown" }),
      ]));
      expect(Object.isFrozen(inspection)).toBe(true);
      expect(Object.isFrozen(inspection.checks)).toBe(true);
    } finally {
      fixture.store.close();
    }
  });

  test("blocks malformed checkpoint text and keeps the receipt read-only", async () => {
    const fixture = await claimedFixture("resume_bad_checkpoint");
    try {
      fixture.store.db.query(`UPDATE work_runs SET checkpoint = ?1 WHERE id = ?2`)
        .run("definitely-not-a-checkpoint", fixture.run.id);
      const inspection = assembleControlRoomResumeInspectionV1(fixture.store, fixture.run.id);
      expect(inspection.decision).toBe("blocked");
      expect(inspection.checkpoint).toBeNull();
      expect(inspection.authorizesMutation).toBe(false);
      expect(inspection.authorizesResume).toBe(false);
      expect(inspection.checks).toContainEqual(expect.objectContaining({
        id: "checkpoint-reference",
        state: "blocked",
      }));
    } finally {
      fixture.store.close();
    }
  });
});

async function claimedFixture(project: string) {
  const store = new StensiblyStore(":memory:");
  const ledger = new SqliteWorkLedger(store);
  const item = store.createItem({
    project,
    kind: "task",
    title: "Inspect durable resume evidence",
    priority: 80,
    actor: supervisor,
  });
  const dispatched = dispatchNextWork(store, {
    actor: supervisor,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    itemId: item.id,
    leaseSeconds: 900,
    idempotencyKey: `dispatch-${project}`,
  });
  if (!dispatched) throw new Error("Resume inspection fixture did not dispatch");
  const run = await ledger.claimRunnerWork({
    actor: runner,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    project,
    runId: dispatched.run.id,
    leaseSeconds: 900,
    idempotencyKey: `claim-${project}`,
  });
  if (!run) throw new Error("Resume inspection fixture was not claimed");
  return { store, ledger, itemId: item.id, run };
}
