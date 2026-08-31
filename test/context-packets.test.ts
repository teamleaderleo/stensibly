import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { attachArtifact, listArtifacts } from "../src/artifacts.ts";
import {
  buildRunnerContextPacket,
  getRunnerContextPacket,
} from "../src/context-packets.ts";
import { projectItemControl } from "../src/item-control.ts";
import { createWorkRun } from "../src/runs.ts";
import { createApiToken } from "../src/auth.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };
const runner = { id: "runner", name: "Runner", kind: "agent" as const };
const generatedAt = new Date("2026-07-25T12:00:00.000Z");

let store: StensiblyStore;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
});

afterEach(() => store.close());

describe("runner context packets", () => {
  test("preserves protected context, redacts credentials, and enforces tight bounds", async () => {
    const item = store.createItem({
      project: "studio",
      kind: "task",
      title: "Ship the runner handoff",
      summary: `Use Bearer very-secret-token and ${"context ".repeat(900)}`,
      nextAction: "Resolve the product decision before launch.",
      priority: 80,
      actor: leo,
    });
    const decision = store.recordEvent({
      itemId: item.id,
      actor: leo,
      type: "decision.requested",
      payload: {
        question: "Which launch profile should the runner use?",
        apiKey: "sk-proj-this-must-not-leak",
      },
    });
    for (let index = 0; index < 5; index += 1) {
      store.recordEvent({
        itemId: item.id,
        actor: runner,
        type: "progress.recorded",
        payload: { index, note: "ordinary progress" },
      });
    }
    attachArtifact(store, {
      itemId: item.id,
      actor: runner,
      kind: "url",
      label: "Protected preview",
      uri: "https://user:password@example.test/preview",
      metadata: { token: "ghp_this_must_not_leak" },
    });
    createWorkRun(store, {
      itemId: item.id,
      actor: runner,
      runnerType: "generic-mcp",
      runnerProfile: "default",
    }, generatedAt);

    const ledger = new SqliteWorkLedger(store);
    const packet = await getRunnerContextPacket(ledger, item.id, {
      maxEvents: 2,
      maxCharacters: 5_000,
      now: generatedAt,
    });

    expect(packet.generatedAt).toBe(generatedAt.toISOString());
    expect(packet.packetFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(packet.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: decision.id, protected: true }),
    ]));
    expect(packet.events.filter((event) => !event.protected)).toHaveLength(1);
    expect(packet.runs).toEqual([
      expect.objectContaining({ runnerType: "generic-mcp", runnerProfile: "default" }),
    ]);
    expect(JSON.stringify(packet)).not.toContain("very-secret-token");
    expect(JSON.stringify(packet)).not.toContain("sk-proj-this-must-not-leak");
    expect(JSON.stringify(packet)).not.toContain("ghp_this_must_not_leak");
    expect(packet.artifacts[0]?.uri).toContain("[REDACTED]");
    expect(packet.sourceReferences).toContain(`event:${decision.id}`);
    expect(packet.characterCount).toBeLessThanOrEqual(5_000);
    expect(JSON.stringify(packet).length).toBe(packet.characterCount);

    const tightPacket = await getRunnerContextPacket(ledger, item.id, {
      maxEvents: 2,
      maxCharacters: 2_000,
      now: generatedAt,
    });
    expect(tightPacket.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: decision.id, protected: true }),
    ]));
    expect(tightPacket.characterCount).toBeLessThanOrEqual(2_000);
    expect(JSON.stringify(tightPacket).length).toBe(tightPacket.characterCount);
    expect(Object.values(tightPacket.omitted).some((count) => count > 0)).toBe(true);
  });

  test("builds deterministic packets from the same canonical detail", () => {
    const item = store.createItem({
      project: "studio",
      kind: "handoff",
      title: "Continue from canonical state",
      summary: "The durable state is authoritative.",
      nextAction: "Read the packet and continue.",
      priority: 50,
      actor: leo,
    });
    const detail = {
      item,
      control: projectItemControl({ item, now: generatedAt }),
      events: store.listEvents(item.id),
      artifacts: [],
      runs: [],
      dependencies: [{
        direction: "outgoing",
        kind: "blocks",
        itemId: "item_dependency",
        createdAt: "2026-07-25T10:00:00.000Z",
      }],
    };

    const first = buildRunnerContextPacket(detail, { now: generatedAt });
    const second = buildRunnerContextPacket(detail, { now: generatedAt });
    expect(second).toEqual(first);
    expect(second.packetFingerprint).toBe(first.packetFingerprint);
    expect(first.sourceReferences).toContain("dependency:item_dependency");
  });

  test("derives a stable canonical timestamp and compacts runner receipts", () => {
    const item = store.createItem({
      project: "glaeda",
      kind: "task",
      title: "Read one exact owned-workstation result",
      priority: 50,
      actor: leo,
    });
    const receiptDigest = `sha256:${"3".repeat(64)}`;
    const run = {
      id: "run_air_blue",
      itemId: item.id,
      actorId: "service:air-blue-glaeda",
      runnerType: "glaeda-workstation",
      runnerProfile: "repo-query/v1",
      runnerProfileVersion: `sha256:${"4".repeat(64)}`,
      externalRunId: "glaeda:air-blue:request",
      status: "succeeded",
      generation: 4,
      leaseGeneration: 2,
      leaseOwnerId: null,
      leaseExpiresAt: null,
      checkpoint: "Admitted exact request.",
      outcome: `Glaeda repo-query/v1 succeeded with bounded result ${receiptDigest}.`,
      continuationRef: `https://github.com/teamleaderleo/glaeda-dispatch/commit/${"5".repeat(40)}`,
      usage: { toolCalls: 7 },
      executionEnvelope: { objective: "This verbose envelope is not needed in a receipt read." },
      executionRecords: [{ transition: "succeed", actual: { filesChanged: 0, toolCalls: 7 } }],
      createdAt: "2026-09-01T05:26:26.210Z",
      updatedAt: "2026-09-01T05:26:47.551Z",
      startedAt: "2026-09-01T05:26:40.293Z",
      endedAt: "2026-09-01T05:26:47.551Z",
    };
    const detail = {
      item,
      control: projectItemControl({ item, now: generatedAt }),
      events: store.listEvents(item.id),
      artifacts: [{
        id: "artifact_verbose_history",
        itemId: item.id,
        actorId: runner.id,
        kind: "log" as const,
        label: "Verbose historical log",
        uri: "urn:test:verbose-log",
        mimeType: "text/plain",
        metadata: { note: "historical ".repeat(400) },
        createdAt: "2026-08-31T05:26:30.000Z",
      }],
      runs: [run],
      dependencies: [],
    };

    const first = buildRunnerContextPacket(detail, { maxCharacters: 2_500 });
    const second = buildRunnerContextPacket(detail, { maxCharacters: 2_500 });
    expect(second).toEqual(first);
    expect(first.generatedAt).toBe(run.endedAt);
    expect(first.runs[0]).toEqual(expect.objectContaining({
      id: run.id,
      actorId: run.actorId,
      runnerProfile: run.runnerProfile,
      runnerProfileVersion: run.runnerProfileVersion,
      outcome: run.outcome,
      continuationRef: run.continuationRef,
    }));
    expect(first.runs[0]).not.toHaveProperty("executionEnvelope");
    expect(JSON.stringify(first)).toContain(receiptDigest);
    expect(first.characterCount).toBeLessThanOrEqual(2_500);
    expect(first.omitted.artifacts).toBe(1);
    expect(first.omitted.runs).toBe(0);
  });

  test("preserves one bounded Glaeda capability artifact without depth truncation", () => {
    const item = store.createItem({
      project: "glaeda",
      kind: "task",
      title: "Run one exact owned-workstation query",
      priority: 50,
      actor: leo,
    });
    const snapshot = {
      admission: {
        activeWorkloadsClass: "unobserved",
        availabilityClass: "available",
        pressureClass: "unobserved",
      },
      advisoryOnly: true,
      authorizesDispatch: false,
      authorizesExecution: false,
      expiresAt: "2026-08-31T05:03:00.000Z",
      node: { architectureClass: "arm64", generation: 1, id: "air-blue", osClass: "macos" },
      observedAt: "2026-08-31T05:00:00.000Z",
      producer: {
        glaedaRuntimeSha256: `sha256:${"a".repeat(64)}`,
        python: { executableSha256: `sha256:${"b".repeat(64)}`, version: "3.14.6" },
        workspaceCapabilitySha256: `sha256:${"c".repeat(64)}`,
      },
      profiles: [{ class: "repo_query", id: "repo-query/v1", versionSha256: `sha256:${"d".repeat(64)}` }],
      projects: [{
        heatClass: "resident_hot",
        repository: "teamleaderleo/glaeda",
        source: { commitOid: "1".repeat(40), treeOid: "2".repeat(40) },
        sourceObjectClass: "exact_commit_and_tree_present",
        verificationProfiles: ["glaeda.doctor", "glaeda.required"],
      }],
      schema: "glaeda-owned-workstation-capability/v1",
    };
    const metadata = {
      schema: "glaeda-owned-workstation-capability-artifact/v1",
      snapshot,
      snapshotSha256: `sha256:${"e".repeat(64)}`,
    };
    attachArtifact(store, {
      itemId: item.id,
      actor: runner,
      kind: "other",
      label: "Air Blue capability",
      uri: `urn:stensibly:glaeda-capability:${metadata.snapshotSha256}`,
      metadata,
    });

    const packet = buildRunnerContextPacket({
      item,
      control: projectItemControl({ item, now: generatedAt }),
      events: [],
      artifacts: listArtifacts(store, item.id),
      runs: [],
      dependencies: [],
    }, { now: generatedAt });

    expect(packet.artifacts[0]?.metadata).toEqual(metadata);
    expect(JSON.stringify(packet)).not.toContain("[TRUNCATED]");
  });

  test("serves scoped packets over REST and validates limits", async () => {
    const visible = store.createItem({
      project: "studio",
      kind: "task",
      title: "Visible context",
      priority: 50,
      actor: leo,
    });
    const hidden = store.createItem({
      project: "secret",
      kind: "task",
      title: "Hidden context",
      priority: 50,
      actor: leo,
    });
    const token = createApiToken(store, {
      name: "Studio reader",
      scopes: ["read"],
      projects: ["studio"],
    });
    const app = createServerApp(store, { httpAuth: { required: true } });

    const visibleResponse = await app.request(
      `/api/v1/items/${visible.id}/context?maxEvents=5&maxCharacters=3000`,
      { headers: bearer(token.token) },
    );
    expect(visibleResponse.status).toBe(200);
    const visibleBody = await visibleResponse.json() as { packet: { item: { id: string } } };
    expect(visibleBody.packet.item.id).toBe(visible.id);

    const denied = await app.request(`/api/v1/items/${hidden.id}/context`, {
      headers: bearer(token.token),
    });
    expect(denied.status).toBe(403);

    const invalid = await app.request(`/api/v1/items/${visible.id}/context?maxCharacters=100`, {
      headers: bearer(token.token),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "invalid_request" });
  });
});

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
