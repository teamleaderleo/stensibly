import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderProjectContract } from "../src/project-contract.ts";

describe("project attachment import CLI", () => {
  test("fails closed on malformed success responses without printing the token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stensibly-attachment-cli-"));
    const contractPath = join(directory, "STENSIBLY.md");
    const token = "test-admin-token";
    let seenAuthorization: string | null = null;
    let seenMethod = "";

    await Bun.write(contractPath, renderProjectContract({
      version: 1,
      project: "scrapbook",
      repositories: ["teamleaderleo/stensibly"],
      runnerProfiles: ["codex-default"],
      concurrency: { project: 1, global: 1 },
      autonomousActions: ["inspect"],
      approvalRequired: ["merge"],
      checks: [],
      tags: [],
      relatedProjects: [],
    }, {
      goal: "Coordinate the scrapbook project.",
      boundaries: "Keep consequential effects approval-gated.",
      evidenceAndHandoff: "Attach evidence and leave an explicit next action.",
      escalation: "Escalate missing authority and ambiguous decisions.",
    }));

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        seenAuthorization = request.headers.get("authorization");
        seenMethod = request.method;
        const body = await request.json() as {
          sourceRevision?: unknown;
          snapshot?: { snapshotSha256?: unknown };
        };
        return Response.json({
          replayed: false,
          attachment: {
            project: "scrapbook",
            sourceRevision: body.sourceRevision,
            snapshot: { snapshotSha256: body.snapshot?.snapshotSha256 },
          },
        }, { status: 201 });
      },
    });

    try {
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          "run",
          "attach",
          "import",
          "--path",
          contractPath,
          "--endpoint",
          server.url.origin,
          "--source-revision",
          "abcdef1",
          "--accept-authority-widening",
        ],
        cwd: process.cwd(),
        env: { ...process.env, STENSIBLY_TOKEN: token },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(exitCode).toBe(1);
      expect(seenMethod).toBe("PUT");
      expect(seenAuthorization).toBe(`Bearer ${token}`);
      expect(stdout).toBe("");
      expect(stderr).toContain("Attachment import returned an invalid success response");
      expect(`${stdout}\n${stderr}`).not.toContain(token);
    } finally {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
