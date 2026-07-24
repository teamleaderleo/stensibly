import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const actor = { id: "agent-1", name: "Agent One", kind: "agent" as const };
const zeroStatusCounts = { ready: 0, active: 0, blocked: 0, done: 0, archived: 0 };
const zeroKindCounts = { task: 0, finding: 0, question: 0, decision: 0, tip: 0, handoff: 0, note: 0 };

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret);
});

describe("hosted project brief parity", () => {
  test("matches the SQLite and dashboard core brief contract", async () => {
    const t = convexTest(schema, modules);
    const task = await createItem(t, {
      title: "Ship the dashboard",
      kind: "task",
      priority: 80,
      summary: "The write loop is complete.",
      nextAction: "Run the production verifier.",
    });
    const finding = await createItem(t, {
      title: "Document the hosted mismatch",
      kind: "finding",
      priority: 60,
      summary: "Convex and SQLite must return the same public brief.",
      nextAction: "Verify the corrected contract.",
    });
    await t.mutation(convexApi.artifacts.attach, {
      serviceSecret: secret,
      workspace,
      id: finding.id,
      actor,
      kind: "commit",
      label: "Parity fix",
      uri: "https://github.com/teamleaderleo/stensibly/commit/deadbeef",
      metadata: { sha: "deadbeef" },
      idempotencyKey: "brief-artifact",
    });

    const brief = await t.query(convexApi.projects.brief, {
      serviceSecret: secret,
      workspace,
      project: "scrapbook",
      limit: 10,
    }) as any;

    expect(brief).toMatchObject({
      project: "scrapbook",
      counts: {
        total: 2,
        byStatus: { ready: 2, active: 0, blocked: 0, done: 0, archived: 0 },
        byKind: {
          task: 1,
          finding: 1,
          question: 0,
          decision: 0,
          tip: 0,
          handoff: 0,
          note: 0,
        },
      },
    });
    expect(brief).toHaveProperty("knowledge");
    expect(brief).not.toHaveProperty("recentKnowledge");
    expect(brief.ready.map((item: any) => item.id)).toEqual([task.id, finding.id]);
    expect(brief.knowledge).toEqual([
      expect.objectContaining({ id: finding.id, kind: "finding", title: finding.title }),
    ]);
    expect(brief.recentArtifacts).toEqual([
      expect.objectContaining({
        itemId: finding.id,
        itemTitle: finding.title,
        actorId: actor.id,
        kind: "commit",
        label: "Parity fix",
      }),
    ]);
    expect(brief.recentArtifacts[0].itemId).not.toMatch(/^j[0-9a-z]+$/i);
    expect(Number.isNaN(Date.parse(brief.generatedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(brief.recentArtifacts[0].createdAt))).toBe(false);
  });

  test("returns the same zero-filled empty brief as SQLite for unknown projects", async () => {
    const t = convexTest(schema, modules);
    await createItem(t, {
      title: "Create the workspace",
      kind: "task",
      priority: 50,
      nextAction: "Check a missing project.",
    });

    for (const input of [
      { workspace, project: "missing" },
      { workspace: "missing-workspace", project: "scrapbook" },
    ]) {
      const brief = await t.query(convexApi.projects.brief, {
        serviceSecret: secret,
        ...input,
        limit: 10,
      }) as any;
      expect(brief).toMatchObject({
        project: input.project,
        counts: { total: 0, byStatus: zeroStatusCounts, byKind: zeroKindCounts },
        ready: [],
        active: [],
        blocked: [],
        knowledge: [],
        recentlyCompleted: [],
        recentArtifacts: [],
      });
      expect(Number.isNaN(Date.parse(brief.generatedAt))).toBe(false);
    }
  });
});

async function createItem(
  t: ReturnType<typeof convexTest>,
  input: {
    title: string;
    kind: "task" | "finding";
    priority: number;
    summary?: string;
    nextAction: string;
  },
) {
  return await t.mutation(convexApi.items.create, {
    serviceSecret: secret,
    workspace,
    project: "scrapbook",
    actor,
    ...input,
  }) as any;
}
