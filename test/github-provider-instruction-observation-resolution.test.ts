import { describe, expect, test } from "bun:test";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts.ts";
import {
  buildGitHubIssueContext,
  type GitHubIssueContext,
} from "../src/github-issue-context.ts";
import {
  GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
  compileGitHubProviderContextReconciliation,
} from "../src/github-provider-context-reconciliation.ts";
import {
  GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
  compileGitHubProviderInstructionObservationRequestV1,
} from "../src/github-provider-instruction-observation-request.ts";
import {
  GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_RESOLUTION_V1,
  resolveGitHubProviderInstructionObservationV1,
} from "../src/github-provider-instruction-observation-resolution.ts";
import {
  compileProjectContract,
  renderProjectContract,
  type ProjectAttachmentSnapshot,
} from "../src/project-contract.ts";
import type { ProjectAttachmentRecord } from "../src/project-attachment-ledger.ts";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";

const workspace = "default";
const project = "stensibly";
const repositoryFullName = "teamleaderleo/stensibly";
const attachmentId = "attach_instruction_resolution";
const attachmentRevision = "main@accepted";
const providerObservedAt = "2026-08-03T09:30:00.000Z";
const instructionObservedAt = "2026-08-03T09:31:00.000Z";

type Operation =
  | "github_create_issue"
  | "github_update_issue"
  | "github_add_issue_labels"
  | "github_remove_issue_assignees";

