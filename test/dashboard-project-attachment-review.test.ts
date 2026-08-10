import { describe, expect, test } from "bun:test";
import {
  createRepositoryAttachmentDraft,
  localDraftSourceRevision,
  readAcceptedProjectAttachment,
  readProjectAttachmentAcceptance,
  readProjectAttachmentReview,
  reviewSource,
} from "../site/project-attachment-review.js";
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

const project = "scrapbook";
const repositoryFullName = "teamleaderleo/scrapbook";
const semanticFingerprint = `sha256:${"a".repeat(64)}`;
const proposal = {
  version: 1 as const,
  id: "repo_setup_dashboard01",
  project,
  repositoryFullName,
  defaultBranch: "main",
  sourceKind: "operator_supplied" as const,
  semanticFingerprint,
  observedAt: "2026-08-10T02:30:00.000Z",
  authorizesProviderEffect: false as const,
  containsSecrets: false as const,
};
const recovery = {
  version: 1 as const,
  state: "attachment_required" as const,
  project,
  repository: { fullName: repositoryFullName, defaultBranch: "main" },
  requested: {
    runnerProfiles: ["codex-default"],
    workProfile: "draft_pr" as const,
    checks: ["bun run typecheck", "bun test"],
  },
  sourcePath: "STENSIBLY.md" as const,
  nextAction: {
    kind: "review_and_accept_project_attachment" as const,
    requiresAdmin: true as const,
    acceptAuthorityWidening: true as const,
  },
  verification: {
    repositoryMetadata: "get_repo" as const,
    immutableFileRead: "fetch_file" as const,
    immutableReadRef: "exact_commit_sha" as const,
  },
  authorizesProviderEffect: false as const,
  containsSecrets: false as const,
};

describe("dashboard project attachment owner-action contract", () => {
  test("generates a deterministic local STENSIBLY.md draft from the saved repository plan", async () => {
    const source = createRepositoryAttachmentDraft({ project, proposal, recovery });
    const snapshot = compileProjectContract(source);
    expect(snapshot.contract).toMatchObject({
      project,
      repositories: [repositoryFullName],
      runnerProfiles: ["codex-default"],
      autonomousActions: [
        "inspect",
        "propose",
        "record_progress",
        "attach_artifact",
        "create_draft_pr",
      ],
      approvalRequired: [
        "merge",
        "deploy",
        "external_message",
        "provider_change",
        "spend",
        "permission_change",
      ],
      checks: ["bun run typecheck", "bun test"],
    });
    expect(snapshot.context.goal).toContain(repositoryFullName);

    const revision = await localDraftSourceRevision(source);
    expect(revision).toMatch(/^local-draft:sha256:[a-f0-9]{64}$/u);
    expect(await localDraftSourceRevision(`${source}\n`)).not.toBe(revision);
  });

  test("binds preview, acceptance, and accepted-state reread to one exact owner decision", async () => {
    const source = createRepositoryAttachmentDraft({ project, proposal, recovery });
    const sourceRevision = await localDraftSourceRevision(source);
    const snapshot = compileProjectContract(source);
    const review = readProjectAttachmentReview({
      review: {
        version: 1,
        project,
        proposalId: proposal.id,
        proposalSemanticFingerprint: proposal.semanticFingerprint,
        repositoryFullName,
        defaultBranch: "main",
        sourceRevision,
        snapshot,
        diff: null,
        requiresAuthorityWidening: true,
        exactReplay: false,
        authorizesAttachmentAcceptance: false,
        authorizesProviderEffect: false,
        containsSecrets: false,
      },
    }, {
      project,
      proposalId: proposal.id,
      proposalSemanticFingerprint: proposal.semanticFingerprint,
      repositoryFullName,
      defaultBranch: "main",
      sourceRevision,
    });

    expect(review).toMatchObject({
      project,
      repositoryFullName,
      defaultBranch: "main",
      sourceRevision,
      requiresAuthorityWidening: true,
      exactReplay: false,
      authorizesAttachmentAcceptance: false,
      authorizesProviderEffect: false,
    });
    expect(review.snapshot.snapshotSha256).toBe(snapshot.snapshotSha256);

    const acceptance = readProjectAttachmentAcceptance({
      attachment: {
        id: "attach_dashboard01",
        project,
        sourceRevision,
        snapshot,
      },
      replayed: false,
    }, review);
    expect(acceptance).toEqual({
      attachment: {
        id: "attach_dashboard01",
        project,
        sourceRevision,
        snapshotSha256: snapshot.snapshotSha256,
      },
      replayed: false,
    });
    expect(readAcceptedProjectAttachment({
      attachment: {
        id: "attach_dashboard01",
        project,
        sourceRevision,
        snapshot,
      },
    }, review)).toEqual(acceptance.attachment);

    expect(() => readProjectAttachmentReview({
      review: {
        ...review,
        sourceRevision: `${sourceRevision}-stale`,
      },
    }, {
      project,
      proposalId: proposal.id,
      proposalSemanticFingerprint: proposal.semanticFingerprint,
      repositoryFullName,
      defaultBranch: "main",
      sourceRevision,
    })).toThrow("does not match the current owner action");
  });

  test("rejects credential-shaped reviewed source before browser or server preview", () => {
    const secret = `Bearer ${"a".repeat(24)}`;
    expect(() => reviewSource(`${createRepositoryAttachmentDraft({ project, proposal, recovery })}\n${secret}`))
      .toThrow("credential-shaped material");

    const semantics = {
      project,
      repositoryFullName,
      defaultBranch: "main",
      sourceKind: "operator_supplied" as const,
    };
    const serverProposal = createProjectRepositorySetupObservationRecord({
      id: "repo_setup_serversecret",
      ...semantics,
      semanticFingerprint: projectRepositorySetupObservationFingerprint(semantics),
      observedAt: "2026-08-10T02:31:00.000Z",
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
    const source = renderProjectContract(contract, {
      goal: "Coordinate the repository.",
      boundaries: `Never retain ${secret}`,
      evidenceAndHandoff: "Leave exact evidence.",
      escalation: "Escalate authority changes.",
    });
    expect(() => prepareProjectAttachmentReview({
      project,
      proposal: serverProposal,
      source,
      sourceRevision: "local-draft:credential-probe",
      currentAttachment: null,
    })).toThrow("credential-shaped material");
  });
});
