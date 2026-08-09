import { describe, expect, test } from "bun:test";
import {
  projectAttachmentRecovery,
} from "../src/project-attachment-setup-plan.ts";
import type { ProjectAttachmentRecord } from "../src/project-attachment-ledger.ts";
import {
  compileProjectContract,
  renderProjectContract,
} from "../src/project-contract.ts";

const scrapbookContext = {
  repositoryFullName: "teamleaderleo/scrapbook",
  defaultBranch: "main",
  runnerProfiles: ["codex-default"],
  workProfile: "draft_pr" as const,
  checks: ["bun run typecheck", "bun test"],
};

describe("project attachment setup recovery", () => {
  test("turns the Scrapbook missing-attachment dogfood case into one deterministic plan", () => {
    const plan = projectAttachmentRecovery("scrapbook", null, scrapbookContext);
    expect(plan).toMatchObject({
      version: 1,
      state: "attachment_required",
      project: "scrapbook",
      repository: {
        fullName: "teamleaderleo/scrapbook",
        defaultBranch: "main",
      },
      requested: {
        runnerProfiles: ["codex-default"],
        workProfile: "draft_pr",
        autonomousActions: [
          "inspect",
          "propose",
          "record_progress",
          "attach_artifact",
          "create_draft_pr",
        ],
        checks: ["bun run typecheck", "bun test"],
      },
      sourcePath: "STENSIBLY.md",
      nextAction: {
        kind: "review_and_accept_project_attachment",
        requiresAdmin: true,
        acceptAuthorityWidening: true,
      },
      verification: {
        acceptedAttachment: "get_project_attachment",
        repositoryMetadata: "get_repo",
        immutableFileRead: "fetch_file",
        immutableReadRef: "exact_commit_sha",
      },
      authorizesProviderEffect: false,
      containsSecrets: false,
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan && "repository" in plan ? plan.repository : null)).toBe(true);
  });

  test("requests bounded repository context when the caller has not supplied it yet", () => {
    expect(projectAttachmentRecovery("scrapbook", null)).toEqual({
      version: 1,
      state: "repository_context_required",
      nextAction: "provide_repository_context",
      requiredFields: [
        "repositoryFullName",
        "defaultBranch",
        "runnerProfiles",
        "workProfile",
        "checks",
      ],
      authorityNotice:
        "Repository context can prepare an attachment setup plan but cannot grant Stensibly authority.",
      authorizesProviderEffect: false,
      containsSecrets: false,
    });
  });

  test("keeps an existing accepted attachment authoritative", () => {
    const current = attachment();
    expect(projectAttachmentRecovery("scrapbook", current, scrapbookContext)).toBeNull();
  });

  test("keeps read-only and draft-PR profiles visibly distinct", () => {
    const readOnly = projectAttachmentRecovery("scrapbook", null, {
      ...scrapbookContext,
      workProfile: "read_only",
    });
    expect(readOnly && "requested" in readOnly
      ? readOnly.requested.autonomousActions
      : null).toEqual([
      "inspect",
      "propose",
      "record_progress",
      "attach_artifact",
    ]);
    const draft = projectAttachmentRecovery("scrapbook", null, scrapbookContext);
    expect(draft && "requested" in draft
      ? draft.requested.autonomousActions
      : null).toContain("create_draft_pr");
  });

  test("canonicalizes profile ordering but preserves explicit check ordering", () => {
    const plan = projectAttachmentRecovery("scrapbook", null, {
      ...scrapbookContext,
      runnerProfiles: ["z-runner", "a-runner"],
      checks: ["bun test", "bun run typecheck"],
    });
    expect(plan && "requested" in plan ? plan.requested.runnerProfiles : null)
      .toEqual(["a-runner", "z-runner"]);
    expect(plan && "requested" in plan ? plan.requested.checks : null)
      .toEqual(["bun test", "bun run typecheck"]);
  });

  test("rejects malformed or credential-shaped setup context", () => {
    const bearerCredentialCheck = [
      "Authorization:",
      ["Bear", "er"].join(""),
      "x".repeat(26),
    ].join(" ");
    expect(() => projectAttachmentRecovery("scrapbook", null, {
      ...scrapbookContext,
      repositoryFullName: "teamleaderleo/scrapbook ",
    })).toThrow("exact printable ASCII");
    expect(() => projectAttachmentRecovery("scrapbook", null, {
      ...scrapbookContext,
      defaultBranch: "refs/heads/main",
    })).toThrow("Default branch is invalid");
    expect(() => projectAttachmentRecovery("scrapbook", null, {
      ...scrapbookContext,
      runnerProfiles: ["codex-default", "codex-default"],
    })).toThrow("must be unique");
    expect(() => projectAttachmentRecovery("scrapbook", null, {
      ...scrapbookContext,
      checks: [bearerCredentialCheck],
    })).toThrow("credential-shaped");
  });
});

function attachment(): ProjectAttachmentRecord {
  const snapshot = compileProjectContract(renderProjectContract({
    version: 1,
    project: "scrapbook",
    repositories: ["teamleaderleo/scrapbook"],
    runnerProfiles: ["codex-default"],
    concurrency: { project: 1, global: 1 },
    autonomousActions: ["inspect", "propose", "create_draft_pr"],
    approvalRequired: ["merge", "deploy"],
    checks: ["bun test"],
    tags: ["coordination"],
    relatedProjects: [],
  }, {
    goal: "Coordinate Scrapbook work.",
    boundaries: "Keep consequential effects approval-gated.",
    evidenceAndHandoff: "Leave exact repository evidence.",
    escalation: "Escalate missing authority.",
  }));
  return {
    id: "attach_scrapbook",
    project: "scrapbook",
    snapshot,
    sourceRevision: "main@accepted",
    acceptedBy: "token:operator",
    authorityWidening: true,
    acceptedAt: "2026-08-10T00:00:00.000Z",
  };
}