describe("GitHub provider instruction observation resolution", () => {
  test("resolves create, update, label, and assignee requests to one canonical binding", () => {
    for (const operation of [
      "github_create_issue",
      "github_update_issue",
      "github_add_issue_labels",
      "github_remove_issue_assignees",
    ] as const satisfies readonly Operation[]) {
      const attachment = attachmentRecord();
      const request = observationRequest(operation, attachment);
      const result = resolve(request, attachment, observed(attachment, [
        source("docs/current-wave.md", "main@wave", hash("c")),
        attachmentSource(attachment),
        source("AGENTS.md", "main@agents", hash("b")),
      ]));

      expect(result).toMatchObject({
        version: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_RESOLUTION_V1,
        workspace,
        project,
        repositoryFullName,
        requestId: request.requestId,
        observationRef: request.observationRef,
        proposalFingerprint: request.proposalFingerprint,
        attachmentId,
        attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
        instructionObservedAt,
        observedBy: "actor_observer",
        outcome: "ready_for_context_acceptance_binding",
        nextAction: "compose_context_acceptance",
        authorizesProviderRead: false,
        authorizesProviderMutation: false,
        authorizesContextAcceptance: false,
        authorizesPersistence: false,
        authorizesApproval: false,
        authorizesAuthority: false,
      });
      expect(result.instructionSet).toMatchObject({
        version: 1,
        projectAttachmentId: attachmentId,
        projectAttachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
      });
      expect(result.instructionSet?.sources.map(({ path }) => path)).toEqual([
        "AGENTS.md",
        "STENSIBLY.md",
        "docs/current-wave.md",
      ]);
      expect(result.resolutionFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.instructionSet)).toBe(true);
      expect(Object.isFrozen(result.instructionSet?.sources)).toBe(true);
    }
  });

  test("short-circuits a non-actionable request before hostile irrelevant inputs", () => {
    const request = nonActionableRequest();
    let reads = 0;
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "id", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("github_pat_irrelevant_value");
      },
    });

    const result = resolveGitHubProviderInstructionObservationV1({
      schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_RESOLUTION_V1,
      request,
      attachment: hostile,
      observation: hostile,
    });

    expect(result).toMatchObject({
      outcome: "request_not_actionable",
      nextAction: "none",
      instructionObservedAt: null,
      observedBy: null,
      instructionSet: null,
    });
    expect(reads).toBe(0);
  });

  test("classifies attachment, project, repository, source, and chronology conflicts", () => {
    const attachment = attachmentRecord();
    const request = observationRequest("github_create_issue", attachment);

    const projectConflict = attachmentRecord({
      project: "other",
      snapshot: attachmentSnapshot({ project: "other" }),
    });
    expect(resolve(request, projectConflict, observed(projectConflict))).toMatchObject({
      outcome: "project_identity_conflict",
      nextAction: "inspect_project_identity",
    });

    for (const candidate of [
      attachmentRecord({ id: "attach_other" }),
      attachmentRecord({
        snapshot: attachmentSnapshot({ checks: ["typecheck", "test"] }),
      }),
    ]) {
      expect(resolve(request, candidate, observed(candidate))).toMatchObject({
        outcome: "attachment_identity_conflict",
        nextAction: "reload_current_attachment",
      });
    }

    const repositoryConflict = attachmentRecord({
      snapshot: attachmentSnapshot({ repositories: ["teamleaderleo/other"] }),
    });
    expect(resolve(
      observationRequest("github_create_issue", repositoryConflict),
      repositoryConflict,
      observed(repositoryConflict),
    )).toMatchObject({
      outcome: "repository_binding_conflict",
      nextAction: "inspect_repository_binding",
    });

    const updateRequest = observationRequest("github_update_issue", attachment);
    for (const sources of [
      [source("AGENTS.md", "main@agents", hash("b"))],
      [source(
        attachment.snapshot.source.path,
        "main@different",
        attachment.snapshot.source.contentSha256,
      )],
      [source(
        attachment.snapshot.source.path,
        attachment.sourceRevision,
        hash("f"),
      )],
    ]) {
      expect(resolve(
        updateRequest,
        attachment,
        observed(attachment, sources),
      )).toMatchObject({
        outcome: "attachment_source_conflict",
        nextAction: "reobserve_repository_instructions",
        instructionSet: null,
      });
    }

    expect(resolve(
      request,
      attachment,
      observed(attachment, undefined, "2026-08-03T09:29:59.999Z"),
    )).toMatchObject({
      outcome: "observation_chronology_conflict",
      nextAction: "reobserve_repository_instructions",
      instructionObservedAt: "2026-08-03T09:29:59.999Z",
      observedBy: "actor_observer",
      instructionSet: null,
    });
  });

  test("binds fingerprints to workspace, observer, sources, and exact request identity", () => {
    const attachment = attachmentRecord();
    const request = observationRequest("github_create_issue", attachment);
    const base = resolve(request, attachment, observed(attachment));
    const otherObserver = resolve(
      request,
      attachment,
      observed(attachment, undefined, instructionObservedAt, "actor_other"),
    );
    const otherSources = resolve(request, attachment, observed(attachment, [
      attachmentSource(attachment),
      source("AGENTS.md", "main@agents", hash("d")),
    ]));
    const otherWorkspace = resolve(
      observationRequest("github_create_issue", attachment, "other"),
      attachment,
      observed(attachment),
    );

    expect(otherObserver.resolutionFingerprint).not.toBe(base.resolutionFingerprint);
    expect(otherSources.resolutionFingerprint).not.toBe(base.resolutionFingerprint);
    expect(otherWorkspace.workspace).toBe("other");
    expect(otherWorkspace.resolutionFingerprint).not.toBe(base.resolutionFingerprint);

    const tampered = structuredClone(request) as unknown as Record<string, unknown>;
    tampered.actorId = "actor_other";
    expect(() => resolve(
      tampered as unknown as typeof request,
      attachment,
      observed(attachment),
    )).toThrow("request fingerprint is invalid");

    const refingerprintedBody = structuredClone(request) as unknown as Record<string, unknown>;
    delete refingerprintedBody.requestFingerprint;
    refingerprintedBody.attachmentId = "attach_other";
    const refingerprinted = {
      ...refingerprintedBody,
      requestFingerprint: fingerprintCanonicalRequest(refingerprintedBody),
    } as unknown as typeof request;
    expect(() => resolve(
      refingerprinted,
      attachment,
      observed(attachment),
    )).toThrow("request identity is invalid");

    const crossRepository = refingerprintedRequest(request, {
      externalId: "github:teamleaderleo/other#1006",
    });
    expect(() => resolve(
      crossRepository,
      attachment,
      observed(attachment),
    )).toThrow("issue identity does not match repository");
  });

  test("rejects hostile or credential-shaped input without retaining prose", () => {
    const attachment = attachmentRecord();
    const request = observationRequest("github_create_issue", attachment);

    const hostileRepository = structuredClone(request) as unknown as Record<string, unknown>;
    hostileRepository.repositoryFullName =
      `teamleaderleo/repositoryxgithub_pat_${"a".repeat(20)}`;
    expect(() => resolve(
      hostileRepository as unknown as typeof request,
      attachment,
      observed(attachment),
    )).toThrow("repository is invalid");

    let requestReads = 0;
    const hostileRequest = structuredClone(request) as unknown as Record<string, unknown>;
    Object.defineProperty(hostileRequest, "actorId", {
      enumerable: true,
      get() {
        requestReads += 1;
        throw new Error("github_pat_hidden_value");
      },
    });
    expect(() => resolve(
      hostileRequest as unknown as typeof request,
      attachment,
      observed(attachment),
    )).toThrow("enumerable data properties");
    expect(requestReads).toBe(0);

    const hostileAttachment = structuredClone(attachment);
    const hostileSnapshot = hostileAttachment.snapshot as unknown as {
      contract: Record<string, unknown>;
    };
    let snapshotReads = 0;
    Object.defineProperty(hostileSnapshot.contract, "project", {
      enumerable: true,
      get() {
        snapshotReads += 1;
        throw new Error("secret://hidden/project");
      },
    });
    expect(() => resolve(
      request,
      hostileAttachment,
      observed(attachment),
    )).toThrow();
    expect(snapshotReads).toBe(0);

    expect(() => resolve(
      request,
      attachment,
      observed(
        attachment,
        undefined,
        instructionObservedAt,
        `actorxghp_${"a".repeat(20)}`,
      ),
    )).toThrow("observing actor is invalid");
    expect(() => resolve(request, attachment, observed(attachment, [
      attachmentSource(attachment),
      source(
        "AGENTS.md",
        `revisionxstn.tok_${"a".repeat(20)}`,
        hash("b"),
      ),
    ]))).toThrow("contains credential-shaped identity");

    const producer = observed(attachment);
    const first = resolve(request, attachment, producer);
    const second = resolve(
      structuredClone(request),
      structuredClone(attachment),
      structuredClone(producer),
    );
    expect(second).toEqual(first);
    producer.sources[0]!.revision = "main@mutated";
    expect(first.instructionSet?.sources).toContainEqual(
      attachmentSource(attachment),
    );

    const serialized = JSON.stringify(first);
    for (const prose of [
      "Private attachment goal prose",
      "Private attachment boundary prose",
      "Verified provider issue title",
      "provider issue body",
    ]) {
      expect(serialized).not.toContain(prose);
    }
  });
});

