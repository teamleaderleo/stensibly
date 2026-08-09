import { describe, expect, test } from "bun:test";
import type { ProjectAttachmentRecord } from "../src/project-attachment-ledger.ts";
import {
  projectSetupStatusWithRepository,
} from "../src/setup-status-repository.ts";
import type {
  SetupStatusInput,
  SetupStepStates,
} from "../src/setup-status.ts";
import {
  compileProjectContract,
  renderProjectContract,
} from "../src/project-contract.ts";

function states(overrides: Partial<SetupStepStates> = {}): SetupStepStates {
  return {
    deployment: "ready",
    backend: "ready",
    account: "ready",
    workspace: "ready",
    project: "ready",
    oauth_discovery: "ready",
    mcp_connection: "ready",
    first_read: "ready",
    repository: "missing",
    proofwake: "deferred",
    ...overrides,
  };
}

function setup(overrides: Partial<SetupStatusInput> = {}): SetupStatusInput {
  return {
    mode: "production",
    observedAt: "2026-08-10T00:00:00Z",
    serviceOrigin: "https://api.stensibly.com",
    mcpEndpoint: "https://api.stensibly.com/mcp",
    steps: states(),
    lastVerifiedStep: "first_read",
    ...overrides,
  };
}

const repositorySetup = {
  repositoryFullName: "teamleaderleo/scrapbook",
  defaultBranch: "main",
  runnerProfiles: ["codex-default"],
  workProfile: "draft_pr" as const,
  checks: ["bun run typecheck", "bun test"],
};

describe("repository-aware setup status", () => {
  test("surfaces context-needed recovery for the Scrapbook missing repository step", () => {
    const result = projectSetupStatusWithRepository({
      setup: setup(),
      project: "scrapbook",
      attachment: null,
    });

    expect(result).toMatchObject({
      state: "ready",
      nextStep: null,
      repositoryRecovery: {
        version: 1,
        state: "repository_context_required",
        nextAction: "provide_repository_context",
        authorizesProviderEffect: false,
      },
      containsSecrets: false,
    });
    expect(result.steps.find((entry) => entry.step === "repository")).toMatchObject({
      state: "missing",
      required: false,
    });
  });

  test("carries the exact attachment plan when GitHub repository facts are known", () => {
    const result = projectSetupStatusWithRepository({
      setup: setup(),
      project: "scrapbook",
      attachment: null,
      repositorySetup,
    });

    expect(result.repositoryRecovery).toMatchObject({
      state: "attachment_required",
      project: "scrapbook",
      repository: {
        fullName: "teamleaderleo/scrapbook",
        defaultBranch: "main",
      },
      requested: {
        workProfile: "draft_pr",
        runnerProfiles: ["codex-default"],
        checks: ["bun run typecheck", "bun test"],
      },
      nextAction: {
        kind: "review_and_accept_project_attachment",
        requiresAdmin: true,
        acceptAuthorityWidening: true,
      },
      verification: {
        repositoryMetadata: "get_repo",
        immutableFileRead: "fetch_file",
        immutableReadRef: "exact_commit_sha",
      },
      authorizesProviderEffect: false,
      containsSecrets: false,
    });
  });

  test("carries the same bounded recovery when repository setup is degraded", () => {
    const result = projectSetupStatusWithRepository({
      setup: setup({ steps: states({ repository: "degraded" }) }),
      project: "scrapbook",
      attachment: null,
      repositorySetup,
    });

    expect(result.optionalAttentionSteps).toContain("repository");
    expect(result.repositoryRecovery).toMatchObject({
      state: "attachment_required",
      repository: { fullName: "teamleaderleo/scrapbook" },
      authorizesProviderEffect: false,
    });
  });

  test("honours explicit repository deferral without surfacing an active continuation", () => {
    const result = projectSetupStatusWithRepository({
      setup: setup({ steps: states({ repository: "deferred" }) }),
      project: "scrapbook",
      attachment: null,
      repositorySetup,
    });
    expect(result.repositoryRecovery).toBeNull();
  });

  test("requires an accepted attachment before repository readiness", () => {
    expect(() => projectSetupStatusWithRepository({
      setup: setup({ steps: states({ repository: "ready" }) }),
      project: "scrapbook",
      attachment: null,
    })).toThrow("requires an accepted project attachment");
  });

  test("returns no replacement recovery for a ready accepted attachment", () => {
    const result = projectSetupStatusWithRepository({
      setup: setup({ steps: states({ repository: "ready" }) }),
      project: "scrapbook",
      attachment: attachment(),
      repositorySetup,
    });
    expect(result.repositoryRecovery).toBeNull();
  });

  test("rejects stale non-ready repository status after attachment acceptance", () => {
    for (const repository of ["missing", "degraded"] as const) {
      expect(() => projectSetupStatusWithRepository({
        setup: setup({ steps: states({ repository }) }),
        project: "scrapbook",
        attachment: attachment(),
      })).toThrow("conflicts with non-ready repository setup state");
    }
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
