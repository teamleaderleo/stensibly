import { describe, expect, test } from "bun:test";
import type { ProjectAttachmentRecord } from "../src/project-attachment-ledger.ts";
import {
  prepareProjectAttachmentReview,
} from "../src/project-attachment-review.ts";
import {
  createProjectRepositorySetupObservationRecord,
  projectRepositorySetupObservationFingerprint,
} from "../src/project-repository-setup-observation.ts";
import {
  compileProjectContract,
  renderProjectContract,
  type ProjectContract,
} from "../src/project-contract.ts";

const proposalSemantics = {
  project: "scrapbook",
  repositoryFullName: "teamleaderleo/scrapbook",
  defaultBranch: "main",
  sourceKind: "github_conversation_context" as const,
};
const proposal = createProjectRepositorySetupObservationRecord({
  id: "repo_setup_review01",
  ...proposalSemantics,
  semanticFingerprint: projectRepositorySetupObservationFingerprint(proposalSemantics),
  observedAt: "2026-08-10T02:00:00.000Z",
});

const baseContract: ProjectContract = {
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
};

const context = {
  goal: "Coordinate Scrapbook work.",
  boundaries: "Keep consequential effects approval-gated.",
  evidenceAndHandoff: "Leave exact repository evidence.",
  escalation: "Escalate missing authority.",
};

describe("project attachment review", () => {
  test("previews first acceptance without granting acceptance authority", () => {
    const review = prepareProjectAttachmentReview({
      project: "scrapbook",
      proposal,
      source: source(baseContract),
      sourceRevision: "main@abc123",
      currentAttachment: null,
    });

    expect(review).toMatchObject({
      version: 1,
      project: "scrapbook",
      proposalId: proposal.id,
      proposalSemanticFingerprint: proposal.semanticFingerprint,
      repositoryFullName: "teamleaderleo/scrapbook",
      defaultBranch: "main",
      sourceRevision: "main@abc123",
      diff: null,
      requiresAuthorityWidening: true,
      exactReplay: false,
      authorizesAttachmentAcceptance: false,
      authorizesProviderEffect: false,
      containsSecrets: false,
    });
    expect(review.snapshot.contract).toEqual(baseContract);
    expect(Object.isFrozen(review)).toBe(true);
  });

  test("recognizes an exact accepted snapshot and source-revision replay", () => {
    const current = attachment(baseContract);
    const review = prepareProjectAttachmentReview({
      project: "scrapbook",
      proposal,
      source: source(baseContract),
      sourceRevision: "main@accepted",
      currentAttachment: current,
    });
    expect(review.exactReplay).toBe(true);
    expect(review.diff).toBeNull();
    expect(review.requiresAuthorityWidening).toBe(false);
  });

  test("keeps an unchanged snapshot with a new source revision out of replay", () => {
    const current = attachment(baseContract);
    const review = prepareProjectAttachmentReview({
      project: "scrapbook",
      proposal,
      source: source(baseContract),
      sourceRevision: "main@new-revision",
      currentAttachment: current,
    });
    expect(review.exactReplay).toBe(false);
    expect(review.diff).toMatchObject({ widensAuthority: false });
    expect(review.requiresAuthorityWidening).toBe(false);
  });

  test("shows a widening diff when reviewed source adds authority", () => {
    const current = attachment(baseContract);
    const widened: ProjectContract = {
      ...baseContract,
      repositories: ["teamleaderleo/scrapbook", "teamleaderleo/stensibly"],
      autonomousActions: [
        ...baseContract.autonomousActions,
        "provider_write",
      ],
    };
    const review = prepareProjectAttachmentReview({
      project: "scrapbook",
      proposal,
      source: source(widened),
      sourceRevision: "main@widened",
      currentAttachment: current,
    });
    expect(review.exactReplay).toBe(false);
    expect(review.requiresAuthorityWidening).toBe(true);
    expect(review.diff).toMatchObject({
      repositoriesAdded: ["teamleaderleo/stensibly"],
      autonomousActionsAdded: ["provider_write"],
      widensAuthority: true,
    });
  });

  test("rejects project and saved-repository mismatches before preview", () => {
    expect(() => prepareProjectAttachmentReview({
      project: "stensibly",
      proposal,
      source: source(baseContract),
      sourceRevision: "main@abc123",
      currentAttachment: null,
    })).toThrow("proposal does not match");

    expect(() => prepareProjectAttachmentReview({
      project: "scrapbook",
      proposal,
      source: source({
        ...baseContract,
        repositories: ["teamleaderleo/stensibly"],
      }),
      sourceRevision: "main@abc123",
      currentAttachment: null,
    })).toThrow("does not include the saved repository proposal");
  });

  test("re-admits the saved proposal semantic identity before preview", () => {
    expect(() => prepareProjectAttachmentReview({
      project: "scrapbook",
      proposal: {
        ...proposal,
        semanticFingerprint: `sha256:${"0".repeat(64)}`,
      },
      source: source(baseContract),
      sourceRevision: "main@abc123",
      currentAttachment: null,
    })).toThrow("Repository setup observation fingerprint is invalid");
  });

  test("rejects malformed source revision and foreign current attachment", () => {
    expect(() => prepareProjectAttachmentReview({
      project: "scrapbook",
      proposal,
      source: source(baseContract),
      sourceRevision: " main@abc123 ",
      currentAttachment: null,
    })).toThrow("source revision is invalid");

    expect(() => prepareProjectAttachmentReview({
      project: "scrapbook",
      proposal,
      source: source(baseContract),
      sourceRevision: "main@abc123",
      currentAttachment: {
        ...attachment(baseContract),
        project: "stensibly",
      },
    })).toThrow("Current project attachment does not match");
  });
});

function source(contract: ProjectContract): string {
  return renderProjectContract(contract, context);
}

function attachment(contract: ProjectContract): ProjectAttachmentRecord {
  return {
    id: "attach_scrapbook",
    project: "scrapbook",
    snapshot: compileProjectContract(source(contract)),
    sourceRevision: "main@accepted",
    acceptedBy: "token:operator",
    authorityWidening: true,
    acceptedAt: "2026-08-10T01:00:00.000Z",
  };
}
