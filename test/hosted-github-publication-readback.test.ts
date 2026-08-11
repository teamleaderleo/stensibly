import { describe, expect, test } from "bun:test";
import type {
  GitHubBranchResult,
  GitHubProviderReceipt,
  GitHubPublicationProviderAdapter,
} from "../src/github-provider-contracts.ts";
import { HostedGitHubAttachmentBindingStore } from "../src/hosted-github-attachment-binding.ts";
import {
  mountHostedGitHubPublicationReadbackFromEnv,
} from "../src/hosted-github-publication-readback.ts";
import type { GitHubPublishChangeInput } from "../src/github-publish-change-operation.ts";
import type { WorkLedger } from "../src/ledger.ts";
import {
  OperationWorkflowPendingReconciliationError,
  type OperationWorkflow,
} from "../src/operation-workflow-contracts.ts";
import type {
  ProjectAttachmentLedger,
  ProjectAttachmentRecord,
} from "../src/project-attachment-ledger.ts";
import {
  compileProjectContract,
  renderProjectContract,
} from "../src/project-contract.ts";
import { sha256, stableJson } from "../src/github-provider-validation.ts";

const project = "stensibly";
const repository = "teamleaderleo/stensibly";
const sourceSha = "a".repeat(40);
const observedAt = "2026-08-10T00:00:00.000Z";

const snapshot = compileProjectContract(renderProjectContract({
  version: 1,
  project,
  repositories: [repository],
  runnerProfiles: ["codex-default"],
  concurrency: { project: 4, global: 4 },
  autonomousActions: ["create_branch", "provider_write"],
  approvalRequired: [],
  checks: [],
  tags: ["github"],
  relatedProjects: [],
}, {
  goal: "Prove hosted publication readback composition.",
  boundaries: "Observation settles ambiguity without replacement mutation.",
  evidenceAndHandoff: "Use exact provider and receipt identities.",
  escalation: "Keep unmatched outcomes pending.",
}));

const attachment: ProjectAttachmentRecord = {
  id: "attach_hosted_readback",
  project,
  snapshot,
  sourceRevision: "main@hosted-readback-test",
  acceptedBy: "test",
  authorityWidening: false,
  acceptedAt: observedAt,
};

const env = {
  STENSIBLY_GITHUB_PUBLICATION_WRITES_ENABLED: "true",
  STENSIBLY_GITHUB_PROVIDER_PROJECT: project,
  STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN: "teamleaderleo",
  STENSIBLY_GITHUB_APP_ID: "123456",
  STENSIBLY_GITHUB_APP_PRIVATE_KEY: "test-private-key-unused-by-adapter-override",
  STENSIBLY_GITHUB_INSTALLATION_ID: "152263678",
  STENSIBLY_GITHUB_API_BASE_URL: "https://api.github.com",
};

const input: GitHubPublishChangeInput = {
  project,
  repository,
  actorId: "api-token:hosted_readback",
  clientId: "mcp:api-token:hosted_readback",
  itemId: "item_hosted_readback",
  runId: "run_hosted_readback",
  authorityFence: {
    resource: "run:run_hosted_readback:generation:1",
    holderId: "api-token:hosted_readback",
    generation: 1,
    expiresAt: "2026-08-10T00:01:00.000Z",
  },
  branch: "kite/hosted-readback",
  fromCommitSha: sourceSha,
  file: {
    operation: "create_file",
    path: "docs/readback.md",
    content: "content unused in branch reconciliation",
    message: "Add readback proof",
  },
  base: "main",
  expectedBaseSha: sourceSha,
  title: "Hosted publication readback",
  body: "readback proof",
  draft: true,
  idempotencyKey: "publish-change:hosted-readback",
};

