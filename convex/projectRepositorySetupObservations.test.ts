import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "project-repository-setup-observation-test-secret";
const workspace = "test";
const project = "scrapbook";
const getCurrentRef = makeFunctionReference<"query">(
  "projectRepositorySetupObservations:getCurrent",
);
const recordRef = makeFunctionReference<"mutation">(
  "projectRepositorySetupObservations:record",
);

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("Convex pre-attachment repository setup observations", () => {
  test("records, exactly replays, replaces, and retains append-only history", async () => {
    const t = convexTest(schema, modules);
    const base = Date.parse("2026-08-10T01:10:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      await seedProject(t, base);
      const first = await record(t, {
        externalId: "repo_setup_first123",
        defaultBranch: "main",
      });
      expect(first).toMatchObject({
        replayed: false,
        replacedObservationId: null,
        observation: {
          id: "repo_setup_first123",
          project,
          repositoryFullName: "teamleaderleo/scrapbook",
          defaultBranch: "main",
          sourceKind: "github_conversation_context",
          authorizesProviderEffect: false,
          containsSecrets: false,
        },
      });

      const replay = await record(t, {
        externalId: "repo_setup_unused_replay",
        defaultBranch: "main",
      });
      expect(replay).toEqual({
        observation: first.observation,
        replayed: true,
        replacedObservationId: null,
      });

      clock.mockReturnValue(base + 60_000);
      const second = await record(t, {
        externalId: "repo_setup_second12",
        defaultBranch: "develop",
      });
      expect(second).toMatchObject({
        replayed: false,
        replacedObservationId: "repo_setup_first123",
        observation: {
          id: "repo_setup_second12",
          defaultBranch: "develop",
        },
      });
      expect(await t.query(getCurrentRef, {
        serviceSecret,
        workspace,
        project,
      })).toEqual(second.observation);

      const rows = await t.run(async (ctx) => await ctx.db
        .query("projectRepositorySetupObservations")
        .collect());
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.externalId).sort()).toEqual([
        "repo_setup_first123",
        "repo_setup_second12",
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  test("keeps observations isolated by workspace and project", async () => {
    const t = convexTest(schema, modules);
    const base = Date.parse("2026-08-10T01:20:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      await seedProject(t, base);
      await record(t, {
        externalId: "repo_setup_isolated1",
        defaultBranch: "main",
      });
      expect(await t.query(getCurrentRef, {
        serviceSecret,
        workspace: "other",
        project,
      })).toBeNull();
      expect(await t.query(getCurrentRef, {
        serviceSecret,
        workspace,
        project: "other",
      })).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });
});

async function seedProject(
  t: ReturnType<typeof convexTest>,
  now: number,
): Promise<void> {
  await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      externalId: "workspace_test",
      slug: workspace,
      name: "Test workspace",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("projects", {
      workspaceId,
      externalId: "project_scrapbook",
      slug: project,
      name: "Scrapbook",
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function record(
  t: ReturnType<typeof convexTest>,
  input: { externalId: string; defaultBranch: string },
) {
  return await t.mutation(recordRef, {
    serviceSecret,
    workspace,
    project,
    repositoryFullName: "teamleaderleo/scrapbook",
    defaultBranch: input.defaultBranch,
    sourceKind: "github_conversation_context",
    externalId: input.externalId,
  }) as any;
}
