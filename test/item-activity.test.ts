import { describe, expect, test } from "bun:test";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import { buildWorkspaceSurvey } from "../src/survey.ts";

const actor = { id: "agent-1", name: "Agent One", kind: "agent" as const };
const surveyTime = new Date("2026-07-25T12:00:00.000Z");

describe("SQLite item activity", () => {
  test("events and artifacts change survey fingerprints exactly once", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);

    try {
      const created = await ledger.createItem({
        project: "scrapbook",
        kind: "task",
        title: "Leave resumable evidence",
        nextAction: "Record progress.",
        priority: 60,
        actor,
      });
      const initialSurvey = buildWorkspaceSurvey(await ledger.listWork(), {
        now: surveyTime,
      });

      const eventInput = {
        id: created.id,
        actor,
        type: "item.progress",
        payload: { summary: "Mapped the current path." },
        idempotencyKey: "progress-1",
      };
      await ledger.recordEvent(eventInput);
      const afterEvent = (await ledger.getItem(created.id)).item;
      expect(afterEvent).toMatchObject({
        status: created.status,
        claimedBy: created.claimedBy,
        claimExpiresAt: created.claimExpiresAt,
        summary: created.summary,
        nextAction: created.nextAction,
        version: created.version + 1,
      });
      const eventSurvey = buildWorkspaceSurvey(await ledger.listWork(), {
        now: surveyTime,
        previousFingerprint: initialSurvey.fingerprint,
      });
      expect(eventSurvey.changed).toBe(true);

      await ledger.recordEvent(eventInput);
      const afterEventReplay = (await ledger.getItem(created.id)).item;
      expect(afterEventReplay.version).toBe(afterEvent.version);

      const artifactInput = {
        id: created.id,
        actor,
        kind: "commit" as const,
        label: "Implementation commit",
        uri: "git:teamleaderleo/stensibly@deadbeef",
        metadata: { sha: "deadbeef" },
        idempotencyKey: "artifact-1",
      };
      await ledger.attachArtifact(artifactInput);
      const afterArtifact = (await ledger.getItem(created.id)).item;
      expect(afterArtifact).toMatchObject({
        status: created.status,
        claimedBy: created.claimedBy,
        claimExpiresAt: created.claimExpiresAt,
        summary: created.summary,
        nextAction: created.nextAction,
        version: afterEvent.version + 1,
      });
      const artifactSurvey = buildWorkspaceSurvey(await ledger.listWork(), {
        now: surveyTime,
        previousFingerprint: eventSurvey.fingerprint,
      });
      expect(artifactSurvey.changed).toBe(true);

      await ledger.attachArtifact(artifactInput);
      const afterArtifactReplay = (await ledger.getItem(created.id)).item;
      expect(afterArtifactReplay.version).toBe(afterArtifact.version);
    } finally {
      store.close();
    }
  });
});