describe("hosted GitHub publication readback mount", () => {
  test("keeps the ledger unchanged when publication writes are disabled", () => {
    const ledger = fakeLedger(new Map());
    const mounted = mountHostedGitHubPublicationReadbackFromEnv(
      ledger,
      { ...env, STENSIBLY_GITHUB_PUBLICATION_WRITES_ENABLED: "false" },
      { adapter: new FakePublicationAdapter() },
    );
    expect(mounted).toBe(ledger);
  });

  test("settles a pending branch through the hosted binding and re-enters the mounted service", async () => {
    const receipts = new Map<string, GitHubProviderReceipt>();
    const ledger = fakeLedger(receipts);
    const bindingStore = new HostedGitHubAttachmentBindingStore(
      ledger as unknown as ProjectAttachmentLedger,
      {
        project,
        installationId: env.STENSIBLY_GITHUB_INSTALLATION_ID,
        accountLogin: env.STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN,
        credentialRef: "env://STENSIBLY_GITHUB_APP_PRIVATE_KEY",
      },
      observedAt,
    );
    const binding = await bindingStore.getGitHubProjectRepositoryBinding(
      project,
      repository,
    );
    expect(binding).not.toBeNull();
    const providerKey = "provider-step-1";
    receipts.set(providerKey, pendingBranchReceipt(binding!.id, providerKey));
    const adapter = new FakePublicationAdapter();

    const mounted = mountHostedGitHubPublicationReadbackFromEnv(
      ledger,
      env,
      { adapter, now: () => Date.parse(observedAt) },
    );
    const result = await mounted.reconcilePublishChange!(input);

    expect(result.state).toBe("succeeded");
    expect(ledger.reconcileCalls).toBe(2);
    expect(adapter.branchReads).toBe(1);
    expect(adapter.branchWrites).toBe(0);
    expect(adapter.pullRequestWrites).toBe(0);
    expect(receipts.get(providerKey)).toMatchObject({
      state: "reconciled",
      attemptCount: 1,
      result: {
        kind: "branch",
        name: input.branch,
        commitSha: sourceSha,
      },
      verification: {
        state: "passed",
        sourceRevision: sourceSha,
      },
      recovery: { nextAction: "none" },
    });
  });

  test("requires the already-mounted publish-change and durable receipt services", () => {
    const ledger = fakeLedger(new Map());
    delete (ledger as { reconcilePublishChange?: unknown }).reconcilePublishChange;
    expect(() => mountHostedGitHubPublicationReadbackFromEnv(
      ledger,
      env,
      { adapter: new FakePublicationAdapter() },
    )).toThrow("requires the mounted publish-change service");
  });
});

function fakeLedger(receipts: Map<string, GitHubProviderReceipt>) {
  const pending = pendingWorkflow();
  const ledger = {
    reconcileCalls: 0,
    async getProjectAttachment(requestedProject: string) {
      return requestedProject === project ? attachment : null;
    },
    async acceptProjectAttachment() {
      throw new Error("unexpected attachment mutation");
    },
    async publishChange() {
      return succeededWorkflow(pending);
    },
    async reconcilePublishChange() {
      ledger.reconcileCalls += 1;
      if (ledger.reconcileCalls === 1) {
        throw new OperationWorkflowPendingReconciliationError(pending);
      }
      return succeededWorkflow(pending);
    },
    async reserveGitHubProviderReceipt(receipt: GitHubProviderReceipt) {
      const current = receipts.get(receipt.idempotencyKey);
      return current
        ? { outcome: "replay" as const, receipt: structuredClone(current) }
        : { outcome: "reserved" as const, receipt };
    },
    async updateGitHubProviderReceipt(receipt: GitHubProviderReceipt) {
      receipts.set(receipt.idempotencyKey, structuredClone(receipt));
      return structuredClone(receipt);
    },
    async getGitHubProviderReceipt(_project: string, key: string) {
      return structuredClone(receipts.get(key) ?? null);
    },
    async getRepositoryWriteReceipt() {
      return null;
    },
    async reconcileRepositoryFile() {
      throw new Error("unexpected repository-file readback");
    },
  };
  return ledger as typeof ledger & WorkLedger;
}

class FakePublicationAdapter implements GitHubPublicationProviderAdapter {
  branchReads = 0;
  branchWrites = 0;
  pullRequestWrites = 0;

  async getBranch(input: {
    repositoryFullName: string;
    branch: string;
  }): Promise<GitHubBranchResult | null> {
    expect(input.repositoryFullName).toBe(repository);
    this.branchReads += 1;
    if (input.branch !== inputBranch()) return null;
    return branchResult(input.branch, sourceSha);
  }

  async createBranch(): Promise<never> {
    this.branchWrites += 1;
    throw new Error("hosted readback must not create a branch");
  }

  async getPullRequest(): Promise<never> {
    throw new Error("unexpected PR readback");
  }

  async createPullRequest(): Promise<never> {
    this.pullRequestWrites += 1;
    throw new Error("hosted readback must not create a pull request");
  }
}

function inputBranch(): string {
  return input.branch;
}

