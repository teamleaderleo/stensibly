import { describe, expect, test } from "bun:test";
import type { ProjectAttachmentRecord } from "../src/project-attachment-ledger.ts";
import {
  createProjectRepositorySetupObservationRecord,
  projectRepositorySetupObservationFingerprint,
} from "../src/project-repository-setup-observation.ts";
import { projectSetupStatusWithRepository } from "../src/setup-status-repository.ts";
import type { SetupStatusInput, SetupStepStates } from "../src/setup-status.ts";
import { compileProjectContract, renderProjectContract } from "../src/project-contract.ts";

const semantics = {
  project: "scrapbook",
  repositoryFullName: "teamleaderleo/scrapbook",
  defaultBranch: "main",
  sourceKind: "github_conversation_context" as const,
};
const advisory = createProjectRepositorySetupObservationRecord({
  id: "repo_setup_12345678",
  ...semantics,
  semanticFingerprint: projectRepositorySetupObservationFingerprint(semantics),
  observedAt: "2026-08-10T00:30:00.000Z",
});

function states(repository: SetupStepStates["repository"] = "missing"): SetupStepStates {
  return {
    deployment: "ready",
    backend: "ready",
    account: "ready",
    workspace: "ready",
    project: "ready",
    oauth_discovery: "ready",
    mcp_connection: "ready",
    first_read: "ready",
    repository,
    proofwake: "deferred",
  };
}

function setup(repository: SetupStepStates["repository"] = "missing"): SetupStatusInput {
  return {
    mode: "production",
    observedAt: "2026-08-10T00:30:00Z",
    serviceOrigin: "https://api.stensibly.com",
    mcpEndpoint: "https://api.stensibly.com/mcp",
    steps: states(repository),
    lastVerifiedStep: "first_read",
  };
}

describe("repository setup observation in setup status", () => {
  test("surfaces the advisory record while attachment is missing", () => {
    const result = projectSetupStatusWithRepository({
      setup: setup(),
      project: "scrapbook",
      attachment: null,
      repositorySetupObservation: advisory,
    });
    expect(result.repositorySetupObservation).toEqual(advisory);
    expect(result.repositoryRecovery).toMatchObject({
      state: "repository_context_required",
      authorizesProviderEffect: false,
    });
  });

  test("re-admits the advisory record before returning setup status", () => {
    const malformed = {
      ...advisory,
      repositoryFullName: "teamleaderleo/other",
    } as typeof advisory;
    expect(() => projectSetupStatusWithRepository({
      setup: setup(),
      project: "scrapbook",
      attachment: null,
      repositorySetupObservation: malformed,
    })).toThrow("Repository setup observation fingerprint is invalid");
  });

  test("accepted attachment wins and suppresses the advisory record", () => {
    const result = projectSetupStatusWithRepository({
      setup: setup("ready"),
      project: "scrapbook",
      attachment: attachment(),
      repositorySetupObservation: advisory,
    });
    expect(result.repositorySetupObservation).toBeNull();
    expect(result.repositoryRecovery).toBeNull();
  });

  test("explicit repository deferral suppresses the advisory record", () => {
    const result = projectSetupStatusWithRepository({
      setup: setup("deferred"),
      project: "scrapbook",
      attachment: null,
      repositorySetupObservation: advisory,
    });
    expect(result.repositorySetupObservation).toBeNull();
    expect(result.repositoryRecovery).toBeNull();
  });

  test("rejects an advisory record from another project", () => {
    const foreignSemantics = {
      ...semantics,
      project: "stensibly",
      repositoryFullName: "teamleaderleo/stensibly",
    };
    const foreign = createProjectRepositorySetupObservationRecord({
      id: "repo_setup_87654321",
      ...foreignSemantics,
      semanticFingerprint: projectRepositorySetupObservationFingerprint(foreignSemantics),
      observedAt: "2026-08-10T00:31:00.000Z",
    });
    expect(() => projectSetupStatusWithRepository({
      setup: setup(),
      project: "scrapbook",
      attachment: null,
      repositorySetupObservation: foreign,
    })).toThrow("does not match the selected project");
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
