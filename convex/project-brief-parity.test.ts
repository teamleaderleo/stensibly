import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "project-brief-test-secret";
const workspace = "test";
const now = Date.parse("2026-07-25T14:00:00.000Z");
const actor = { id: "agent-1", name: "Agent One", kind: "agent" as const };

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("hosted project brief parity", () => {
  test("matches the public SQLite/dashboard contract with deterministic time", async () => {
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
      serviceSecret,
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
      serviceSecret,
      workspace,
      project: "scrapbook",
      limit: 10,
      now,
    }) as any;

    expect(brief).toMatchObject({
      workspace,
      project: "scrapbook",
      generatedAt: "2026-07-25T14:00:00.000Z",
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
    expect(brief.activeRuns).toEqual([]);
    expect(brief.activeReservations).toEqual([]);
  });

  test("rejects unknown workspaces and projects with the public not-found message", async () => {
    const t = convexTest(schema, modules);
    await createItem(t, {
      title: "Create the workspace",
      kind: "task",
      priority: 50,
      nextAction: "Check missing project handling.",
    });

    await expect(t.query(convexApi.projects.brief, {
      serviceSecret,
      workspace,
      project: "missing",
      limit: 10,
      now,
    })).rejects.toThrow("Project missing does not exist");

    await expect(t.query(convexApi.projects.brief, {
      serviceSecret,
      workspace: "missing-workspace",
      project: "scrapbook",
      limit: 10,
      now,
    })).rejects.toThrow("Project scrapbook does not exist");
  });

  test("validates direct query limits and trusted timestamps", async () => {
    const t = convexTest(schema, modules);
    await createItem(t, {
      title: "Validate hosted inputs",
      kind: "task",
      priority: 50,
      nextAction: "Reject invalid brief arguments.",
    });

    await expect(t.query(convexApi.projects.brief, {
      serviceSecret,
      workspace,
      project: "scrapbook",
      limit: 0,
      now,
    })).rejects.toThrow("Brief limit must be between 1 and 100");

    await expect(t.query(convexApi.projects.brief, {
      serviceSecret,
      workspace,
      project: "scrapbook",
      limit: 10,
      now: -1,
    })).rejects.toThrow("Brief time must be a valid Unix timestamp");
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
    serviceSecret,
    workspace,
    project: "scrapbook",
    actor,
    ...input,
  }) as any;
}