function pendingBranchReceipt(
  bindingId: string,
  idempotencyKey: string,
): GitHubProviderReceipt {
  const target = `${repository}:refs/heads/${input.branch}`;
  return {
    version: 1,
    id: "ghop_hosted_readback",
    project,
    provider: "github",
    repositoryFullName: repository,
    operation: "github_create_branch",
    target,
    actorId: input.actorId,
    clientId: input.clientId,
    connectionId: `ghconn_installation_${env.STENSIBLY_GITHUB_INSTALLATION_ID}`,
    installationId: env.STENSIBLY_GITHUB_INSTALLATION_ID,
    bindingId,
    attachmentId: attachment.id,
    attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey,
    parametersSha256: sha256(stableJson({
      operation: "github_create_branch",
      target,
      parameters: {
        branch: input.branch,
        fromCommitSha: input.fromCommitSha,
      },
    })),
    state: "pending_reconciliation",
    attemptCount: 1,
    createdAt: observedAt,
    updatedAt: observedAt,
    providerRequestId: null,
    result: null,
    verification: {
      state: "failed",
      checkedAt: observedAt,
      sourceRevision: null,
    },
    error: {
      code: "ambiguous_provider_outcome",
      message: "GitHub publication outcome requires exact reconciliation",
      retry: "reconcile_before_retry",
    },
    recovery: { nextAction: "reconcile_exact_operation" },
  };
}

function pendingWorkflow(): OperationWorkflow {
  return {
    version: 1,
    id: "opw_hosted_readback",
    revision: 4,
    project,
    itemId: input.itemId,
    runId: input.runId,
    actorId: input.actorId,
    clientId: input.clientId,
    kind: "github_publish_change",
    target: `${repository}:refs/heads/${input.branch}`,
    requestSha256: "sha256:" + "1".repeat(64),
    idempotencyKey: input.idempotencyKey,
    state: "waiting_reconciliation",
    steps: [
      {
        id: "step-1",
        ordinal: 1,
        kind: "github_create_branch",
        commandId: "command-1",
        commandSha256: "sha256:" + "2".repeat(64),
        providerIdempotencyKey: "provider-step-1",
        authorityFence: input.authorityFence,
        state: "pending_reconciliation",
        reservedAt: observedAt,
        settledAt: observedAt,
        providerReceiptRef: null,
        beforeSha256: null,
        afterSha256: null,
        verificationSha256: null,
        errorCode: "ambiguous_provider_outcome",
        retry: "reconcile_before_retry",
        compensation: {
          disposition: "conditionally_reversible",
          kind: null,
          commandSha256: null,
          state: "not_started",
          providerReceiptRef: null,
        },
      },
      plannedStep(2, "github_create_file"),
      plannedStep(3, "github_create_pull_request"),
    ],
    cancellationRequestedAt: null,
    createdAt: observedAt,
    updatedAt: observedAt,
    terminalAt: null,
    recovery: { nextAction: "reconcile_current_step" },
  };
}

function plannedStep(
  ordinal: 2 | 3,
  kind: "github_create_file" | "github_create_pull_request",
) {
  return {
    id: `step-${ordinal}`,
    ordinal,
    kind,
    commandId: `command-${ordinal}`,
    commandSha256: "sha256:" + String(ordinal + 1).repeat(64),
    providerIdempotencyKey: `provider-step-${ordinal}`,
    authorityFence: input.authorityFence,
    state: "planned" as const,
    reservedAt: null,
    settledAt: null,
    providerReceiptRef: null,
    beforeSha256: null,
    afterSha256: null,
    verificationSha256: null,
    errorCode: null,
    retry: "none" as const,
    compensation: {
      disposition: "conditionally_reversible" as const,
      kind: null,
      commandSha256: null,
      state: "not_started" as const,
      providerReceiptRef: null,
    },
  };
}

function succeededWorkflow(current: OperationWorkflow): OperationWorkflow {
  return {
    ...current,
    revision: current.revision + 1,
    state: "succeeded",
    steps: current.steps.map((step) => ({
      ...step,
      state: "verified" as const,
      retry: "none" as const,
    })),
    updatedAt: "2026-08-10T00:00:01.000Z",
    terminalAt: "2026-08-10T00:00:01.000Z",
    recovery: { nextAction: "none" },
  };
}

function branchResult(name: string, commitSha: string): GitHubBranchResult {
  return {
    kind: "branch",
    name,
    ref: `refs/heads/${name}`,
    commitSha,
    canonicalUrl: `https://github.com/${repository}/tree/${encodeURIComponent(name)}`,
    sourceRevision: commitSha,
  };
}