function resolve(
  request: ReturnType<typeof observationRequest>,
  attachment: ProjectAttachmentRecord,
  observation: ReturnType<typeof observed>,
) {
  return resolveGitHubProviderInstructionObservationV1({
    schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_RESOLUTION_V1,
    request,
    attachment,
    observation,
  });
}

function refingerprintedRequest(
  request: ReturnType<typeof observationRequest>,
  changes: Partial<ReturnType<typeof observationRequest>>,
): ReturnType<typeof observationRequest> {
  const body = structuredClone(request) as unknown as Record<string, unknown>;
  delete body.requestFingerprint;
  Object.assign(body, changes);
  const identity = fingerprintCanonicalRequest({
    version: 1,
    workspace: body.workspace,
    project: body.project,
    repositoryFullName: body.repositoryFullName,
    receiptId: body.receiptId,
    externalId: body.externalId,
    proposalFingerprint: body.proposalFingerprint,
    attachmentId: body.attachmentId,
    attachmentSnapshotSha256: body.attachmentSnapshotSha256,
  });
  const suffix = identity.slice("sha256:".length);
  body.requestId = `github_instruction_observation_${suffix}`;
  body.observationRef = `github:provider-instruction-observation:${suffix}`;
  return {
    ...body,
    requestFingerprint: fingerprintCanonicalRequest(body),
  } as unknown as ReturnType<typeof observationRequest>;
}

function observationRequest(
  operation: Operation,
  attachment: ProjectAttachmentRecord,
  workspaceValue = workspace,
) {
  const proposal = compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt(operation, attachment),
    current: operation === "github_create_issue"
      ? null
      : {
        externalId: issueSnapshot().reference.externalId,
        sourceRevision: "github-rest:I_instruction_resolution:previous",
      },
  });
  return compileGitHubProviderInstructionObservationRequestV1({
    schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
    workspace: workspaceValue,
    proposal,
  });
}

