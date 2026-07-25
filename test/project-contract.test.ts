import { describe, expect, test } from "bun:test";
import {
  compareProjectAttachments,
  compileProjectContract,
  normalizeRepositoryRemote,
  parseProjectAttachmentSnapshot,
  projectSlugFromRepository,
  renderProjectContract,
} from "../src/project-contract.ts";

const baseContract = {
  version: 1 as const,
  project: "stensibly",
  repositories: ["teamleaderleo/stensibly"],
  runnerProfiles: ["codex-default"],
  concurrency: { project: 1, global: 1 },
  autonomousActions: ["inspect", "propose", "create_draft_pr"],
  approvalRequired: ["merge", "deploy", "external_message"],
  checks: ["bun run typecheck", "bun test"],
  tags: ["coordination"],
  relatedProjects: [],
};

const baseContext = {
  goal: "Make durable human-agent coordination trustworthy.",
  boundaries: "Keep repository changes reversible and approval-gate consequential effects.",
  evidenceAndHandoff: "Attach pull requests and checks, then leave an explicit next action.",
  escalation: "Escalate missing authority, credentials, and ambiguous product decisions.",
};

describe("repository project contracts", () => {
  test("renders and compiles one deterministic API attachment snapshot", () => {
    const markdown = renderProjectContract(baseContract, baseContext);
    const first = compileProjectContract(markdown);
    const second = compileProjectContract(markdown);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      format: "stensibly.project-attachment",
      schemaVersion: 1,
      contract: baseContract,
      context: baseContext,
      source: { path: "STENSIBLY.md" },
    });
    expect(first.source.contentSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.snapshotSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(parseProjectAttachmentSnapshot(JSON.parse(JSON.stringify(first)))).toEqual(first);
  });

  test("rejects ambiguous, malformed, and internally conflicting declarations", () => {
    const markdown = renderProjectContract(baseContract, baseContext);
    expect(() => compileProjectContract(`${markdown}\n\`\`\`stensibly\n{}\n\`\`\`\n`))
      .toThrow("exactly one fenced");
    expect(() => compileProjectContract(markdown.replace('"version": 1', '"version": 2')))
      .toThrow();
    expect(() => compileProjectContract(markdown.replace(
      '"create_draft_pr"',
      '"create_draft_pr",\n    "merge"',
    ))).toThrow("both autonomous and approval-required");
    expect(() => compileProjectContract(markdown.replace(
      '"global": 1',
      '"global": 1,\n    "unexpected": 2',
    ))).toThrow();
  });

  test("rejects credential-bearing repository identifiers before snapshot creation", () => {
    const markdown = renderProjectContract(baseContract, baseContext);
    const secret = "s3cr3t-value";
    const repositories = [
      `https://github.com/teamleaderleo/stensibly.git?token=${secret}`,
      `https://github.com/teamleaderleo/stensibly.git#${secret}`,
      `ssh://git@git.example.com/platform/stensibly.git?token=${secret}`,
      `ssh://git@git.example.com/platform/stensibly.git#${secret}`,
    ];

    for (const repository of repositories) {
      let caught: unknown;
      try {
        compileProjectContract(markdown.replace("teamleaderleo/stensibly", repository));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(String(caught)).not.toContain(secret);
    }
  });

  test("requires exactly one durable narrative section for each field", () => {
    const markdown = renderProjectContract(baseContract, baseContext);
    expect(() => compileProjectContract(markdown.replace(
      "## Escalation\n\nEscalate missing authority, credentials, and ambiguous product decisions.\n",
      "",
    ))).toThrow('missing the "Escalation" section');
    expect(() => compileProjectContract(markdown.replace(
      "## Goal\n\nMake durable human-agent coordination trustworthy.",
      "## Goal\n",
    ))).toThrow('"Goal" section must not be empty');
    expect(() => compileProjectContract(`${markdown}\n## Goal\n\nA second goal.\n`))
      .toThrow('more than one "Goal" section');
  });

  test("detects permission widening separately from ordinary context and source edits", () => {
    const previous = compileProjectContract(renderProjectContract(baseContract, baseContext));
    const widened = compileProjectContract(renderProjectContract({
      ...baseContract,
      repositories: [...baseContract.repositories, "teamleaderleo/another-repo"],
      concurrency: { project: 2, global: 2 },
      autonomousActions: [...baseContract.autonomousActions, "open_issue"],
      approvalRequired: baseContract.approvalRequired.filter((action) => action !== "merge"),
    }, {
      ...baseContext,
      goal: "Coordinate two repositories.",
    }), "config/STENSIBLY.md");

    const diff = compareProjectAttachments(previous, widened);
    expect(diff.widensAuthority).toBe(true);
    expect(diff.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "repositories", kind: "added", authorityEffect: "widens" }),
      expect.objectContaining({ field: "autonomousActions", kind: "added", authorityEffect: "widens" }),
      expect.objectContaining({ field: "approvalRequired", kind: "removed", authorityEffect: "widens" }),
      expect.objectContaining({ field: "concurrency.project", authorityEffect: "widens" }),
      expect.objectContaining({ field: "context.goal", authorityEffect: "neutral" }),
      expect.objectContaining({ field: "source.path", authorityEffect: "neutral" }),
      expect.objectContaining({ field: "source.contentSha256", authorityEffect: "neutral" }),
    ]));
  });

  test("rejects a snapshot whose canonical content was changed without a new hash", () => {
    const snapshot = compileProjectContract(renderProjectContract(baseContract, baseContext));
    const tampered = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    const contract = tampered.contract as Record<string, unknown>;
    contract.project = "tampered";
    expect(() => parseProjectAttachmentSnapshot(tampered)).toThrow("snapshot hash");
  });

  test("normalizes common Git remotes without copying embedded credentials", () => {
    expect(normalizeRepositoryRemote("git@github.com:teamleaderleo/stensibly.git"))
      .toBe("teamleaderleo/stensibly");
    expect(normalizeRepositoryRemote("https://github.com/teamleaderleo/stensibly.git"))
      .toBe("teamleaderleo/stensibly");
    expect(normalizeRepositoryRemote("ssh://git@git.example.com/platform/Project.git"))
      .toBe("ssh://git@git.example.com/platform/Project");
    expect(normalizeRepositoryRemote("https://token@github.com/teamleaderleo/stensibly.git"))
      .toBeNull();
    expect(normalizeRepositoryRemote("https://user:secret@example.com/project/repo.git"))
      .toBeNull();
    expect(normalizeRepositoryRemote("https://github.com/teamleaderleo/stensibly.git?token=secret"))
      .toBeNull();
    expect(normalizeRepositoryRemote("https://github.com/teamleaderleo/stensibly.git#secret"))
      .toBeNull();
    expect(normalizeRepositoryRemote("ssh://git@git.example.com/platform/Project.git?token=secret"))
      .toBeNull();
    expect(normalizeRepositoryRemote("git@git.example.com:platform/Project.git?token=secret"))
      .toBeNull();
    expect(normalizeRepositoryRemote("git@git.example.com:platform/Project.git#secret"))
      .toBeNull();
    expect(normalizeRepositoryRemote("file:///tmp/repository.git"))
      .toBeNull();
    expect(normalizeRepositoryRemote("not a repository"))
      .toBeNull();
    expect(projectSlugFromRepository("teamleaderleo/My_Project.git"))
      .toBe("my_project");
    expect(() => projectSlugFromRepository("https://github.com/teamleaderleo/stensibly.git?token=secret"))
      .toThrow("Cannot derive a project slug");
    expect(() => projectSlugFromRepository("git@git.example.com:platform/Project.git#secret"))
      .toThrow("Cannot derive a project slug");
  });
});
