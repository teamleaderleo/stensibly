import { describe, expect, test } from "bun:test";
import {
  prepareProjectAttachmentReview,
} from "../src/project-attachment-review.ts";
import {
  createProjectRepositorySetupObservationRecord,
  projectRepositorySetupObservationFingerprint,
} from "../src/project-repository-setup-observation.ts";
import {
  renderProjectContract,
  type ProjectContract,
} from "../src/project-contract.ts";

const project = "scrapbook";
const repositoryFullName = "teamleaderleo/scrapbook";

describe("project attachment review credential admission", () => {
  test("rejects realistic credential-shaped material before snapshot compilation", () => {
    const semantics = {
      project,
      repositoryFullName,
      defaultBranch: "main",
      sourceKind: "operator_supplied" as const,
    };
    const proposal = createProjectRepositorySetupObservationRecord({
      id: "repo_setup_credential01",
      ...semantics,
      semanticFingerprint: projectRepositorySetupObservationFingerprint(semantics),
      observedAt: "2026-08-10T02:45:00.000Z",
    });
    const contract: ProjectContract = {
      version: 1,
      project,
      repositories: [repositoryFullName],
      runnerProfiles: ["codex-default"],
      concurrency: { project: 1, global: 1 },
      autonomousActions: ["inspect"],
      approvalRequired: ["merge"],
      checks: [],
      tags: [],
      relatedProjects: [],
    };
    const bearerWord = ["Bear", "er"].join("");
    const source = renderProjectContract(contract, {
      goal: "Coordinate the repository.",
      boundaries: `Discard ${bearerWord} ${"x".repeat(24)} immediately.`,
      evidenceAndHandoff: "Leave exact evidence.",
      escalation: "Escalate authority changes.",
    });

    expect(() => prepareProjectAttachmentReview({
      project,
      proposal,
      source,
      sourceRevision: "main@credential-probe",
      currentAttachment: null,
    })).toThrow("credential-shaped material");
  });
});