function nonActionableRequest() {
  const attachment = attachmentRecord();
  const candidate = receipt("github_create_issue", attachment);
  const proposal = compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: {
      ...candidate,
      state: "reserved",
      result: null,
      providerRequestId: null,
      verification: {
        state: "not_run",
        checkedAt: null,
        sourceRevision: null,
      },
    },
    current: null,
  });
  return compileGitHubProviderInstructionObservationRequestV1({
    schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
    workspace,
    proposal,
  });
}

function receipt(
  operation: Operation,
  attachment: ProjectAttachmentRecord,
): GitHubProviderReceipt {
  const snapshot = issueSnapshot();
  const target = operation === "github_create_issue"
    ? `${repositoryFullName}#new`
    : operation.includes("labels")
      ? `${repositoryFullName}#1006:labels`
      : operation.includes("assignees")
        ? `${repositoryFullName}#1006:assignees`
        : `${repositoryFullName}#1006`;
  return {
    version: 1,
    id: `ghop_instruction_resolution_${operation}`,
    project,
    provider: "github",
    repositoryFullName,
    operation,
    target,
    actorId: "actor_lynx",
    clientId: "client_github_only",
    connectionId: "ghconn_instruction_resolution",
    installationId: "installation_instruction_resolution",
    bindingId: "ghbind_instruction_resolution",
    attachmentId: attachment.id,
    attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: `instruction-resolution-${operation}`,
    parametersSha256: hash("a"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-03T09:29:55.000Z",
    updatedAt: providerObservedAt,
    providerRequestId: "request-instruction-resolution",
    result: snapshot,
    verification: {
      state: "passed",
      checkedAt: providerObservedAt,
      sourceRevision: snapshot.sourceRevision,
    },
    error: null,
    recovery: { nextAction: "none" },
  };
}

function issueSnapshot(): GitHubIssueContext {
  return buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository: "stensibly",
    number: 1006,
    title: "Verified provider issue title",
    body: "provider issue body",
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-03T09:00:00.000Z",
    updatedAt: providerObservedAt,
    providerNodeId: "I_instruction_resolution",
    sourceRevision: "github-rest:I_instruction_resolution:provider",
  });
}

function attachmentRecord(
  overrides: Partial<ProjectAttachmentRecord> = {},
): ProjectAttachmentRecord {
  const snapshot = overrides.snapshot ?? attachmentSnapshot();
  return {
    id: attachmentId,
    project: snapshot.contract.project,
    snapshot,
    sourceRevision: attachmentRevision,
    acceptedBy: "actor_human",
    authorityWidening: false,
    acceptedAt: "2026-08-03T09:00:00.000Z",
    ...overrides,
  };
}

function attachmentSnapshot(
  input: {
    project?: string;
    repositories?: string[];
    checks?: string[];
  } = {},
): ProjectAttachmentSnapshot {
  const attachmentProject = input.project ?? project;
  return compileProjectContract(renderProjectContract({
    version: 1,
    project: attachmentProject,
    repositories: input.repositories ?? [repositoryFullName],
    runnerProfiles: ["chatgpt"],
    concurrency: { project: 1, global: 1 },
    autonomousActions: ["inspect"],
    approvalRequired: ["merge"],
    checks: input.checks ?? ["typecheck"],
    tags: [],
    relatedProjects: [],
  }, {
    goal: "Private attachment goal prose",
    boundaries: "Private attachment boundary prose",
    evidenceAndHandoff: "Private attachment evidence prose",
    escalation: "Private attachment escalation prose",
  }));
}

function observed(
  attachment: ProjectAttachmentRecord,
  sources = [
    attachmentSource(attachment),
    source("AGENTS.md", "main@agents", hash("b")),
  ],
  observedAt = instructionObservedAt,
  observedBy = "actor_observer",
) {
  return { observedAt, observedBy, sources };
}

function attachmentSource(attachment: ProjectAttachmentRecord) {
  return source(
    attachment.snapshot.source.path,
    attachment.sourceRevision,
    attachment.snapshot.source.contentSha256,
  );
}

function source(path: string, revision: string, contentSha256: string) {
  return { path, revision, contentSha256 };
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
